import { logger, reason } from "./log.js";
import {
  RateLimiter,
  clientAddress,
  isId,
  passwordMatches,
  sanitizeCandidate,
  sanitizeDescription,
  sanitizeMessage,
  sanitizeUsername,
} from "./security.js";
import { createSession, newTracks, renegotiate, sfuConfig } from "./sfu.js";
import {
  addMember,
  addMessage,
  findChannel,
  getMember,
  getMemberById,
  loadHistory,
  peersInVoiceChannel,
  removeMember,
  setSfuSession,
  setSfuTracks,
  setVoiceChannel,
  setVoiceState,
  snapshot,
} from "./state.js";

/**
 * Em malha o servidor não toca em mídia: ela vai direto de navegador pra
 * navegador e aqui só passam a apresentação inicial (SDP), os caminhos de rede
 * (ICE), o chat e quem está em qual canal.
 *
 * Com o SFU configurado a mídia passa pela Cloudflare, mas o segredo do app não
 * sai daqui: o navegador manda o SDP por este socket, este processo assina a
 * chamada, e a resposta volta pelo mesmo caminho. Os eventos `sfu:*` são esse
 * vai e vem.
 *
 * Limites por evento. Sinalização é naturalmente em rajada, porque o ICE trickle
 * despeja dezenas de candidatos em sequência pra cada peer, então o teto dela
 * é alto de propósito, enquanto o do chat é baixo.
 *
 * `identify` é generoso e `identifyFailed` é apertado, e a diferença é o ponto:
 * antes da entrada o limite é por endereço, e uma casa inteira sai pelo mesmo IP —
 * quatro pessoas recarregando a página não podem esbarrar no teto. Quem precisa
 * ser cortado é quem erra a senha repetidamente, e é esse balde que quase não
 * repõe.
 */
const LIMITS = {
  identify: { burst: 12, perSec: 1 },
  identifyFailed: { burst: 5, perSec: 0.1 },
  chat: { burst: 5, perSec: 2 },
  history: { burst: 6, perSec: 2 },
  voiceJoin: { burst: 6, perSec: 1 },
  voiceState: { burst: 30, perSec: 12 },
  signal: { burst: 400, perSec: 200 },
  sfu: { burst: 40, perSec: 10 },
};

/** Trilhas que uma pessoa pode publicar. Espelha `SLOT_ORDER` no cliente. */
const SLOTS = ["mic", "camera", "screen", "screenAudio"];

const log = logger("SIGNAL");
const sfuLog = logger("SFU");

const voiceRoom = (channelId) => `voice:${channelId}`;

/** Só o que o outro lado precisa saber, sem vazar detalhe interno. */
function publicMember(member) {
  return {
    id: member.id,
    username: member.username,
    color: member.color,
    voiceChannelId: member.voiceChannelId,
    muted: member.muted,
    deafened: member.deafened,
    camOn: member.camOn,
    screenOn: member.screenOn,
    speaking: member.speaking,
    since: member.since,
    // Com SFU, é assim que os outros sabem o que existe pra assinar.
    sfuSessionId: member.sfuSessionId,
    sfuTracks: member.sfuTracks ?? {},
  };
}

export function attachSignaling(io, env = process.env, { auth } = {}) {
  if (!auth) throw new Error("attachSignaling precisa da autoridade de sessão");

  const limiter = new RateLimiter();
  const roomPassword = env.ROOM_PASSWORD ?? "";
  const trustProxy = env.TRUSTED_PROXY === "1";
  const sfu = sfuConfig(env);

  io.on("connection", (socket) => {
    /** Enquanto não passar pelo `identify`, o socket não existe pro resto do app. */
    let identified = false;
    let userId = null;
    const address = clientAddress(socket, trustProxy);

    /**
     * Antes da identificação o limite é por endereço, depois é pela identidade.
     * Nenhum dos dois muda quando o socket cai e volta, que é o que fazia
     * reconectar zerar as proteções.
     */
    const allow = (action) => {
      const scope = userId ? `user:${userId}` : `ip:${address}`;
      const limit = LIMITS[action];
      return limiter.allow(`${scope}:${action}`, limit.burst, limit.perSec);
    };

    /** Tira a pessoa do canal de voz atual e avisa quem ficou. */
    function leaveVoice() {
      const member = getMember(socket.id);
      if (!member?.voiceChannelId) return;
      const channelId = member.voiceChannelId;
      socket.leave(voiceRoom(channelId));
      setVoiceChannel(member.id, null);
      io.to(voiceRoom(channelId)).emit("voice:peer-left", { channelId, memberId: member.id });
      io.emit("member:state", publicMember(getMemberById(member.id)));
    }

    socket.on("identify", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (identified) return reply({ ok: false, error: "already-identified" });
      if (!allow("identify")) return reply({ ok: false, error: "rate-limited" });
      /**
       * Toda tentativa gasta do balde apertado, e um acerto devolve o token. O
       * efeito é que entrar normalmente não custa nada e errar a senha custa: sem
       * isso, adivinhar a senha da sala bastaria reconectar entre as tentativas.
       */
      if (!allow("identifyFailed")) return reply({ ok: false, error: "rate-limited" });
      const failedKey = `ip:${address}:identifyFailed`;

      if (!passwordMatches(roomPassword, payload?.password ?? "")) {
        return reply({ ok: false, error: "bad-password" });
      }
      const username = sanitizeUsername(payload?.username);
      if (!username) return reply({ ok: false, error: "bad-username" });

      /**
       * Reassumir a mesma identidade é o que faz uma queda de Wi-Fi não virar
       * "outra pessoa entrou". Mas quem decide de quem é a identidade é este
       * servidor: antes bastava mandar o `userId` de outra pessoa pra entrar como
       * ela. Agora é preciso apresentar o token que só saiu daqui, assinado.
       */
      const session = auth.verify(payload?.token);
      const issued = session ? auth.renewIfNeeded(session) : auth.issue();
      const identity = session?.userId ?? issued.userId;

      identified = true;
      userId = identity;
      const { member, previousSocketId } = addMember(socket.id, identity, username);
      // Entrada legítima devolve o token gasto: quem acerta a senha nunca esbarra
      // no limite, e quem erra vai ficando sem tentativas.
      limiter.refund(failedKey, LIMITS.identifyFailed.burst);

      // Duas abas com o mesmo id disputariam o mesmo membro; a mais nova fica.
      if (previousSocketId && previousSocketId !== socket.id) {
        io.sockets.sockets.get(previousSocketId)?.disconnect(true);
      }

      log.info("identificado", { userId: member.id, retomada: Boolean(session) });
      reply({
        ok: true,
        selfId: member.id,
        // Só quando muda: um token válido e longe do vencimento continua servindo,
        // e reescrevê-lo no cliente a cada reconexão seria gravação sem motivo.
        ...(issued ? { token: issued.token } : {}),
        sfu: Boolean(sfu),
        state: snapshot(),
      });
      socket.broadcast.emit("member:joined", publicMember(member));
    });

    socket.on("chat:send", (payload) => {
      if (!identified || !allow("chat")) return;
      const member = getMember(socket.id);
      const channel = findChannel(payload?.channelId);
      if (!member || channel?.type !== "text") return;
      const content = sanitizeMessage(payload?.content);
      if (!content) return;
      io.emit("chat:message", addMessage(channel.id, member, content));
    });

    /**
     * Conversa mais antiga, pedida quando a pessoa rola até o topo do que já
     * recebeu. O limite é baixo porque cada pedido é uma consulta ao banco, e uma
     * roda de mouse presa mandaria dezenas por segundo.
     */
    socket.on("chat:history", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || !allow("history")) return reply({ ok: false, error: "rate-limited" });
      const channel = findChannel(payload?.channelId);
      if (channel?.type !== "text") return reply({ ok: false, error: "no-channel" });
      if (!isId(payload?.beforeId)) return reply({ ok: false, error: "bad-request" });

      const page = loadHistory(channel.id, payload.beforeId);
      if (!page) return reply({ ok: false, error: "no-message" });
      reply({ ok: true, channelId: channel.id, messages: page.messages, more: page.more });
    });

    socket.on("voice:join", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || !allow("voiceJoin")) return reply({ ok: false, error: "rate-limited" });
      const channel = findChannel(payload?.channelId);
      if (channel?.type !== "voice") return reply({ ok: false, error: "no-channel" });

      leaveVoice();

      // A lista vai na resposta, e não num evento solto, pra o recém-chegado já
      // conhecer todo mundo antes de os outros serem avisados dele. Se fosse por
      // evento, dava pra receber uma oferta de alguém que ainda não está no mapa.
      const peers = peersInVoiceChannel(channel.id, userId).map(publicMember);
      setVoiceChannel(userId, channel.id);
      socket.join(voiceRoom(channel.id));

      const member = getMember(socket.id);
      reply({ ok: true, channelId: channel.id, peers, sfu: Boolean(sfu) });
      socket.to(voiceRoom(channel.id)).emit("voice:peer-joined", {
        channelId: channel.id,
        member: publicMember(member),
      });
      io.emit("member:state", publicMember(member));
    });

    socket.on("voice:leave", () => {
      if (!identified) return;
      leaveVoice();
    });

    socket.on("voice:state", (payload) => {
      if (!identified || !allow("voiceState")) return;
      const member = setVoiceState(userId, payload);
      if (!member) return;
      // Vai pra todos, não só pra quem está na call: a lista de canais mostra o
      // ícone de mudo de quem está em voz mesmo pra quem está lendo o chat.
      io.emit("member:state", publicMember(member));
    });

    socket.on("rtc:signal", (payload) => {
      if (!identified || !allow("signal")) return;
      const sender = getMember(socket.id);
      const target = getMemberById(payload?.to);
      // A checagem que importa: sem ela, este servidor seria um relay aberto pra
      // mandar pacote arbitrário a qualquer socket conectado.
      if (!sender?.voiceChannelId || target?.voiceChannelId !== sender.voiceChannelId) return;

      // Só os campos conhecidos seguem adiante, e recortados: o que chega aqui vem
      // de um cliente, e repassar o objeto inteiro deixaria ele escolher o que o
      // navegador do outro vai receber.
      const description = sanitizeDescription(payload?.description);
      const candidate =
        payload?.candidate === undefined ? undefined : sanitizeCandidate(payload.candidate);
      const requestOffer = payload?.requestOffer === true;
      if (!description && candidate === undefined && !requestOffer) return;

      io.to(target.socketId).emit("rtc:signal", {
        from: sender.id,
        ...(description ? { description } : {}),
        ...(candidate !== undefined ? { candidate } : {}),
        ...(requestOffer ? { requestOffer: true } : {}),
      });
    });

    // --- SFU ---------------------------------------------------------------
    // Só existe quando há credenciais. Sem elas, cada handler recusa e o cliente
    // segue em malha direta, que é o comportamento de sempre.

    /** Guarda comum: identificado, dentro de uma call e com SFU disponível. */
    function sfuMember(reply) {
      if (!sfu) {
        reply({ ok: false, error: "no-sfu" });
        return null;
      }
      if (!identified || !allow("sfu")) {
        reply({ ok: false, error: "rate-limited" });
        return null;
      }
      const member = getMember(socket.id);
      if (!member?.voiceChannelId) {
        reply({ ok: false, error: "not-in-voice" });
        return null;
      }
      return member;
    }

    socket.on("sfu:join", async (_payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const member = sfuMember(reply);
      if (!member) return;
      try {
        // Duas sessões: uma só pra enviar, outra só pra receber. Separar é o que
        // impede que alguém entrando na call force uma renegociação na conexão
        // que está carregando a sua câmera.
        const [send, recv] = await Promise.all([createSession(sfu), createSession(sfu)]);
        if (!send.sessionId || !recv.sessionId) throw new Error("sessão sem id");
        // Reconferir depois do await: a pessoa pode ter saído da call nesse meio.
        if (getMember(socket.id)?.voiceChannelId !== member.voiceChannelId) {
          return reply({ ok: false, error: "not-in-voice" });
        }
        setSfuSession(member.id, { sendSessionId: send.sessionId, recvSessionId: recv.sessionId });
        io.emit("member:state", publicMember(getMemberById(member.id)));
        reply({ ok: true });
      } catch (error) {
        sfuLog.error("falha ao criar sessão", { userId: member.id, motivo: reason(error) });
        reply({ ok: false, error: "sfu-failed" });
      }
    });

    /**
     * Sobe as trilhas locais. O cliente manda a própria oferta e a lista de
     * `mid` → nome; a resposta da Cloudflare volta como resposta deste ack, e o
     * que ficou publicado é anunciado pra call inteira.
     */
    socket.on("sfu:publish", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const member = sfuMember(reply);
      if (!member) return;
      if (!member.sfuSessionId) return reply({ ok: false, error: "no-session" });

      const sessionDescription = sanitizeDescription(payload?.description);
      const entries = (Array.isArray(payload?.tracks) ? payload.tracks : [])
        .filter((track) => isId(track?.mid, 16) && SLOTS.includes(track?.slot))
        .slice(0, SLOTS.length);
      const tracks = entries.map((track) => ({
        location: "local",
        mid: track.mid,
        trackName: `${member.id}-${track.slot}`,
      }));
      if (!sessionDescription || tracks.length === 0) return reply({ ok: false, error: "bad-request" });

      // Guardado antes do await: uma reconexão no meio troca a sessão, e anunciar
      // as trilhas na sessão nova faria os outros assinarem o que não existe lá.
      const publishedIn = member.sfuSessionId;
      try {
        const result = await newTracks(sfu, publishedIn, { sessionDescription, tracks });
        const current = getMemberById(member.id);
        if (current?.sfuSessionId !== publishedIn) {
          return reply({ ok: false, error: "stale-session" });
        }
        const published = Object.fromEntries(
          entries.map((track) => [track.slot, `${member.id}-${track.slot}`]),
        );
        const updated = setSfuTracks(member.id, published);
        if (updated) io.emit("member:state", publicMember(updated));
        sfuLog.debug("trilhas publicadas", {
          userId: member.id,
          slots: entries.map((track) => track.slot),
        });
        reply({ ok: true, description: result.sessionDescription ?? null });
      } catch (error) {
        sfuLog.error("falha ao publicar trilhas", { userId: member.id, motivo: reason(error) });
        reply({ ok: false, error: "sfu-failed" });
      }
    });

    /**
     * Assina as trilhas de outra pessoa. A Cloudflare responde com uma oferta,
     * que o cliente aplica e devolve por `sfu:renegotiate`.
     */
    socket.on("sfu:subscribe", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const member = sfuMember(reply);
      if (!member) return;
      if (!member.sfuRecvSessionId) return reply({ ok: false, error: "no-session" });

      const wanted = (Array.isArray(payload?.tracks) ? payload.tracks : []).slice(0, 64);
      const tracks = [];
      for (const entry of wanted) {
        // Só trilha de quem está na mesma call: sem isso daria pra assinar a
        // câmera de alguém em outro canal só sabendo o id.
        const owner = getMemberById(entry?.memberId);
        if (!owner || owner.voiceChannelId !== member.voiceChannelId) continue;
        if (!owner.sfuSessionId || !SLOTS.includes(entry?.slot)) continue;
        // A sessão que o cliente pediu tem que ser a que está no ar. Uma
        // reconexão do dono cria outra, e assinar a antiga devolveria uma trilha
        // que o SFU já descartou, e daí som e imagem que nunca chegam.
        if (entry.sessionId !== owner.sfuSessionId) continue;
        const trackName = owner.sfuTracks?.[entry.slot];
        if (!trackName) continue;
        tracks.push({ location: "remote", sessionId: owner.sfuSessionId, trackName });
      }
      if (tracks.length === 0) return reply({ ok: false, error: "no-tracks" });

      try {
        const result = await newTracks(sfu, member.sfuRecvSessionId, { tracks });
        reply({
          ok: true,
          description: result.sessionDescription ?? null,
          requiresImmediateRenegotiation: result.requiresImmediateRenegotiation === true,
          tracks: (result.tracks ?? []).map((track) => ({
            mid: track.mid ?? null,
            trackName: track.trackName ?? null,
          })),
        });
      } catch (error) {
        sfuLog.error("falha ao assinar trilhas", { userId: member.id, motivo: reason(error) });
        reply({ ok: false, error: "sfu-failed" });
      }
    });

    /**
     * Resposta do navegador à oferta que a Cloudflare mandou na assinatura, e
     * também o caminho do reinício de ICE. `role` existe por isso: um ICE novo na
     * conexão de envio precisa chegar à sessão de envio, e mandá-lo pra de
     * recepção deixaria a transmissão morta com o servidor achando que reconectou.
     */
    socket.on("sfu:renegotiate", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const member = sfuMember(reply);
      if (!member) return;

      const role = payload?.role === "send" ? "send" : "recv";
      const sessionId = role === "send" ? member.sfuSessionId : member.sfuRecvSessionId;
      if (!sessionId) return reply({ ok: false, error: "no-session" });

      const description = sanitizeDescription(payload?.description);
      if (!description) return reply({ ok: false, error: "bad-request" });
      try {
        await renegotiate(sfu, sessionId, description);
        reply({ ok: true });
      } catch (error) {
        sfuLog.error("falha ao renegociar", {
          userId: member.id,
          role,
          motivo: reason(error),
        });
        reply({ ok: false, error: "sfu-failed" });
      }
    });

    socket.on("disconnect", () => {
      if (!identified) return;
      // Só se este socket ainda é o dono: uma reconexão que chegou primeiro já
      // assumiu a identidade, e derrubar o membro aqui apagaria a pessoa da
      // lista de todo mundo no instante seguinte ao seu retorno.
      const member = getMember(socket.id);
      if (member?.socketId !== socket.id) return;
      leaveVoice();
      removeMember(socket.id);
      io.emit("member:left", { id: member.id });
    });
  });
}
