import { RateLimiter, passwordMatches, sanitizeMessage, sanitizeUsername } from "./security.js";
import {
  addMember,
  addMessage,
  findChannel,
  getMember,
  peersInVoiceChannel,
  removeMember,
  setVoiceChannel,
  setVoiceState,
  snapshot,
} from "./state.js";

/**
 * O servidor não toca em mídia: ela vai direto de navegador pra navegador. Aqui
 * só passam a apresentação inicial (SDP), os caminhos de rede (ICE), o chat e
 * quem está em qual canal.
 *
 * Limites por evento. Sinalização é naturalmente em rajada — o ICE trickle
 * despeja dezenas de candidatos em sequência pra cada peer — então o teto dela
 * é alto de propósito, enquanto o do chat é baixo.
 */
const LIMITS = {
  identify: { burst: 5, perSec: 0.5 },
  chat: { burst: 5, perSec: 2 },
  voiceJoin: { burst: 6, perSec: 1 },
  voiceState: { burst: 30, perSec: 12 },
  signal: { burst: 400, perSec: 200 },
};

const voiceRoom = (channelId) => `voice:${channelId}`;

/** Só o que o outro lado precisa saber — nada de vazar detalhe interno. */
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
  };
}

export function attachSignaling(io, env = process.env) {
  const limiter = new RateLimiter();
  const roomPassword = env.ROOM_PASSWORD ?? "";

  io.on("connection", (socket) => {
    /** Enquanto não passar pelo `identify`, o socket não existe pro resto do app. */
    let identified = false;

    const allow = (action) => limiter.allow(`${socket.id}:${action}`, LIMITS[action].burst, LIMITS[action].perSec);

    /** Tira o socket do canal de voz atual e avisa quem ficou. */
    function leaveVoice() {
      const member = getMember(socket.id);
      if (!member?.voiceChannelId) return;
      const channelId = member.voiceChannelId;
      socket.leave(voiceRoom(channelId));
      setVoiceChannel(socket.id, null);
      io.to(voiceRoom(channelId)).emit("voice:peer-left", { channelId, memberId: socket.id });
      io.emit("member:state", publicMember(getMember(socket.id)));
    }

    socket.on("identify", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (identified) return reply({ ok: false, error: "already-identified" });
      if (!allow("identify")) return reply({ ok: false, error: "rate-limited" });

      if (!passwordMatches(roomPassword, payload?.password ?? "")) {
        return reply({ ok: false, error: "bad-password" });
      }
      const username = sanitizeUsername(payload?.username);
      if (!username) return reply({ ok: false, error: "bad-username" });

      identified = true;
      const member = addMember(socket.id, username);
      reply({ ok: true, selfId: socket.id, state: snapshot() });
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

    socket.on("voice:join", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || !allow("voiceJoin")) return reply({ ok: false, error: "rate-limited" });
      const channel = findChannel(payload?.channelId);
      if (channel?.type !== "voice") return reply({ ok: false, error: "no-channel" });

      leaveVoice();

      // A lista vai na resposta, e não num evento solto, pra o recém-chegado já
      // conhecer todo mundo antes de os outros serem avisados dele. Se fosse por
      // evento, dava pra receber uma oferta de alguém que ainda não está no mapa.
      const peers = peersInVoiceChannel(channel.id, socket.id).map(publicMember);
      setVoiceChannel(socket.id, channel.id);
      socket.join(voiceRoom(channel.id));

      const member = getMember(socket.id);
      reply({ ok: true, channelId: channel.id, peers });
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
      const member = setVoiceState(socket.id, payload);
      if (!member) return;
      // Vai pra todos, não só pra quem está na call: a lista de canais mostra o
      // ícone de mudo de quem está em voz mesmo pra quem está lendo o chat.
      io.emit("member:state", publicMember(member));
    });

    socket.on("rtc:signal", (payload) => {
      if (!identified || !allow("signal")) return;
      const sender = getMember(socket.id);
      const target = getMember(payload?.to);
      // A checagem que importa: sem ela, este servidor seria um relay aberto pra
      // mandar pacote arbitrário a qualquer socket conectado.
      if (!sender?.voiceChannelId || target?.voiceChannelId !== sender.voiceChannelId) return;

      const { description, candidate, requestOffer } = payload;
      const validDescription = typeof description?.type === "string" && typeof description?.sdp === "string";
      const validCandidate = candidate !== undefined && (candidate === null || typeof candidate === "object");
      const validRequest = requestOffer === true;
      if (!validDescription && !validCandidate && !validRequest) return;

      io.to(target.id).emit("rtc:signal", {
        from: socket.id,
        ...(validDescription ? { description } : {}),
        ...(validCandidate ? { candidate } : {}),
        ...(validRequest ? { requestOffer: true } : {}),
      });
    });

    socket.on("disconnect", () => {
      if (identified) {
        leaveVoice();
        removeMember(socket.id);
        io.emit("member:left", { id: socket.id });
      }
      limiter.forget(`${socket.id}:`);
    });
  });
}
