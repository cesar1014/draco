import { logger, reason } from "./log.js";
import { invalidateIceCache, resolveIceConfig } from "./ice.js";
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
import { SocialRepository } from "./data/social-repository.js";
import { CommunicationRepository } from "./data/communication-repository.js";
import { AdminRepository } from "./data/admin-repository.js";
import { createSession, createSfuHealth, newTracks, renegotiate, sfuConfig } from "./sfu.js";
import { sessionCookie } from "./cookies.js";
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
  channelsOfGuild,
  deleteChannel,
  deleteGuild,
  deleteRole,
  findChannel,
  getMember,
  getMemberById,
  guildRoster,
  guildsOf,
  hasGuildPermission,
  isGuildMember,
  isGuildOwner,
  invalidateSfuSession,
  leaveGuild,
  listBans,
  listInvites,
  loadHistory,
  memberRolesOf,
  peersInVoiceChannel,
  publicMember,
  removeMember,
  revokeInvite,
  reorderChannels,
  reorderRoles,
  rolesOf,
  setSfuSession,
  setSfuTracks,
  setPresence,
  setVoiceChannel,
  setVoiceState,
  patchCachedMessage,
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
  ice: { burst: 6, perSec: 0.2 },
  /**
   * Ações administrativas. A rajada é generosa porque montar um servidor é uma
   * sequência: criar, dois ou três canais, um convite, abrir o painel. Quem
   * segura o abuso é a reposição lenta — meia ação por segundo não deixa ninguém
   * criar mil servidores, e cada uma delas escreve no banco.
   */
  admin: { burst: 25, perSec: 0.5 },
  // Aceitar convite é apertado por outro motivo: tentar códigos até acertar um
  // é o único caminho pra entrar num servidor sem ser convidado.
  invite: { burst: 5, perSec: 0.1 },
  social: { burst: 12, perSec: 0.3 },
  presence: { burst: 8, perSec: 0.2 },
};

/** Trilhas que uma pessoa pode publicar. Espelha `SLOT_ORDER` no cliente. */
const SLOTS = ["mic", "camera", "screen", "screenAudio"];

const log = logger("SIGNAL");
const sfuLog = logger("SFU");

const voiceRoom = (channelId) => `voice:${channelId}`;

const deadSfuSession = (error) =>
  /session.*(?:disconnected|invalid|not found|closed)|peerconnection.*(?:disconnected|failed|closed)/iu
    .test(reason(error));
/**
 * Uma sala de socket por servidor. É o que faz um servidor criado por alguém ser
 * privado de fato: canal novo, convite e banimento só chegam a quem é membro, em
 * vez de vazarem pra todo mundo conectado.
 */
const guildRoom = (guildId) => `guild:${guildId}`;
const channelRoom = (channelId) => `channel:${channelId}`;
const directRoom = (threadId) => `direct:${threadId}`;
const userRoom = (userId) => `user:${userId}`;

export function attachSignaling(io, env = process.env, {
  auth, accountService, telemetry = null, attachments = null,
} = {}) {
  if (!auth || !accountService) {
    throw new Error("attachSignaling precisa das autoridades de sessão e conta");
  }

  const limiter = new RateLimiter();
  const trustProxy = env.TRUSTED_PROXY === "1";
  const sfu = sfuConfig(env);
  const sfuHealth = createSfuHealth(sfu, { intervalMs: 5 * 60_000 });
  const callModes = new Map();
  const screenViewers = new Map();
  const accounts = accountService.repository;
  const social = new SocialRepository(accounts.database);
  const communication = new CommunicationRepository(accounts.database, attachments);
  const administration = new AdminRepository(accounts.database);
  const guestSessions = new Map();
  let lastForcedIceRefresh = 0;

  const viewerKey = (channelId, ownerId) => `${channelId}:${ownerId}`;
  const viewerList = (channelId, ownerId) => {
    const viewers = screenViewers.get(viewerKey(channelId, ownerId));
    if (!viewers) return [];
    return [...viewers].flatMap(([viewerId, startedAt]) => {
      const member = getMemberById(viewerId);
      return member?.voiceChannelId === channelId
        ? [{ id: member.id, username: member.username, color: member.color, startedAt }]
        : [];
    });
  };
  const emitViewers = (channelId, ownerId) => {
    io.to(voiceRoom(channelId)).emit("screen:viewers", {
      channelId,
      ownerId,
      viewers: viewerList(channelId, ownerId),
    });
  };
  const clearViewer = (channelId, viewerId) => {
    for (const [key, viewers] of [...screenViewers]) {
      if (!key.startsWith(`${channelId}:`) || !viewers.delete(viewerId)) continue;
      const ownerId = key.slice(channelId.length + 1);
      if (viewers.size === 0) screenViewers.delete(key);
      emitViewers(channelId, ownerId);
    }
  };
  const clearScreenViewers = (channelId, ownerId) => {
    if (!screenViewers.delete(viewerKey(channelId, ownerId))) return;
    emitViewers(channelId, ownerId);
  };
  const screenViewerSnapshot = (channelId) => Object.fromEntries(
    peersInVoiceChannel(channelId, null)
      .filter((member) => member.screenOn)
      .map((member) => [member.id, viewerList(channelId, member.id)]),
  );

  const socketCanChannel = (client, channel, permission = "view_channels") => {
    const identity = client.data?.draco;
    if (!identity?.userId) return false;
    if (identity.systemAdmin || isGuildOwner(channel.guildId, identity.userId)) return true;
    if (identity.guest) {
      return identity.guestGuildId === channel.guildId && ["view_channels", "connect", "speak"].includes(permission);
    }
    if (!isGuildMember(channel.guildId, identity.userId)) return false;
    const base = hasGuildPermission(channel.guildId, identity.userId, permission) ? [permission] : [];
    return administration.resolveChannelPermissions(channel.id, channel.guildId, identity.userId, base).includes(permission);
  };

  const syncChannelRoom = (channel) => {
    for (const client of io.sockets.sockets.values()) {
      const operation = socketCanChannel(client, channel) ? client.join(channelRoom(channel.id)) : client.leave(channelRoom(channel.id));
      void operation;
    }
  };
  const syncGuildChannelRooms = (guildId) => {
    for (const channel of channelsOfGuild(guildId)) syncChannelRoom(channel);
  };

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

    const canChannel = (channel, permission) => {
      if (systemAdmin || isGuildOwner(channel.guildId, userId)) return true;
      if (guest) return guestGuildId === channel.guildId && ["view_channels", "connect", "speak"].includes(permission);
      return administration.resolveChannelPermissions(
        channel.id,
        channel.guildId,
        userId,
        hasGuildPermission(channel.guildId, userId, permission)
          ? [permission]
          : [],
      ).includes(permission);
    };

    function presenceTarget(member, fromSocket = false) {
      const guildIds = member.guest
        ? [member.guestGuildId]
        : guildsOf(member.id).map((guild) => guild.id);
      const voiceGuildId = member.voiceChannelId ? findChannel(member.voiceChannelId)?.guildId : null;
      if (voiceGuildId && !guildIds.includes(voiceGuildId)) guildIds.push(voiceGuildId);
      const rooms = [
        ...guildIds.filter(Boolean).map(guildRoom),
        ...(member.guest ? [] : social.friendIds(member.id).map(userRoom)),
      ];
      let target = fromSocket ? socket.to(rooms[0] ?? "none") : io.to(rooms[0] ?? "none");
      for (const room of rooms.slice(1)) target = target.to(room);
      return { target, hasRooms: rooms.length > 0 };
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
      clearViewer(channelId, member.id);
      clearScreenViewers(channelId, member.id);
      socket.leave(voiceRoom(channelId));
      setVoiceChannel(member.id, null);
      telemetry?.leaveCall(channelId, member.id);
      io.to(voiceRoom(channelId)).emit("voice:peer-left", { channelId, memberId: member.id });
      if (peersInVoiceChannel(channelId, member.id).length === 0) callModes.delete(channelId);
      emitPresence("member:state", getMemberById(member.id));
    }

    function removeFromGuildVoice(targetId, guildId, moderationReason) {
      const targetMember = getMemberById(targetId);
      const channel = targetMember?.voiceChannelId ? findChannel(targetMember.voiceChannelId) : null;
      if (!targetMember || channel?.guildId !== guildId) return;
      const targetSocket = io.sockets.sockets.get(targetMember.socketId);
      clearViewer(channel.id, targetId);
      clearScreenViewers(channel.id, targetId);
      targetSocket?.leave(voiceRoom(channel.id));
      setVoiceChannel(targetId, null);
      telemetry?.leaveCall(channel.id, targetId);
      io.to(voiceRoom(channel.id)).emit("voice:peer-left", { channelId: channel.id, memberId: targetId });
      targetSocket?.emit("voice:moderated", { channelId: channel.id, reason: moderationReason });
      if (peersInVoiceChannel(channel.id, targetId).length === 0) callModes.delete(channel.id);
      emitPresence("member:state", getMemberById(targetId));
    }

    /**
     * O canal existe, é do tipo certo e pertence a um servidor de que esta pessoa
     * é membro. A última parte é a que importa: sem ela, conhecer o id de um canal
     * bastaria pra ler e escrever num servidor privado.
     */
    function visibleChannel(channelId, type) {
      const channel = findChannel(channelId);
      if (!channel || channel.type !== type) return null;
      return hasAccess(channel.guildId) && canChannel(channel, "view_channels") ? channel : null;
    }

    /** Entra nas salas dos servidores de que a pessoa é membro. */
    function joinGuildRooms() {
      for (const guild of currentGuilds()) socket.join(guildRoom(guild.id));
      for (const guild of currentGuilds()) {
        for (const channel of channelsOfGuild(guild.id)) {
          if (canChannel(channel, "view_channels")) socket.join(channelRoom(channel.id));
        }
      }
      socket.join(userRoom(userId));
      if (!guest) {
        for (const thread of accounts.listThreads(userId)) socket.join(directRoom(thread.id));
      }
    }

    /** Snapshot pessoal: aplica overwrites antes de qualquer canal ou histórico sair. */
    function clientState() {
      const state = snapshot(userId, { systemAdmin, guestGuildId });
      const visibleIds = new Set(
        state.channels
          .filter((channel) => canChannel(channel, "view_channels"))
          .map((channel) => channel.id),
      );
      state.channels = state.channels.filter((channel) => visibleIds.has(channel.id));
      state.messages = Object.fromEntries(
        Object.entries(state.messages)
          .filter(([channelId]) => visibleIds.has(channelId))
          .map(([channelId, channelMessages]) => [channelId, communication.enrich("channel", channelMessages)]),
      );
      if (!guest) {
        state.directThreads = accounts.listThreads(userId);
        state.directMessages = {};
        state.relationships = social.relationshipSnapshot(userId);
        state.notifications = social.notifications(userId);
        state.unread = social.unreadSnapshot(
          userId,
          new Set(state.channels.filter((channel) => channel.type === "text").map((channel) => channel.id)),
        );
      }
      state.sfuHealth = sfuHealth.snapshot();
      return state;
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
        const cookieToken = sessionCookie(socket.request.headers.cookie);
        const authenticated = accountService.session(cookieToken ?? payload?.token, address);
        if (!authenticated) return reply({ ok: false, error: "not-authenticated" });
        account = authenticated.account;
        identified = true;
        userId = account.userId;
        systemAdmin = account.isSystemAdmin;
        renewed = cookieToken ? null : auth.renewIfNeeded(authenticated);
        ({ member, previousSocketId } = addMember(socket.id, userId, account.username, {
          systemAdmin,
          profile: social.profile(userId),
        }));
      }

      // Duas abas com o mesmo id disputariam o mesmo membro; a mais nova fica.
      if (previousSocketId && previousSocketId !== socket.id) {
        io.sockets.sockets.get(previousSocketId)?.disconnect(true);
      }

      log.info("identificado", { userId: member.id, visitante: guest, administrador: systemAdmin });
      socket.data.draco = { userId: member.id, guest, guestGuildId, systemAdmin };
      joinGuildRooms();
      const state = clientState();
      reply({
        ok: true,
        selfId: member.id,
        ...(renewed ? { token: renewed.token } : {}),
        ...(guestToken ? { guestToken } : {}),
        account: guest
          ? { id: member.id, username: member.username, email: null, isSystemAdmin: false, guest: true }
          : { ...accountService.publicAccount(account), guest: false },
        sfu: sfuHealth.available(),
        state,
      });
      emitPresence("member:joined", member, { excludeSelf: true });
    });

    // TURN é um recurso autenticado. Visitante identificado pode usá-lo para
    // voz, mas um robô anônimo não consegue colher credenciais pela API.
    socket.on("ice:get", async (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified) return reply({ ok: false, error: "not-identified" });
      if (!allow("ice")) return reply({ ok: false, error: "rate-limited" });
      if (payload?.refresh === true && Date.now() - lastForcedIceRefresh > 60_000) {
        lastForcedIceRefresh = Date.now();
        invalidateIceCache();
      }
      try {
        const config = await resolveIceConfig();
        if (payload?.refresh === true) {
          telemetry?.iceRestart();
          if (config.hasTurn) telemetry?.turnFailure();
        }
        reply({ ok: true, config });
      } catch (error) {
        sfuLog.error("falha ao montar ICE", { motivo: reason(error) });
        reply({ ok: false, error: "ice-config-failed" });
      }
    });

    socket.on("chat:send", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !allow("chat")) return reply({ ok: false, error: "not-authenticated" });
      const member = getMember(socket.id);
      const channel = visibleChannel(payload?.channelId, "text");
      if (!member || !channel || !canChannel(channel, "send_messages")) return reply({ ok: false, error: "forbidden" });
      if (administration.isTimedOut(channel.guildId, userId)) return reply({ ok: false, error: "timed-out" });
      const content = sanitizeMessage(payload?.content);
      if (!content) return reply({ ok: false, error: "bad-message" });
      // Só quem é do servidor: mandar pra todo mundo conectado vazaria a conversa
      // de um servidor privado pra quem não faz parte dele.
      const replyToId = isId(payload?.replyToId) ? payload.replyToId : null;
      if (replyToId && communication.channelMessage(replyToId)?.channelId !== channel.id) {
        return reply({ ok: false, error: "bad-request" });
      }
      const message = addMessage(channel.id, member, content, replyToId);
      telemetry?.message();
      const mentionResult = social.recordMentions(message.id, channel.guildId, content, {
        elevated: can(channel.guildId, "mention_everyone"),
        authorId: userId,
      });
      const hydrated = communication.channelMessage(message.id);
      hydrated.mentions = mentionResult.targets;
      patchCachedMessage(hydrated);
      io.to(channelRoom(channel.id)).emit("chat:message", hydrated);
      for (const mentionedId of mentionResult.userIds) {
        social.incrementMention(mentionedId, "channel", channel.id);
        const notification = social.notify({
          userId: mentionedId,
          kind: "mention",
          actorId: userId,
          conversationType: "channel",
          conversationId: channel.id,
          metadata: { username: member.username, guildId: channel.guildId },
        });
        io.to(userRoom(mentionedId)).emit("notification:new", notification);
      }
      reply({ ok: true, message: hydrated });
    });

    socket.on("chat:edit", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !allow("chat") || !isId(payload?.messageId)) {
        return reply({ ok: false, error: "bad-request" });
      }
      const original = communication.channelMessage(payload.messageId);
      if (!original || !visibleChannel(original.channelId, "text")) return reply({ ok: false, error: "no-message" });
      if (original.authorId !== userId && !can(original.guildId, "manage_messages")) {
        return reply({ ok: false, error: "missing-permission" });
      }
      const content = sanitizeMessage(payload?.content);
      if (!content) return reply({ ok: false, error: "bad-message" });
      const message = communication.editChannel(original.id, content);
      communication.clearMentions(original.id);
      message.mentions = social.recordMentions(original.id, original.guildId, content, {
        elevated: can(original.guildId, "mention_everyone"), authorId: userId,
      }).targets;
      patchCachedMessage(message);
      io.to(channelRoom(original.channelId)).emit("chat:updated", message);
      reply({ ok: true, message });
    });

    socket.on("chat:delete", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !allow("chat") || !isId(payload?.messageId)) {
        return reply({ ok: false, error: "bad-request" });
      }
      const original = communication.channelMessage(payload.messageId);
      if (!original || !visibleChannel(original.channelId, "text")) return reply({ ok: false, error: "no-message" });
      if (original.authorId !== userId && !can(original.guildId, "manage_messages")) {
        return reply({ ok: false, error: "missing-permission" });
      }
      const message = communication.deleteChannel(original.id);
      patchCachedMessage(message);
      io.to(channelRoom(original.channelId)).emit("chat:updated", message);
      reply({ ok: true, message });
    });

    socket.on("chat:react", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !allow("social") || !isId(payload?.messageId)) {
        return reply({ ok: false, error: "bad-request" });
      }
      const original = communication.channelMessage(payload.messageId);
      const emoji = typeof payload?.emoji === "string" ? payload.emoji.trim() : "";
      if (!original || !visibleChannel(original.channelId, "text") || !emoji || emoji.length > 16 || /[\u0000-\u001f]/.test(emoji)) {
        return reply({ ok: false, error: "bad-request" });
      }
      const message = communication.toggleReaction("channel", original.id, userId, emoji);
      patchCachedMessage(message);
      io.to(channelRoom(original.channelId)).emit("chat:updated", message);
      reply({ ok: true, message });
    });

    const relationshipsFor = (id) => social.relationshipSnapshot(id);
    const publishRelationships = (...ids) => {
      for (const id of new Set(ids.filter(Boolean))) {
        io.to(userRoom(id)).emit("relationship:update", relationshipsFor(id));
      }
    };

    socket.on("friend:request", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("social")) return reply({ ok: false, error: "rate-limited" });
      const username = sanitizeUsername(payload?.username);
      const target = username ? social.targetByUsername(username) : null;
      if (!target) return reply({ ok: false, error: "no-user" });
      const result = social.sendRequest(userId, target.id);
      if (!result.ok) return reply(result);
      const notification = social.notify({
        userId: target.id,
        kind: "friend_request",
        actorId: userId,
        metadata: { username: getMember(socket.id)?.username ?? account?.username },
      });
      io.to(userRoom(target.id)).emit("notification:new", notification);
      publishRelationships(userId, target.id);
      reply({ ok: true, relationships: relationshipsFor(userId) });
    });

    socket.on("friend:accept", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("social") || !isId(payload?.userId)) return reply({ ok: false, error: "bad-request" });
      const result = social.acceptRequest(userId, payload.userId);
      if (!result.ok) return reply(result);
      publishRelationships(userId, payload.userId);
      reply({ ok: true, relationships: relationshipsFor(userId) });
    });

    socket.on("friend:reject", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("social") || !isId(payload?.userId)) return reply({ ok: false, error: "bad-request" });
      if (!social.rejectRequest(userId, payload.userId)) return reply({ ok: false, error: "no-request" });
      publishRelationships(userId, payload.userId);
      reply({ ok: true, relationships: relationshipsFor(userId) });
    });

    socket.on("friend:cancel", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("social") || !isId(payload?.userId)) return reply({ ok: false, error: "bad-request" });
      if (!social.cancelRequest(userId, payload.userId)) return reply({ ok: false, error: "no-request" });
      publishRelationships(userId, payload.userId);
      reply({ ok: true, relationships: relationshipsFor(userId) });
    });

    socket.on("friend:remove", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("social") || !isId(payload?.userId)) return reply({ ok: false, error: "bad-request" });
      if (!social.removeFriend(userId, payload.userId)) return reply({ ok: false, error: "not-friends" });
      publishRelationships(userId, payload.userId);
      reply({ ok: true, relationships: relationshipsFor(userId) });
    });

    socket.on("friend:block", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("social") || !isId(payload?.userId) || payload.userId === userId) {
        return reply({ ok: false, error: "bad-request" });
      }
      social.block(userId, payload.userId);
      publishRelationships(userId, payload.userId);
      reply({ ok: true, relationships: relationshipsFor(userId) });
    });

    socket.on("friend:unblock", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("social") || !isId(payload?.userId)) return reply({ ok: false, error: "bad-request" });
      if (!social.unblock(userId, payload.userId)) return reply({ ok: false, error: "not-blocked" });
      publishRelationships(userId, payload.userId);
      reply({ ok: true, relationships: relationshipsFor(userId) });
    });

    socket.on("presence:update", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("presence")) return reply({ ok: false, error: "rate-limited" });
      const mode = ["online", "away", "dnd", "invisible"].includes(payload?.mode)
        ? payload.mode
        : null;
      if (!mode) return reply({ ok: false, error: "bad-request" });
      const status = payload?.status == null ? null : sanitizeMessage(payload.status)?.slice(0, 128) || null;
      const expiresAt = status && Number.isFinite(payload?.expiresAt)
        ? Math.min(Math.max(payload.expiresAt, Date.now() + 60_000), Date.now() + 30 * 24 * 60 * 60 * 1000)
        : null;
      const profile = social.updatePresence(userId, mode, status, expiresAt);
      const member = setPresence(userId, profile);
      emitPresence("member:state", member);
      reply({ ok: true, profile });
    });

    socket.on("notification:read", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !isId(payload?.id)) return reply({ ok: false, error: "bad-request" });
      reply({ ok: social.readNotification(userId, payload.id) });
    });

    socket.on("read:mark", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !allow("presence")) return reply({ ok: false, error: "rate-limited" });
      const type = payload?.type;
      const id = payload?.id;
      const sequence = payload?.sequence;
      if (!["channel", "direct"].includes(type) || !isId(id) || !Number.isSafeInteger(sequence) || sequence < 0) {
        return reply({ ok: false, error: "bad-request" });
      }
      const allowed = type === "channel"
        ? Boolean(visibleChannel(id, "text"))
        : accounts.isParticipant(id, userId);
      if (!allowed) return reply({ ok: false, error: "not-member" });
      social.markRead(userId, type, id, sequence);
      reply({ ok: true });
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
      reply({ ok: true, channelId: channel.id, messages: communication.enrich("channel", page.messages), more: page.more });
    });

    socket.on("voice:join", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || !allow("voiceJoin")) return reply({ ok: false, error: "rate-limited" });
      const channel = visibleChannel(payload?.channelId, "voice");
      if (!channel || !canChannel(channel, "connect") || administration.isTimedOut(channel.guildId, userId)) {
        return reply({ ok: false, error: "no-channel" });
      }

      leaveVoice();

      // A lista vai na resposta, e não num evento solto, pra o recém-chegado já
      // conhecer todo mundo antes de os outros serem avisados dele. Se fosse por
      // evento, dava pra receber uma oferta de alguém que ainda não está no mapa.
      const peers = peersInVoiceChannel(channel.id, userId).map(publicMember);
      const mode = callModes.get(channel.id) ?? (sfuHealth.available() ? "sfu" : "p2p");
      callModes.set(channel.id, mode);
      setVoiceChannel(userId, channel.id);
      telemetry?.joinCall(channel.id, userId, mode);
      socket.join(voiceRoom(channel.id));

      const member = getMember(socket.id);
      reply({
        ok: true,
        channelId: channel.id,
        peers,
        screenViewers: screenViewerSnapshot(channel.id),
        sfu: mode === "sfu",
        sfuHealth: sfuHealth.snapshot(),
      });
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
      if (payload?.screenOn === false && member.voiceChannelId) {
        clearScreenViewers(member.voiceChannelId, member.id);
      }
      // Vai pra todos, não só pra quem está na call: a lista de canais mostra o
      // ícone de mudo de quem está em voz mesmo pra quem está lendo o chat.
      emitPresence("member:state", member);
    });

    socket.on("screen:view", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || !allow("voiceState")) return reply({ ok: false, error: "rate-limited" });
      const viewer = getMember(socket.id);
      const owner = getMemberById(payload?.ownerId);
      if (!viewer?.voiceChannelId || !owner || owner.id === viewer.id ||
          owner.voiceChannelId !== viewer.voiceChannelId) {
        return reply({ ok: false, error: "not-in-voice" });
      }
      const key = viewerKey(viewer.voiceChannelId, owner.id);
      if (payload?.watching === true) {
        if (!owner.screenOn) return reply({ ok: false, error: "no-screen" });
        const viewers = screenViewers.get(key) ?? new Map();
        if (!viewers.has(viewer.id)) viewers.set(viewer.id, Date.now());
        screenViewers.set(key, viewers);
      } else {
        const viewers = screenViewers.get(key);
        viewers?.delete(viewer.id);
        if (viewers?.size === 0) screenViewers.delete(key);
      }
      emitViewers(viewer.voiceChannelId, owner.id);
      reply({ ok: true });
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
      if (!sfu || sfuHealth.snapshot().status === "UNAVAILABLE") {
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
      if (callModes.get(member.voiceChannelId) !== "sfu") {
        reply({ ok: false, error: "call-mode-p2p" });
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
        sfuHealth.markSuccess();
        emitPresence("member:state", getMemberById(member.id));
        reply({ ok: true });
      } catch (error) {
        sfuHealth.markFailure(error);
        telemetry?.callError();
        io.to(voiceRoom(member.voiceChannelId)).emit("sfu:health", sfuHealth.snapshot());
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
        sfuHealth.markFailure(error);
        sfuLog.error("falha ao publicar trilhas", { userId: member.id, motivo: reason(error) });
        if (deadSfuSession(error)) {
          const invalidated = invalidateSfuSession(member.id, "send");
          if (invalidated) emitPresence("member:state", invalidated);
          return reply({ ok: false, error: "stale-session" });
        }
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
        sfuHealth.markFailure(error);
        sfuLog.error("falha ao assinar trilhas", { userId: member.id, motivo: reason(error) });
        if (deadSfuSession(error)) {
          invalidateSfuSession(member.id, "recv");
          return reply({ ok: false, error: "stale-session" });
        }
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
        sfuHealth.markFailure(error);
        sfuLog.error("falha ao renegociar", {
          userId: member.id,
          role,
          motivo: reason(error),
        });
        if (deadSfuSession(error)) {
          const invalidated = invalidateSfuSession(member.id, role);
          if (role === "send" && invalidated) emitPresence("member:state", invalidated);
          return reply({ ok: false, error: "stale-session" });
        }
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
      for (const channel of channelsOfGuild(guild.id)) syncChannelRoom(channel);
      log.info("servidor criado", { guildId: guild.id, ownerId: userId });
      reply({ ok: true, guild, state: clientState() });
    });

    socket.on("guild:delete", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId)) return;
      // Excluir o servidor é exclusivo de quem o criou. Nem permissões de
      // cargo nem a administração global substituem a liderança desta ação.
      if (!isGuildOwner(guildId, userId)) {
        return reply({ ok: false, error: "not-owner" });
      }

      const guildChannels = channelsOfGuild(guildId);
      const voiceParticipants = guildChannels.flatMap((channel) =>
        channel.type === "voice"
          ? peersInVoiceChannel(channel.id, null).map((member) => ({ channelId: channel.id, memberId: member.id }))
          : [],
      );
      const result = deleteGuild(guildId);
      if (!result.ok) return reply(result);

      // O evento sai antes de remover as salas do Socket.IO. Assim membros,
      // convidados e administradores conectados descartam o servidor na hora.
      io.to(guildRoom(guildId)).emit("guild:deleted", {
        guildId,
        name: result.guild.name,
      });
      for (const channel of guildChannels) {
        if (channel.type === "voice") {
          io.to(voiceRoom(channel.id)).emit("voice:channel-closed", { channelId: channel.id });
          io.in(voiceRoom(channel.id)).socketsLeave(voiceRoom(channel.id));
          callModes.delete(channel.id);
          for (const key of [...screenViewers.keys()]) {
            if (key.startsWith(`${channel.id}:`)) screenViewers.delete(key);
          }
        }
        io.in(channelRoom(channel.id)).socketsLeave(channelRoom(channel.id));
      }
      io.in(guildRoom(guildId)).socketsLeave(guildRoom(guildId));

      for (const participant of voiceParticipants) {
        telemetry?.leaveCall(participant.channelId, participant.memberId);
        emitPresence("member:state", getMemberById(participant.memberId));
      }
      log.info("servidor excluído", { guildId, name: result.guild.name, por: userId });
      reply({ ok: true, guildId, state: clientState() });
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
      for (const channel of channelsOfGuild(guildId)) socket.leave(channelRoom(channel.id));
      io.to(guildRoom(guildId)).emit("guild:member-left", { guildId, userId });
      reply({ ok: true, state: clientState() });
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
      administration.audit(guildId, userId, "channel.create", "channel", channel.id, { type, name });
      syncChannelRoom(channel);
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
      administration.audit(channel.guildId, userId, "channel.delete", "channel", channel.id, { name: channel.name, type: channel.type });

      // Quem estava na call do canal apagado precisa saber, senão o cliente
      // continuaria mostrando uma call que não existe mais.
      io.to(voiceRoom(channel.id)).emit("voice:channel-closed", { channelId: channel.id });
      io.to(guildRoom(channel.guildId)).emit("channel:deleted", {
        guildId: channel.guildId,
        channelId: channel.id,
      });
      reply({ ok: true });
    });

    socket.on("channel:reorder", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_channels" })) return;
      const orderedIds = payload?.orderedIds;
      if (!Array.isArray(orderedIds) || orderedIds.length > 100 || orderedIds.some((id) => !isId(id))) {
        return reply({ ok: false, error: "bad-request" });
      }
      if (!reorderChannels(guildId, orderedIds)) return reply({ ok: false, error: "bad-request" });
      const reordered = channelsOfGuild(guildId);
      io.to(guildRoom(guildId)).emit("channels:reordered", { guildId, channels: reordered });
      reply({ ok: true, channels: reordered });
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
      administration.audit(guildId, userId, "invite.create", "invite", code, { maxUses, expiresInHours: hours });
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
      for (const channel of channelsOfGuild(result.guildId)) syncChannelRoom(channel);
      if (result.joined) {
        const member = getMember(socket.id);
        io.to(guildRoom(result.guildId)).emit("guild:member-joined", {
          guildId: result.guildId,
          member: { id: userId, username: member?.username ?? "", color: member?.color ?? "" },
        });
      }
      log.info("convite aceito", { guildId: result.guildId, userId, novo: result.joined });
      reply({ ok: true, guildId: result.guildId, state: clientState() });
    });

    socket.on("invite:revoke", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "create_invites" })) return;
      if (!isId(payload?.code, 32)) return reply({ ok: false, error: "bad-request" });

      const removed = revokeInvite(guildId, payload.code);
      if (removed) administration.audit(guildId, userId, "invite.revoke", "invite", payload.code);
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
      if (isGuildOwner(guildId, target)) {
        return reply({ ok: false, error: "protected-user" });
      }
      if (accounts.accountById(target)?.isSystemAdmin && !systemAdmin) {
        return reply({ ok: false, error: "protected-user" });
      }
      if (!isGuildMember(guildId, target)) return reply({ ok: false, error: "not-member" });
      if (!administration.canActOn(guildId, userId, target, { systemAdmin })) {
        return reply({ ok: false, error: "role-hierarchy" });
      }
      const banned = banMember(guildId, target, userId, sanitizeReason(payload?.reason));
      removeFromGuildVoice(target, guildId, "ban");
      administration.audit(guildId, userId, "member.ban", "member", target, { reason: sanitizeReason(payload?.reason) });
      io.to(guildRoom(guildId)).emit("guild:member-left", { guildId, userId: target });

      // A pessoa banida precisa sair da sala do servidor agora: continuar nela
      // significaria continuar recebendo o chat de onde ela não pode mais entrar.
      const socketId = banned?.socketId;
      if (socketId) {
        const targetSocket = io.sockets.sockets.get(socketId);
        targetSocket?.leave(guildRoom(guildId));
        for (const channel of channelsOfGuild(guildId)) targetSocket?.leave(channelRoom(channel.id));
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
      if (removed) administration.audit(guildId, userId, "member.unban", "member", payload.userId);
      reply({ ok: removed, bans: listBans(guildId), ...(removed ? {} : { error: "no-ban" }) });
    });

    socket.on("member:kick", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "moderate_members" })) return;
      const target = payload?.userId;
      if (!isId(target) || target === userId || !isGuildMember(guildId, target)) return reply({ ok: false, error: "bad-request" });
      if (!administration.canActOn(guildId, userId, target, { systemAdmin })) return reply({ ok: false, error: "role-hierarchy" });
      if (!administration.kick(guildId, target)) return reply({ ok: false, error: "not-member" });
      removeFromGuildVoice(target, guildId, "kick");
      administration.audit(guildId, userId, "member.kick", "member", target, { reason: sanitizeReason(payload?.reason) });
      io.to(guildRoom(guildId)).emit("guild:member-left", { guildId, userId: target });
      const targetSocket = getMemberById(target)?.socketId ? io.sockets.sockets.get(getMemberById(target).socketId) : null;
      targetSocket?.leave(guildRoom(guildId));
      for (const channel of channelsOfGuild(guildId)) targetSocket?.leave(channelRoom(channel.id));
      targetSocket?.emit("guild:kicked", { guildId });
      reply({ ok: true });
    });

    socket.on("member:timeout", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "moderate_members" })) return;
      const target = payload?.userId;
      const durationMs = payload?.durationMs;
      if (!isId(target) || target === userId || !isGuildMember(guildId, target) || !Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > 28 * 24 * 60 * 60 * 1000) {
        return reply({ ok: false, error: "bad-request" });
      }
      if (!administration.canActOn(guildId, userId, target, { systemAdmin })) return reply({ ok: false, error: "role-hierarchy" });
      const expiresAt = administration.timeout(guildId, target, userId, durationMs, sanitizeReason(payload?.reason));
      administration.audit(guildId, userId, "member.timeout", "member", target, { expiresAt, reason: sanitizeReason(payload?.reason) });
      removeFromGuildVoice(target, guildId, "timeout");
      reply({ ok: true, expiresAt, timeouts: administration.timeouts(guildId) });
    });

    socket.on("member:timeout-remove", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "moderate_members" }) || !isId(payload?.userId)) return;
      const removed = administration.removeTimeout(guildId, payload.userId);
      if (removed) administration.audit(guildId, userId, "member.timeout_remove", "member", payload.userId);
      reply({ ok: removed, timeouts: administration.timeouts(guildId), ...(removed ? {} : { error: "no-timeout" }) });
    });

    socket.on("channel:permissions", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const channel = findChannel(payload?.channelId);
      if (!channel || !guildAction(reply, channel.guildId, { permission: "manage_channels" })) return;
      if (payload?.operation === "list") return reply({ ok: true, overwrites: administration.overwrites(channel.id) });
      const targetType = payload?.targetType;
      const targetId = payload?.targetId;
      if (!["role", "member"].includes(targetType) || !isId(targetId)) return reply({ ok: false, error: "bad-request" });
      if (targetType === "role" && !rolesOf(channel.guildId).some((role) => role.id === targetId)) return reply({ ok: false, error: "bad-request" });
      if (targetType === "member" && !isGuildMember(channel.guildId, targetId)) return reply({ ok: false, error: "bad-request" });
      const allowPermissions = sanitizePermissions(payload?.allow);
      const denyPermissions = sanitizePermissions(payload?.deny).filter((permission) => !allowPermissions.includes(permission));
      administration.setOverwrite(channel.id, targetType, targetId, allowPermissions, denyPermissions);
      administration.audit(channel.guildId, userId, "channel.permissions", "channel", channel.id, { targetType, targetId, allow: allowPermissions, deny: denyPermissions });
      syncChannelRoom(channel);
      reply({ ok: true, overwrites: administration.overwrites(channel.id) });
    });

    socket.on("audit:list", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "view_audit_log" })) return;
      const action = typeof payload?.action === "string" && payload.action.length <= 64 ? payload.action : null;
      reply({ ok: true, auditLog: administration.auditLog(guildId, { action }) });
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
        timeouts: can(guildId, "moderate_members") ? administration.timeouts(guildId) : [],
        auditLog: can(guildId, "view_audit_log") ? administration.auditLog(guildId) : [],
      });
    });

    socket.on("role:create", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_roles" })) return;
      if (!systemAdmin && !isGuildOwner(guildId, userId)) return reply({ ok: false, error: "role-hierarchy" });
      const name = sanitizeRoleName(payload?.name);
      if (!name) return reply({ ok: false, error: "bad-name" });
      const permissions = sanitizePermissions(payload?.permissions);
      const color = typeof payload?.color === "string" && /^#[0-9a-f]{6}$/i.test(payload.color)
        ? payload.color.toUpperCase()
        : null;
      const role = createRole(guildId, name, color, permissions);
      administration.audit(guildId, userId, "role.create", "role", role.id, { name });
      syncGuildChannelRooms(guildId);
      io.to(guildRoom(guildId)).emit("role:changed", {
        guildId,
        roles: rolesOf(guildId),
        memberRoles: memberRolesOf(guildId),
      });
      reply({ ok: true, role, roles: rolesOf(guildId) });
    });

    socket.on("role:update", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_roles" })) return;
      if (!isId(payload?.roleId)) return reply({ ok: false, error: "bad-request" });
      if (!administration.canManageRole(guildId, userId, payload.roleId, { systemAdmin })) return reply({ ok: false, error: "role-hierarchy" });
      const name = sanitizeRoleName(payload?.name);
      if (!name) return reply({ ok: false, error: "bad-name" });
      const permissions = sanitizePermissions(payload?.permissions);
      const color = typeof payload?.color === "string" && /^#[0-9a-f]{6}$/i.test(payload.color)
        ? payload.color.toUpperCase()
        : null;
      const role = updateRole(guildId, payload.roleId, name, color, permissions);
      if (!role) return reply({ ok: false, error: "role-protected" });
      administration.audit(guildId, userId, "role.update", "role", role.id, { name });
      syncGuildChannelRooms(guildId);
      io.to(guildRoom(guildId)).emit("role:changed", {
        guildId,
        roles: rolesOf(guildId),
        memberRoles: memberRolesOf(guildId),
      });
      reply({ ok: true, role, roles: rolesOf(guildId) });
    });

    socket.on("role:delete", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_roles" })) return;
      if (!isId(payload?.roleId)) return reply({ ok: false, error: "bad-request" });
      if (!administration.canManageRole(guildId, userId, payload.roleId, { systemAdmin })) return reply({ ok: false, error: "role-hierarchy" });
      const removed = deleteRole(guildId, payload.roleId);
      if (!removed) return reply({ ok: false, error: "role-protected" });
      administration.audit(guildId, userId, "role.delete", "role", payload.roleId);
      syncGuildChannelRooms(guildId);
      io.to(guildRoom(guildId)).emit("role:changed", {
        guildId,
        roles: rolesOf(guildId),
        memberRoles: memberRolesOf(guildId),
      });
      reply({ ok: true, roles: rolesOf(guildId), memberRoles: memberRolesOf(guildId) });
    });

    socket.on("role:assign", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_roles" })) return;
      if (!isId(payload?.roleId) || !isId(payload?.userId) || !isGuildMember(guildId, payload.userId)) {
        return reply({ ok: false, error: "bad-request" });
      }
      if (!administration.canManageRole(guildId, userId, payload.roleId, { systemAdmin }) ||
          !administration.canActOn(guildId, userId, payload.userId, { systemAdmin })) {
        return reply({ ok: false, error: "role-hierarchy" });
      }
      const changed = assignRole(guildId, payload.userId, payload.roleId, payload.assigned === true);
      if (!changed) return reply({ ok: false, error: "role-protected" });
      administration.audit(guildId, userId, payload.assigned === true ? "role.assign" : "role.unassign", "member", payload.userId, { roleId: payload.roleId });
      syncGuildChannelRooms(guildId);
      io.to(guildRoom(guildId)).emit("role:changed", {
        guildId,
        roles: rolesOf(guildId),
        memberRoles: memberRolesOf(guildId),
      });
      reply({ ok: true, memberRoles: memberRolesOf(guildId) });
    });

    socket.on("role:reorder", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const guildId = payload?.guildId;
      if (!guildAction(reply, guildId, { permission: "manage_roles" })) return;
      if (!systemAdmin && !isGuildOwner(guildId, userId)) return reply({ ok: false, error: "role-hierarchy" });
      const orderedIds = payload?.orderedIds;
      if (!Array.isArray(orderedIds) || orderedIds.length > 100 || orderedIds.some((id) => !isId(id))) {
        return reply({ ok: false, error: "bad-request" });
      }
      if (!reorderRoles(guildId, orderedIds)) return reply({ ok: false, error: "bad-request" });
      administration.audit(guildId, userId, "role.reorder", "guild", guildId, { orderedIds });
      syncGuildChannelRooms(guildId);
      const roles = rolesOf(guildId);
      const memberRoles = memberRolesOf(guildId);
      io.to(guildRoom(guildId)).emit("role:changed", { guildId, roles, memberRoles });
      reply({ ok: true, roles, memberRoles });
    });

    socket.on("direct:open", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest) return reply({ ok: false, error: "not-authenticated" });
      if (!allow("admin")) return reply({ ok: false, error: "rate-limited" });
      const targetId = payload?.userId;
      if (!isId(targetId) || !accounts.accountById(targetId)) {
        return reply({ ok: false, error: "no-user" });
      }
      if (social.isBlocked(userId, targetId)) {
        return reply({ ok: false, error: "relationship-blocked" });
      }
      if (!social.areFriends(userId, targetId) && !accounts.sharesGuild(userId, targetId)) {
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
        messages: communication.enrich("direct", accounts.listDirectMessages(threadId)),
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
      reply({ ok: true, messages: communication.enrich("direct", accounts.listDirectMessages(payload.threadId)) });
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
      const participants = accounts.participants(threadId);
      if (participants.some((participantId) => participantId !== userId && social.isBlocked(userId, participantId))) {
        return reply({ ok: false, error: "relationship-blocked" });
      }
      const content = sanitizeMessage(payload?.content);
      if (!content) return reply({ ok: false, error: "bad-message" });
      const replyToId = isId(payload?.replyToId) ? payload.replyToId : null;
      if (replyToId && communication.directMessage(replyToId)?.threadId !== threadId) {
        return reply({ ok: false, error: "bad-request" });
      }
      const created = accounts.addDirectMessage(threadId, userId, content, replyToId);
      telemetry?.message();
      const message = communication.directMessage(created.id);
      io.to(directRoom(threadId)).emit("direct:message", message);
      for (const participantId of participants) {
        if (participantId === userId) continue;
        const notification = social.notify({
          userId: participantId,
          kind: "direct",
          actorId: userId,
          conversationType: "direct",
          conversationId: threadId,
          metadata: { username: message.username },
        });
        io.to(userRoom(participantId)).emit("notification:new", notification);
      }
      reply({ ok: true, message });
    });

    socket.on("direct:edit", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !allow("chat") || !isId(payload?.messageId)) return reply({ ok: false, error: "bad-request" });
      const original = communication.directMessage(payload.messageId);
      if (!original || original.authorId !== userId || !accounts.isParticipant(original.threadId, userId)) {
        return reply({ ok: false, error: "not-author" });
      }
      const content = sanitizeMessage(payload?.content);
      if (!content) return reply({ ok: false, error: "bad-message" });
      const message = communication.editDirect(original.id, content);
      io.to(directRoom(original.threadId)).emit("direct:updated", message);
      reply({ ok: true, message });
    });

    socket.on("direct:delete", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!identified || guest || !allow("chat") || !isId(payload?.messageId)) return reply({ ok: false, error: "bad-request" });
      const original = communication.directMessage(payload.messageId);
      if (!original || original.authorId !== userId || !accounts.isParticipant(original.threadId, userId)) {
        return reply({ ok: false, error: "not-author" });
      }
      const message = communication.deleteDirect(original.id);
      io.to(directRoom(original.threadId)).emit("direct:updated", message);
      reply({ ok: true, message });
    });

    socket.on("direct:react", (payload, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const original = isId(payload?.messageId) ? communication.directMessage(payload.messageId) : null;
      const emoji = typeof payload?.emoji === "string" ? payload.emoji.trim() : "";
      if (!identified || guest || !allow("social") || !original || !accounts.isParticipant(original.threadId, userId) || !emoji || emoji.length > 16) {
        return reply({ ok: false, error: "bad-request" });
      }
      const message = communication.toggleReaction("direct", original.id, userId, emoji);
      io.to(directRoom(original.threadId)).emit("direct:updated", message);
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
