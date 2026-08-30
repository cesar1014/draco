import { logger, reason } from "./log.js";
import { randomUUID } from "node:crypto";
import {
  RateLimiter,
  clientAddress,
  isId,
  sanitizeCandidate,
  sanitizeChannelName,
  sanitizeDescription,
  sanitizeGuildName,
  sanitizeMessage,
  sanitizeReason,
  sanitizeRoleName,
  sanitizeUsername,
  validAdultAge,
} from "./security.js";
import { GUILD_PERMISSIONS, sanitizePermissions } from "./permissions.js";
import { createSession, newTracks, renegotiate, sfuConfig } from "./sfu.js";
import {
  acceptInvite,
  acceptGuestInvite,
  addGuest,
  addMember,
  addMessage,
  assignRole,
  banMember,
  createChannel,
  createGuild,
  createInvite,
  createRole,
  deleteChannel,
  deleteRole,
  findChannel,
  getMember,
  getMemberById,
  guildRoster,
  guildsOf,
  hasGuildPermission,
  isGuildMember,
  isGuildOwner,
  leaveGuild,
  listBans,
  listInvites,
  loadHistory,
  memberRolesOf,
  peersInVoiceChannel,
  removeMember,
  revokeInvite,
  rolesOf,
  setSfuSession,
  setSfuTracks,
  setVoiceChannel,
  setVoiceState,
  snapshot,
  unban,
  updateRole,
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
 * Antes da entrada o limite é por endereço, e uma casa inteira sai pelo mesmo IP:
 * quatro pessoas recarregando a página não podem esbarrar no teto.
 */
const LIMITS = {
  identify: { burst: 12, perSec: 1 },
  chat: { burst: 5, perSec: 2 },
  history: { burst: 6, perSec: 2 },
  voiceJoin: { burst: 6, perSec: 1 },
  voiceState: { burst: 30, perSec: 12 },
  signal: { burst: 400, perSec: 200 },
  sfu: { burst: 40, perSec: 10 },
  /**
   * Ações administrativas. A rajada é generosa porque montar um servidor é uma
   * sequência: criar, dois ou três canais, um convite, abrir o painel. Quem
   * segura o abuso é a reposição lenta — meia ação por segundo não deixa ninguém
   * criar mil servidores, e cada uma delas escreve no banco.
   */
  admin: { burst: 15, perSec: 0.5 },
  // Aceitar convite é apertado por outro motivo: tentar códigos até acertar um
  // é o único caminho pra entrar num servidor sem ser convidado.
  invite: { burst: 5, perSec: 0.1 },
};

/** Trilhas que uma pessoa pode publicar. Espelha `SLOT_ORDER` no cliente. */
const SLOTS = ["mic", "camera", "screen", "screenAudio"];

const log = logger("SIGNAL");
const sfuLog = logger("SFU");

const voiceRoom = (channelId) => `voice:${channelId}`;
/**
 * Uma sala de socket por servidor. É o que faz um servidor criado por alguém ser
 * privado de fato: canal novo, convite e banimento só chegam a quem é membro, em
 * vez de vazarem pra todo mundo conectado.
 */
const guildRoom = (guildId) => `guild:${guildId}`;
const directRoom = (threadId) => `direct:${threadId}`;

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
    guest: member.guest === true,
    guestGuildId: member.guest ? member.guestGuildId : null,
    // Com SFU, é assim que os outros sabem o que existe pra assinar.
    sfuSessionId: member.sfuSessionId,
    sfuTracks: member.sfuTracks ?? {},
  };
}

export function attachSignaling(io, env = process.env, { auth, accountService } = {}) {
  if (!auth || !accountService) {
    throw new Error("attachSignaling precisa das autoridades de sessão e conta");
  }

  const limiter = new RateLimiter();
  const trustProxy = env.TRUSTED_PROXY === "1";
  const sfu = sfuConfig(env);
  const accounts = accountService.repository;
  const guestSessions = new Map();

  io.on("connection", (socket) => {
    /** Enquanto não passar pelo `identify`, o socket não existe pro resto do app. */
    let identified = false;
    let userId = null;
    let guest = false;
    let guestGuildId = null;
    let systemAdmin = false;
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

    const currentGuilds = () =>
      guestGuildId
        ? guildsOf(userId, { systemAdmin: true }).filter((guild) => guild.id === guestGuildId)
        : guildsOf(userId, { systemAdmin });

    const hasAccess = (guildId) =>
      systemAdmin || guestGuildId === guildId || isGuildMember(guildId, userId);

    const can = (guildId, permission) =>
      systemAdmin ||
      (guest
        ? guestGuildId === guildId && ["view_channels", "connect", "speak"].includes(permission)
        : hasGuildPermission(guildId, userId, permission));

    function presenceTarget(member, fromSocket = false) {
      const guildIds = member.guest
        ? [member.guestGuildId]
        : guildsOf(member.id).map((guild) => guild.id);
      const voiceGuildId = member.voiceChannelId ? findChannel(member.voiceChannelId)?.guildId : null;
      if (voiceGuildId && !guildIds.includes(voiceGuildId)) guildIds.push(voiceGuildId);
      let target = fromSocket ? socket.to(guildRoom(guildIds[0] ?? "none")) : io.to(guildRoom(guildIds[0] ?? "none"));
      for (const guildId of guildIds.slice(1)) target = target.to(guildRoom(guildId));
      return { target, hasRooms: guildIds.length > 0 };
    }

    function emitPresence(event, member, { excludeSelf = false } = {}) {
      if (!member) return;
      const { target, hasRooms } = presenceTarget(member, excludeSelf);
      if (hasRooms) target.emit(event, event === "member:left" ? { id: member.id } : publicMember(member));
    }

    /** Tira a pessoa do canal de voz atual e avisa quem ficou. */
    function leaveVoice() {
      const member = getMember(socket.id);
      if (!member?.voiceChannelId) return;
      const channelId = member.voiceChannelId;
      socket.leave(voiceRoom(channelId));
      setVoiceChannel(member.id, null);
      io.to(voiceRoom(channelId)).emit("voice:peer-left", { channelId, memberId: member.id });
      emitPresence("member:state", getMemberById(member.id));
    }

    /**
     * O canal existe, é do tipo certo e pertence a um servidor de que esta pessoa
     * é membro. A última parte é a que importa: sem ela, conhecer o id de um canal
     * bastaria pra ler e escrever num servidor privado.
     */
    function visibleChannel(channelId, type) {
      const channel = findChannel(channelId);
      if (!channel || channel.type !== type) return null;
      return hasAccess(channel.guildId) && can(channel.guildId, "view_channels") ? channel : null;
    }

    /** Entra nas salas dos servidores de que a pessoa é membro. */
    function joinGuildRooms() {
      for (const guild of currentGuilds()) socket.join(guildRoom(guild.id));
      if (!guest) {
        for (const thread of accounts.listThreads(userId)) socket.join(directRoom(thread.id));
      }
    }

    /**
     * Guarda das ações administrativas: identificada, dentro do limite, membro do
     * servidor e — quando a ação exige — dona dele. Todo servidor tem dono, porque
     * todo servidor nasce de alguém criando: não há catálogo padrão de que ninguém
     * responda.
     */
    function guildAction(reply, guildId, { permission = null } = {}) {
      if (!identified || guest) {
        reply({ ok: false, error: "not-identified" });
        return false;
      }
      if (!allow("admin")) {
        reply({ ok: false, error: "rate-limited" });
        return false;
      }
      if (!isId(guildId) || !hasAccess(guildId)) {
        reply({ ok: false, error: "not-member" });
        return false;
      }
      if (permission && !can(guildId, permission)) {
        reply({ ok: false, error: "missing-permission" });
        return false;
      }
      return true;
    }

    socket.on("identify", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (identified) return reply({ ok: false, error: "already-identified" });
      if (!allow("identify")) return reply({ ok: false, error: "rate-limited" });
      const guestName = sanitizeUsername(payload?.guest?.username);
      const inviteCode =
        typeof payload?.guest?.inviteCode === "string"
          ? payload.guest.inviteCode.trim().toUpperCase()
          : null;
      const reconnectGuest = typeof payload?.guest?.token === "string"
        ? guestSessions.get(payload.guest.token)
        : null;
      let member;
      let previousSocketId = null;
      let renewed = null;
      let account = null;

      let guestToken = null;
      if (reconnectGuest && reconnectGuest.expiresAt > Date.now()) {
        identified = true;
        guest = true;
        guestGuildId = reconnectGuest.guildId;
        guestToken = payload.guest.token;
        ({ member } = addGuest(socket.id, reconnectGuest.username, reconnectGuest.guildId, reconnectGuest.userId));
        userId = member.id;
      } else if (payload?.guest) {
        if (!validAdultAge(payload.guest.age)) {
          return reply({ ok: false, error: "adult-required" });
        }
        if (!guestName || !inviteCode) return reply({ ok: false, error: "bad-request" });
        if (!allow("invite")) return reply({ ok: false, error: "rate-limited" });
        const invite = acceptGuestInvite(inviteCode);
        if (!invite.ok) return reply(invite);
        identified = true;
        guest = true;
        guestGuildId = invite.guildId;
        ({ member } = addGuest(socket.id, guestName, invite.guildId));
        userId = member.id;
        guestToken = randomUUID();
        guestSessions.set(guestToken, {
          userId,
          username: member.username,
          guildId: invite.guildId,
          expiresAt: Date.now() + 60 * 60 * 1000,
        });
      } else {
        const authenticated = accountService.session(payload?.token, address);
        if (!authenticated) return reply({ ok: false, error: "not-authenticated" });
        account = authenticated.account;
        identified = true;
        userId = account.userId;
        systemAdmin = account.isSystemAdmin;
        renewed = auth.renewIfNeeded(authenticated);
        ({ member, previousSocketId } = addMember(socket.id, userId, account.username, {
          systemAdmin,
        }));
      }

      // Duas abas com o mesmo id disputariam o mesmo membro; a mais nova fica.
      if (previousSocketId && previousSocketId !== socket.id) {
        io.sockets.sockets.get(previousSocketId)?.disconnect(true);
      }

      log.info("identificado", { userId: member.id, visitante: guest, administrador: systemAdmin });
      joinGuildRooms();
      const state = snapshot(member.id, { systemAdmin, guestGuildId });
      if (!guest) {
        state.directThreads = accounts.listThreads(userId);
        state.directMessages = {};
      }
      reply({
        ok: true,
        selfId: member.id,
        ...(renewed ? { token: renewed.token } : {}),
        ...(guestToken ? { guestToken } : {}),
        account: guest
          ? { id: member.id, username: member.username, email: null, isSystemAdmin: false, guest: true }
          : { ...accountService.publicAccount(account), guest: false },
        sfu: Boolean(sfu),
        state,
      });
      emitPresence("member:joined", member, { excludeSelf: true });
    });

    socket.on("chat:send", (payload) => {
      if (!identified || guest || !allow("chat")) return;
      const member = getMember(socket.id);
      const channel = visibleChannel(payload?.channelId, "text");
      if (!member || !channel || !can(channel.guildId, "send_messages")) return;
      const content = sanitizeMessage(payload?.content);
      if (!content) return;
      // Só quem é do servidor: mandar pra todo mundo conectado vazaria a conversa
      // de um servidor privado pra quem não faz parte dele.
      io.to(guildRoom(channel.guildId)).emit("chat:message", addMessage(channel.id, member, content));
    });

    /**
     * Conversa mais antiga, pedida quando a pessoa rola até o topo do que já
     * recebeu. O limite é baixo porque cada pedido é uma consulta ao banco, e uma
     * roda de mouse presa mandaria dezenas por segundo.
     */
    socket.on("chat:history", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || !allow("history")) return reply({ ok: false, error: "rate-limited" });
      const channel = visibleChannel(payload?.channelId, "text");
      if (!channel) return reply({ ok: false, error: "no-channel" });
      if (!isId(payload?.beforeId)) return reply({ ok: false, error: "bad-request" });

      const page = loadHistory(channel.id, payload.beforeId);
      if (!page) return reply({ ok: false, error: "no-message" });
      reply({ ok: true, channelId: channel.id, messages: page.messages, more: page.more });
    });

    socket.on("voice:join", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || !allow("voiceJoin")) return reply({ ok: false, error: "rate-limited" });
      const channel = visibleChannel(payload?.channelId, "voice");
      if (!channel || !can(channel.guildId, "connect")) {
        return reply({ ok: false, error: "no-channel" });
      }

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
      emitPresence("member:state", member);
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
      emitPresence("member:state", member);
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
        emitPresence("member:state", getMemberById(member.id));
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
        if (updated) emitPresence("member:state", updated);
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

    // --- servidores, canais, convites e banimentos ---------------------------
    // Escrevem no banco e mudam o que as pessoas veem, então cada handler confere
    // associação e propriedade antes de tocar em qualquer coisa.

    socket.on("guild:create", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-identified" });
      if (!allow("admin")) return reply({ ok: false, error: "rate-limited" });

      const name = sanitizeGuildName(payload?.name);
      if (!name) return reply({ ok: false, error: "bad-name" });

      const guild = createGuild(userId, name);
      if (!guild) return reply({ ok: false, error: "create-failed" });
      socket.join(guildRoom(guild.id));
      log.info("servidor criado", { guildId: guild.id, ownerId: userId });
      reply({ ok: true, guild, state: snapshot(userId, { systemAdmin }) });
    });

    socket.on("guild:leave", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-identified" });
      if (!allow("admin")) return reply({ ok: false, error: "rate-limited" });
      const guildId = payload?.guildId;
      if (!isId(guildId)) return reply({ ok: false, error: "bad-request" });

      const result = leaveGuild(guildId, userId);
      if (!result.ok) return reply(result);

      // Estava numa call deste servidor: sair do servidor tira da call também.
      const member = getMember(socket.id);
      const current = member?.voiceChannelId ? findChannel(member.voiceChannelId) : null;
      if (current?.guildId === guildId) leaveVoice();

      socket.leave(guildRoom(guildId));
      io.to(guildRoom(guildId)).emit("guild:member-left", { guildId, userId });
      reply({ ok: true, state: snapshot(userId, { systemAdmin }) });
    });

    socket.on("channel:create", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_channels" })) return;

      const type = payload?.type === "voice" ? "voice" : "text";
      const name = sanitizeChannelName(payload?.name, type);
      if (!name) return reply({ ok: false, error: "bad-name" });

      const channel = createChannel(guildId, type, name);
      if (!channel) return reply({ ok: false, error: "create-failed" });
      io.to(guildRoom(guildId)).emit("channel:created", { channel });
      reply({ ok: true, channel });
    });

    socket.on("channel:delete", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const channel = findChannel(payload?.channelId);
      if (!channel) return reply({ ok: false, error: "no-channel" });
      if (!guildAction(reply, channel.guildId, { permission: "manage_channels" })) return;

      const result = deleteChannel(channel.id);
      if (!result.ok) return reply(result);

      // Quem estava na call do canal apagado precisa saber, senão o cliente
      // continuaria mostrando uma call que não existe mais.
      io.to(voiceRoom(channel.id)).emit("voice:channel-closed", { channelId: channel.id });
      io.to(guildRoom(channel.guildId)).emit("channel:deleted", {
        guildId: channel.guildId,
        channelId: channel.id,
      });
      reply({ ok: true });
    });

    socket.on("invite:create", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "create_invites" })) return;

      // Limites opcionais, e conferidos: um `maxUses` negativo violaria o CHECK
      // do schema e derrubaria o handler em vez de recusar com jeito.
      const maxUses = Number.isInteger(payload?.maxUses) && payload.maxUses > 0 ? payload.maxUses : null;
      const hours =
        Number.isFinite(payload?.expiresInHours) && payload.expiresInHours > 0
          ? Math.min(payload.expiresInHours, 24 * 30)
          : null;

      const code = createInvite(guildId, userId, { maxUses, expiresInHours: hours });
      reply({ ok: true, code, invites: listInvites(guildId) });
    });

    socket.on("invite:accept", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-identified" });
      if (!allow("invite")) return reply({ ok: false, error: "rate-limited" });

      const code = typeof payload?.code === "string" ? payload.code.trim().toUpperCase() : null;
      if (!code || code.length > 32) return reply({ ok: false, error: "bad-request" });

      const result = acceptInvite(code, userId);
      if (!result.ok) return reply(result);

      socket.join(guildRoom(result.guildId));
      if (result.joined) {
        const member = getMember(socket.id);
        io.to(guildRoom(result.guildId)).emit("guild:member-joined", {
          guildId: result.guildId,
          member: { id: userId, username: member?.username ?? "", color: member?.color ?? "" },
        });
      }
      log.info("convite aceito", { guildId: result.guildId, userId, novo: result.joined });
      reply({ ok: true, guildId: result.guildId, state: snapshot(userId, { systemAdmin }) });
    });

    socket.on("invite:revoke", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "create_invites" })) return;
      if (!isId(payload?.code, 32)) return reply({ ok: false, error: "bad-request" });

      const removed = revokeInvite(guildId, payload.code);
      reply({ ok: removed, invites: listInvites(guildId), ...(removed ? {} : { error: "no-invite" }) });
    });

    socket.on("invite:list", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "create_invites" })) return;
      reply({ ok: true, invites: listInvites(guildId) });
    });

    socket.on("member:ban", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "ban_members" })) return;
      const target = payload?.userId;
      if (!isId(target)) return reply({ ok: false, error: "bad-request" });
      if (target === userId) return reply({ ok: false, error: "cannot-ban-self" });
      if (isGuildOwner(guildId, target) && !systemAdmin) {
        return reply({ ok: false, error: "protected-user" });
      }
      if (accounts.accountById(target)?.isSystemAdmin && !systemAdmin) {
        return reply({ ok: false, error: "protected-user" });
      }
      if (!isGuildMember(guildId, target)) return reply({ ok: false, error: "not-member" });

      const banned = banMember(guildId, target, userId, sanitizeReason(payload?.reason));
      io.to(guildRoom(guildId)).emit("guild:member-left", { guildId, userId: target });

      // A pessoa banida precisa sair da sala do servidor agora: continuar nela
      // significaria continuar recebendo o chat de onde ela não pode mais entrar.
      const socketId = banned?.socketId;
      if (socketId) {
        const targetSocket = io.sockets.sockets.get(socketId);
        targetSocket?.leave(guildRoom(guildId));
        targetSocket?.emit("guild:banned", { guildId });
      }
      log.info("membro banido", { guildId, userId: target, por: userId });
      reply({ ok: true, bans: listBans(guildId) });
    });

    socket.on("member:unban", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "ban_members" })) return;
      if (!isId(payload?.userId)) return reply({ ok: false, error: "bad-request" });

      const removed = unban(guildId, payload.userId);
      reply({ ok: removed, bans: listBans(guildId), ...(removed ? {} : { error: "no-ban" }) });
    });

    socket.on("guild:admin", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId)) return;
      const owner = isGuildOwner(guildId, userId);
      const mayInvite = can(guildId, "create_invites");
      const mayBan = can(guildId, "ban_members");
      const mayManageRoles = can(guildId, "manage_roles");
      const memberRoles = memberRolesOf(guildId);
      reply({
        ok: true,
        owner,
        roster: guildRoster(guildId),
        permissions: systemAdmin || owner
          ? [...GUILD_PERMISSIONS]
          : rolesOf(guildId)
              .filter((role) => (memberRoles[userId] ?? []).includes(role.id))
              .flatMap((role) => role.permissions),
        invites: mayInvite ? listInvites(guildId) : [],
        // Lista de banidos é informação de moderação: só quem pode moderar recebe.
        bans: mayBan ? listBans(guildId) : [],
        roles: mayManageRoles ? rolesOf(guildId) : [],
        memberRoles: mayManageRoles ? memberRoles : {},
        availablePermissions: mayManageRoles ? [...GUILD_PERMISSIONS] : [],
      });
    });

    socket.on("role:create", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_roles" })) return;
      const name = sanitizeRoleName(payload?.name);
      if (!name) return reply({ ok: false, error: "bad-name" });
      const permissions = sanitizePermissions(payload?.permissions);
      const color = typeof payload?.color === "string" && /^#[0-9a-f]{6}$/i.test(payload.color)
        ? payload.color.toUpperCase()
        : null;
      const role = createRole(guildId, name, color, permissions);
      io.to(guildRoom(guildId)).emit("role:changed", { guildId });
      reply({ ok: true, role, roles: rolesOf(guildId) });
    });

    socket.on("role:update", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_roles" })) return;
      if (!isId(payload?.roleId)) return reply({ ok: false, error: "bad-request" });
      const name = sanitizeRoleName(payload?.name);
      if (!name) return reply({ ok: false, error: "bad-name" });
      const permissions = sanitizePermissions(payload?.permissions);
      const color = typeof payload?.color === "string" && /^#[0-9a-f]{6}$/i.test(payload.color)
        ? payload.color.toUpperCase()
        : null;
      const role = updateRole(guildId, payload.roleId, name, color, permissions);
      if (!role) return reply({ ok: false, error: "role-protected" });
      io.to(guildRoom(guildId)).emit("role:changed", { guildId });
      reply({ ok: true, role, roles: rolesOf(guildId) });
    });

    socket.on("role:delete", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_roles" })) return;
      if (!isId(payload?.roleId)) return reply({ ok: false, error: "bad-request" });
      const removed = deleteRole(guildId, payload.roleId);
      if (!removed) return reply({ ok: false, error: "role-protected" });
      io.to(guildRoom(guildId)).emit("role:changed", { guildId });
      reply({ ok: true, roles: rolesOf(guildId), memberRoles: memberRolesOf(guildId) });
    });

    socket.on("role:assign", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_roles" })) return;
      if (!isId(payload?.roleId) || !isId(payload?.userId) || !isGuildMember(guildId, payload.userId)) {
        return reply({ ok: false, error: "bad-request" });
      }
      const changed = assignRole(guildId, payload.userId, payload.roleId, payload.assigned === true);
      if (!changed) return reply({ ok: false, error: "role-protected" });
      io.to(guildRoom(guildId)).emit("role:changed", { guildId });
      reply({ ok: true, memberRoles: memberRolesOf(guildId) });
    });

    socket.on("direct:open", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("admin")) return reply({ ok: false, error: "rate-limited" });
      const targetId = payload?.userId;
      if (!isId(targetId) || !accounts.accountById(targetId)) {
        return reply({ ok: false, error: "no-user" });
      }
      if (!accounts.sharesGuild(userId, targetId)) {
        return reply({ ok: false, error: "not-shared-server" });
      }
      const threadId = accounts.createOrFindThread(userId, targetId);
      socket.join(directRoom(threadId));
      const targetSocketId = getMemberById(targetId)?.socketId;
      if (targetSocketId) io.sockets.sockets.get(targetSocketId)?.join(directRoom(threadId));
      for (const participantId of new Set([userId, targetId])) {
        const thread = accounts.listThreads(participantId).find((item) => item.id === threadId);
        const participantSocket = getMemberById(participantId)?.socketId;
        if (thread && participantSocket) io.to(participantSocket).emit("direct:thread", thread);
      }
      reply({
        ok: true,
        thread: accounts.listThreads(userId).find((item) => item.id === threadId),
        messages: accounts.listDirectMessages(threadId),
      });
    });

    socket.on("direct:history", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !allow("history")) {
        return reply({ ok: false, error: "not-authenticated" });
      }
      if (!isId(payload?.threadId) || !accounts.isParticipant(payload.threadId, userId)) {
        return reply({ ok: false, error: "no-thread" });
      }
      reply({ ok: true, messages: accounts.listDirectMessages(payload.threadId) });
    });

    socket.on("direct:send", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !allow("chat")) {
        return reply({ ok: false, error: "not-authenticated" });
      }
      const threadId = payload?.threadId;
      if (!isId(threadId) || !accounts.isParticipant(threadId, userId)) {
        return reply({ ok: false, error: "no-thread" });
      }
      const content = sanitizeMessage(payload?.content);
      if (!content) return reply({ ok: false, error: "bad-message" });
      const message = accounts.addDirectMessage(threadId, userId, content);
      io.to(directRoom(threadId)).emit("direct:message", message);
      reply({ ok: true, message });
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
      emitPresence("member:left", member);
    });
  });
}
