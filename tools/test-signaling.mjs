/**
 * Teste de integração da sinalização. Sobe o servidor num porta própria, conecta
 * clientes de verdade via socket.io-client e checa o protocolo inteiro,
 * incluindo as regras de segurança, que são as fáceis de quebrar sem perceber.
 *
 *   node tools/test-signaling.mjs
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { io as connect } from "socket.io-client";
import Database from "better-sqlite3";
import { createAccountRepository } from "../server/data/account-repository.js";
import { hashActionToken, hashPassword } from "../server/passwords.js";
import { SessionAuthority } from "../server/auth.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3999;
const PASSWORD = "Segredo-bem-longo";
const SESSION_SECRET = "segredo-de-sessao-do-teste-com-mais-de-32-caracteres";
const URL = `http://localhost:${PORT}`;
const testDirectory = mkdtempSync(join(tmpdir(), "draco-signaling-"));
const databasePath = join(testDirectory, "draco.sqlite");

const seeded = [
  ["11111111-1111-4111-8111-111111111111", "ana@teste.local", "Ana", "ana"],
  ["22222222-2222-4222-8222-222222222222", "bruno@teste.local", "Bruno", "bruno"],
  ["33333333-3333-4333-8333-333333333333", "carla@teste.local", "Carla", "carla"],
  ["44444444-4444-4444-8444-444444444444", "davi@teste.local", "Davi", "davi"],
  ["55555555-5555-4555-8555-555555555555", "elena@teste.local", "Elena", "elena"],
  ["66666666-6666-4666-8666-666666666666", "fabio@teste.local", "Fábio", "fabio", true],
];
const passwordHash = await hashPassword(PASSWORD);
const authority = new SessionAuthority(SESSION_SECRET);
const tokens = {};
const accountRepository = createAccountRepository({ databasePath });
for (const [userId, email, displayName, publicId, isSystemAdmin = false] of seeded) {
  accountRepository.createAccount({
    userId,
    email,
    displayName,
    publicId,
    passwordHash,
    isSystemAdmin,
    verifiedAt: Date.now(),
    color: "#5b6cff",
  });
  const issued = authority.issue(userId, 1);
  tokens[displayName] = issued.token;
  accountRepository.createSession({
    id: issued.sessionId,
    userId,
    tokenHash: hashActionToken(issued.token),
    clientType: "web",
    deviceName: "Teste",
    expiresAt: authority.verify(issued.token).expiresAt,
  });
}
accountRepository.close();

let passed = 0;
let failed = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        esperado ${JSON.stringify(want)}\n        recebido ${JSON.stringify(got)}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera um evento chegar, com prazo: teste que trava não diz onde parou. */
function waitFor(socket, event, timeout = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeout);
    const handler = (payload) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload ?? true);
    };
    socket.on(event, handler);
  });
}

/** Coleta tudo que chegar de um evento durante a janela, pra afirmar ausência também. */
function collect(socket, event) {
  const received = [];
  socket.on(event, (payload) => received.push(payload));
  return received;
}

/**
 * Emite e espera o ack, com prazo. O prazo é o que importa: um handler que
 * esquece de responder, ou um socket que o servidor já derrubou, travaria o teste
 * para sempre em vez de apontar onde parou.
 */
const emit = (socket, event, payload, timeout = 3000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "sem-resposta" }), timeout);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });

const server = spawn(process.execPath, ["server/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_PATH: databasePath,
    PORT: String(PORT),
    SESSION_SECRET,
    ORIGIN: "",
    NODE_ENV: "test",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

const stopServer = () => {
  if (server.exitCode === null && server.signalCode === null) server.kill();
};
process.on("exit", stopServer);

try {
  await sleep(1200);

  // --- entrada e contas ----------------------------------------------------
  const a = connect(URL, { transports: ["websocket"] });
  const b = connect(URL, { transports: ["websocket"] });
  const c = connect(URL, { transports: ["websocket"] });
  // scrypt mais forte e bootstrap do banco podem alongar o primeiro boot em CI.
  await Promise.all([
    waitFor(a, "connect", 10_000),
    waitFor(b, "connect", 10_000),
    waitFor(c, "connect", 10_000),
  ]);

  check("entrada sem sessão é recusada", await emit(a, "identify", {}), {
    ok: false,
    error: "not-authenticated",
  });
  check(
    "credencial ICE é recusada antes da identificação",
    (await emit(a, "ice:get", { refresh: false })).error,
    "not-identified",
  );
  check(
    "token inventado é recusado",
    (await emit(a, "identify", { token: "v1.invalido.invalido" })).error,
    "not-authenticated",
  );

  const joinA = await emit(a, "identify", { token: tokens.Ana });
  const publicSelf = joinA.state.members.find((member) => member.id === seeded[0][0]);
  for (const internal of ["socketId", "sfuRecvSessionId", "systemAdmin", "presenceMode"]) {
    check(`snapshot não expõe ${internal}`, internal in publicSelf, false);
  }
  check("entrada com conta válida", joinA.ok, true);
  check("conta expõe um único ID público", joinA.account?.publicId, "ana");
  check(
    "conta identificada recebe configuração ICE",
    (await emit(a, "ice:get", { refresh: false })).ok,
    true,
  );
  // Não há servidor de demonstração: quem chega não é membro de nada, e o
  // snapshot dessa pessoa vem vazio até ela criar um servidor ou aceitar convite.
  check("quem acaba de chegar não tem servidor nenhum", [joinA.state.guilds, joinA.state.channels], [
    [],
    [],
  ]);
  // O id da pessoa não é o do socket: é ele que sobrevive a uma reconexão.
  check("selfId é uma identidade própria", /^[0-9a-f-]{36}$/.test(joinA.selfId ?? ""), true);
  check("a conta usa um token de sessão assinado", /^v1\.[\w-]+\.[\w-]+$/.test(tokens.Ana), true);
  check("identidade não é o id do socket", joinA.selfId !== a.id, true);
  const idA = joinA.selfId;
  const tokenA = tokens.Ana;

  const memberJoined = waitFor(b, "member:joined");
  const joinB = await emit(b, "identify", { token: tokens.Bruno });
  const joinC = await emit(c, "identify", { token: tokens.Carla });
  const idB = joinB.selfId;
  const idC = joinC.selfId;
  const tokenC = tokens.Carla;
  check("identificar duas vezes é recusado", (await emit(b, "identify", { token: tokens.Bruno })).error, "already-identified");
  void memberJoined;

  // --- um servidor pra conversar --------------------------------------------
  // Sem catálogo padrão, o resto do teste precisa de um servidor de verdade: Ana
  // cria o dela e chama Bruno e Carla por convite, que é o único caminho de
  // entrada que existe.
  const home = await emit(a, "guild:create", { name: "Casa da Ana" });
  check("o primeiro servidor é criado por quem chegou", home.ok, true);
  const homeId = home.guild.id;
  const text = home.state.channels.find((ch) => ch.guildId === homeId && ch.type === "text").id;
  const voice = home.state.channels.find((ch) => ch.guildId === homeId && ch.type === "voice").id;
  const extra = (await emit(a, "channel:create", { guildId: homeId, type: "text", name: "avisos" }))
    .channel.id;

  const homeInvite = await emit(a, "invite:create", { guildId: homeId });
  await emit(b, "invite:accept", { code: homeInvite.code });
  await emit(c, "invite:accept", { code: homeInvite.code });

  const relationshipOnB = waitFor(b, "relationship:update");
  const friendRequest = await emit(a, "friend:request", { publicId: "bruno" });
  check("amizade encontra a pessoa pelo ID público", friendRequest.ok, true);
  const incomingFriend = (await relationshipOnB)?.incomingRequests?.[0];
  check("pedido recebido conserva nome e ID separados", [incomingFriend?.displayName, incomingFriend?.publicId], ["Ana", "ana"]);

  // Visitante entra só pelo convite, sem criar conta e sem poder escrever.
  const underageVisitor = connect(URL, { transports: ["websocket"] });
  await waitFor(underageVisitor, "connect");
  check(
    "visitante menor de idade é recusado",
    (await emit(underageVisitor, "identify", {
      guest: { username: "Visitante menor", inviteCode: homeInvite.code, age: 17 },
    })).error,
    "adult-required",
  );
  underageVisitor.close();

  const visitor = connect(URL, { transports: ["websocket"] });
  await waitFor(visitor, "connect");
  const guestJoin = await emit(visitor, "identify", {
    guest: { username: "Visitante", inviteCode: homeInvite.code, age: 18 },
  });
  check("link permite entrada temporária sem conta", [guestJoin.ok, guestJoin.account?.guest], [true, true]);
  check("visitante vê somente o servidor do convite", guestJoin.state.guilds.map((guild) => guild.id), [homeId]);
  const guestChat = collect(a, "chat:message");
  visitor.emit("chat:send", { channelId: text, content: "não deve aparecer" });
  await sleep(100);
  check("visitante não consegue escrever no chat", guestChat.length, 0);
  check("visitante pode entrar na voz", (await emit(visitor, "voice:join", { channelId: voice })).ok, true);
  visitor.close();
  await sleep(100);

  // Cargos concedem as permissões escolhidas, sem transformar todo membro em dono.
  const role = await emit(a, "role:create", {
    guildId: homeId,
    name: "Organizador",
    color: "#3366FF",
    permissions: ["manage_channels"],
  });
  check("dono cria cargo com permissão", role.role?.name, "Organizador");
  check("membro sem cargo não cria canal", (await emit(c, "channel:create", { guildId: homeId, type: "text", name: "negado" })).error, "missing-permission");
  check("cargo pode ser atribuído a um membro", (await emit(a, "role:assign", { guildId: homeId, userId: joinB.selfId, roleId: role.role.id, assigned: true })).ok, true);
  const teamChannel = await emit(b, "channel:create", { guildId: homeId, type: "text", name: "equipe" });
  check("permissão do cargo libera criar canal", teamChannel.ok, true);

  const secondRole = await emit(a, "role:create", {
    guildId: homeId,
    name: "Moderador",
    color: "#33AA77",
    permissions: ["ban_members"],
  });
  const reorderedRoles = await emit(a, "role:reorder", {
    guildId: homeId,
    orderedIds: [secondRole.role.id, role.role.id],
  });
  check(
    "hierarquia de cargos é persistida pelo servidor",
    reorderedRoles.roles.filter((item) => !item.isDefault).map((item) => item.id),
    [secondRole.role.id, role.role.id],
  );
  check(
    "membro sem permissão não reordena cargos",
    (await emit(c, "role:reorder", { guildId: homeId, orderedIds: [role.role.id, secondRole.role.id] })).error,
    "missing-permission",
  );
  await emit(a, "role:assign", { guildId: homeId, userId: idB, roleId: secondRole.role.id, assigned: true });
  check(
    "nem moderador com banimento pode banir o dono",
    (await emit(b, "member:ban", { guildId: homeId, userId: idA })).error,
    "protected-user",
  );

  const channelOrder = [voice, text, teamChannel.channel.id, extra];
  const reorderedChannels = await emit(a, "channel:reorder", { guildId: homeId, orderedIds: channelOrder });
  check("ordem de canais é persistida pelo servidor", reorderedChannels.channels.map((item) => item.id), channelOrder);
  check(
    "membro sem permissão não reordena canais",
    (await emit(c, "channel:reorder", { guildId: homeId, orderedIds: channelOrder })).error,
    "missing-permission",
  );

  // Mensagem privada para outra conta e para si mesmo.
  const selfThread = await emit(a, "direct:open", { userId: idA });
  check("usuário abre conversa consigo mesmo", selfThread.thread?.peer?.id, idA);
  const selfNote = await emit(a, "direct:send", { threadId: selfThread.thread.id, content: "minha nota" });
  check("usuário envia mensagem para si mesmo", selfNote.ok, true);
  const directOnA = waitFor(a, "direct:message");
  const pairThread = await emit(b, "direct:open", { userId: idA });
  await emit(b, "direct:send", { threadId: pairThread.thread.id, content: "oi no privado" });
  check("DM chega à outra conta", (await directOnA)?.content, "oi no privado");

  // --- chat ----------------------------------------------------------------
  const chatOnB = waitFor(b, "chat:message");
  a.emit("chat:send", { channelId: text, content: "  olá mundo  " });
  const message = await chatOnB;
  check("mensagem chega nos outros", message?.content, "olá mundo");
  check("mensagem traz o autor", message?.username, "Ana");

  const chatInVoice = collect(b, "chat:message");
  a.emit("chat:send", { channelId: voice, content: "isso é canal de voz" });
  a.emit("chat:send", { channelId: text, content: "" });
  a.emit("chat:send", { channelId: "inexistente", content: "oi" });
  await sleep(250);
  check("canal de voz e mensagem vazia não geram chat", chatInVoice.length, 0);

  // --- histórico -----------------------------------------------------------
  // Uma mensagem só no canal: não há passado antes dela, e o servidor precisa
  // dizer isso em vez de devolver uma página vazia como se fosse conteúdo.
  const history = await emit(b, "chat:history", { channelId: text, beforeId: message.id });
  check("histórico responde com a página anterior", [history.ok, history.messages, history.more], [
    true,
    [],
    false,
  ]);
  check(
    "histórico recusa id que não é do canal",
    (await emit(b, "chat:history", { channelId: extra, beforeId: message.id })).error,
    "no-message",
  );
  check(
    "histórico recusa canal de voz",
    (await emit(b, "chat:history", { channelId: voice, beforeId: message.id })).error,
    "no-channel",
  );
  check(
    "histórico recusa pedido sem âncora",
    (await emit(b, "chat:history", { channelId: text })).error,
    "bad-request",
  );

  // Mutação de mensagem sempre usa a identidade do socket, nunca um userId do payload.
  await sleep(1000);
  const chatCreated = await emit(a, "chat:send", { channelId: text, content: "mensagem mutável" });
  check("enviar mensagem responde com o registro persistido", chatCreated.message?.content, "mensagem mutável");
  check("outro autor não edita mensagem", (await emit(b, "chat:edit", { messageId: chatCreated.message.id, content: "invadida" })).error, "missing-permission");
  check("autor edita mensagem", (await emit(a, "chat:edit", { messageId: chatCreated.message.id, content: "mensagem editada" })).message?.content, "mensagem editada");
  const replied = await emit(b, "chat:send", { channelId: text, content: "resposta", replyToId: chatCreated.message.id });
  check("reply referencia a mensagem original", replied.message?.reply?.id, chatCreated.message.id);
  check("reação é normalizada e contada", (await emit(b, "chat:react", { messageId: chatCreated.message.id, emoji: "👍" })).message?.reactions?.[0]?.count, 1);
  check("a mesma reação alterna para removida", (await emit(b, "chat:react", { messageId: chatCreated.message.id, emoji: "👍" })).message?.reactions?.length, 0);
  check("outro autor sem permissão não apaga", (await emit(b, "chat:delete", { messageId: chatCreated.message.id })).error, "missing-permission");
  await sleep(500);
  check("autor faz soft-delete", Boolean((await emit(a, "chat:delete", { messageId: chatCreated.message.id })).message?.deletedAt), true);

  const denied = await emit(a, "channel:permissions", {
    channelId: text,
    operation: "set",
    targetType: "member",
    targetId: idC,
    allow: [],
    deny: ["view_channels"],
  });
  check("owner define overwrite negativo por usuário", denied.ok, true);
  const hiddenChat = collect(c, "chat:message");
  await emit(a, "chat:send", { channelId: text, content: "conteúdo restrito" });
  await sleep(100);
  check("overwrite impede vazamento em tempo real", hiddenChat.length, 0);
  check("overwrite também bloqueia histórico", (await emit(c, "chat:history", { channelId: text, beforeId: message.id })).error, "no-channel");
  await emit(a, "channel:permissions", { channelId: text, operation: "set", targetType: "member", targetId: idC, allow: [], deny: [] });
  check("membro sem permissão não aplica timeout", (await emit(c, "member:timeout", { guildId: homeId, userId: idB, durationMs: 300000 })).error, "missing-permission");

  // --- entrar em voz -------------------------------------------------------
  const joinVoiceA = await emit(a, "voice:join", { channelId: voice });
  check("primeiro a entrar não vê ninguém", [joinVoiceA.ok, joinVoiceA.channelId, joinVoiceA.peers], [
    true,
    voice,
    [],
  ]);
  // Sem credenciais da Cloudflare no ambiente, o servidor manda seguir em malha.
  check("sem SFU configurado o servidor avisa", joinVoiceA.sfu, false);

  const peerJoinedOnA = waitFor(a, "voice:peer-joined");
  const joinVoiceB = await emit(b, "voice:join", { channelId: voice });
  check("segundo a entrar já recebe a lista", joinVoiceB.peers.map((p) => p.username), ["Ana"]);
  check("a lista traz a identidade estável", joinVoiceB.peers.map((p) => p.id), [idA]);
  check("quem estava é avisado do novo", (await peerJoinedOnA)?.member?.username, "Bruno");
  check("canal de texto não serve pra voz", (await emit(a, "voice:join", { channelId: text })).error, "no-channel");

  // --- relay de sinalização ------------------------------------------------
  const signalOnB = waitFor(b, "rtc:signal");
  a.emit("rtc:signal", { to: idB, description: { type: "offer", sdp: "v=0 fake" } });
  const signal = await signalOnB;
  check("sinal é repassado ao destino", signal?.description?.sdp, "v=0 fake");
  check("sinal identifica quem mandou", signal?.from, idA);

  const signalOnC = collect(c, "rtc:signal");
  const junkOnB = collect(b, "rtc:signal");
  a.emit("rtc:signal", { to: idC, description: { type: "offer", sdp: "v=0 intruso" } });
  a.emit("rtc:signal", { to: idB, description: { type: "offer" } });
  a.emit("rtc:signal", { to: idB });
  await sleep(250);
  check("não repassa pra quem está fora do canal de voz", signalOnC.length, 0);
  check("descarta sinal malformado", junkOnB.length, 0);

  // --- eventos do SFU sem credenciais --------------------------------------
  check("sfu:join recusa sem credenciais", (await emit(a, "sfu:join", {})).error, "no-sfu");
  check(
    "sfu:subscribe recusa sem credenciais",
    (await emit(a, "sfu:subscribe", { tracks: [{ memberId: idB, slot: "mic" }] })).error,
    "no-sfu",
  );

  // --- estado de voz -------------------------------------------------------
  const stateOnC = waitFor(c, "member:state");
  a.emit("voice:state", { muted: true, deafened: true, camOn: true, volume: 0.1 });
  const state = await stateOnC;
  check("mute e deafen públicos são replicados", [state?.muted, state?.deafened, state?.camOn], [true, true, true]);
  check("volume individual não vira estado público", Object.hasOwn(state ?? {}, "volume"), false);
  const stateRestored = waitFor(c, "member:state");
  a.emit("voice:state", { muted: false, deafened: false });
  const restored = await stateRestored;
  check("desmutar e tirar deafen atualiza imediatamente", [restored?.muted, restored?.deafened], [false, false]);

  // Espectador só existe depois de abrir uma tela real na mesma call.
  const screenStarted = waitFor(c, "member:state");
  a.emit("voice:state", { screenOn: true });
  await screenStarted;
  const viewerOnA = waitFor(a, "screen:viewers");
  check("participante da call começa a assistir", (await emit(b, "screen:view", { ownerId: idA, watching: true })).ok, true);
  check("lista de espectadores traz a identidade real", (await viewerOnA)?.viewers?.map((viewer) => viewer.id), [idB]);
  check("quem está fora da call não se declara espectador", (await emit(c, "screen:view", { ownerId: idA, watching: true })).error, "not-in-voice");
  const viewerStopped = waitFor(a, "screen:viewers");
  await emit(b, "screen:view", { ownerId: idA, watching: false });
  check("parar de assistir reduz o contador", (await viewerStopped)?.viewers?.length, 0);
  const watchingAgain = waitFor(a, "screen:viewers");
  await emit(b, "screen:view", { ownerId: idA, watching: true });
  await watchingAgain;
  const screenEnded = waitFor(b, "screen:viewers");
  a.emit("voice:state", { screenOn: false });
  check("encerrar a tela limpa todos os espectadores", (await screenEnded)?.viewers?.length, 0);

  // --- reconexão com a mesma identidade ------------------------------------
  const d = connect(URL, { transports: ["websocket"] });
  await waitFor(d, "connect");
  const rejoin = await emit(d, "identify", { token: tokenC });
  check("o token devolve a mesma identidade", rejoin.selfId, idC);
  const onlineIds = rejoin.state.members.map((m) => m.id).sort();
  check("reconectar não duplica ninguém na lista", onlineIds, [idA, idB, idC].sort());
  d.close();
  await sleep(250);

  // --- identidade é do servidor, não do cliente ----------------------------
  // O ataque que isto fecha: conhecer o id de alguém era suficiente pra entrar
  // como essa pessoa. Agora sem a assinatura o servidor emite outra identidade.
  const e = connect(URL, { transports: ["websocket"] });
  await waitFor(e, "connect");
  const impostor = await emit(e, "identify", { userId: idA });
  check("mandar o userId de outra pessoa não assume a identidade dela", impostor.error, "not-authenticated");
  const forged = `${tokenA.split(".").slice(0, 2).join(".")}.assinaturafalsa`;
  const f = connect(URL, { transports: ["websocket"] });
  await waitFor(f, "connect");
  const tampered = await emit(f, "identify", { token: forged });
  check("token com assinatura trocada não vale", tampered.error, "not-authenticated");
  e.close();
  f.close();
  await sleep(250);

  // --- validação de payload ------------------------------------------------
  const junkSignals = collect(b, "rtc:signal");
  a.emit("rtc:signal", { to: idB, description: { type: "offer", sdp: "x".repeat(70_000) } });
  a.emit("rtc:signal", { to: idB, candidate: { candidate: 42 } });
  await sleep(250);
  check("SDP gigante e candidato malformado são descartados", junkSignals.length, 0);

  // --- saída ---------------------------------------------------------------
  a.emit("voice:state", { screenOn: true });
  await sleep(20);
  await emit(b, "screen:view", { ownerId: idA, watching: true });
  const viewersAfterAbruptLeave = waitFor(a, "screen:viewers");
  const peerLeftOnA = waitFor(a, "voice:peer-left");
  const memberLeftOnA = waitFor(a, "member:left");
  b.close();
  check("saída avisa os peers da call", (await peerLeftOnA)?.memberId, idB);
  check("saída abrupta não deixa espectador fantasma", (await viewersAfterAbruptLeave)?.viewers?.length, 0);
  check("saída avisa a lista de membros", (await memberLeftOnA)?.id, idB);

  // --- rate limit ----------------------------------------------------------
  const flood = collect(c, "chat:message");
  for (let i = 0; i < 30; i += 1) a.emit("chat:send", { channelId: text, content: `spam ${i}` });
  await sleep(400);
  check("rate limit corta enxurrada de chat", flood.length <= 8, true);

  // --- servidores, canais, convites e banimentos ----------------------------
  // A ordem importa: cada bloco usa o que o anterior criou. Dois sockets novos
  // porque os antigos não servem: `c` foi derrubado quando `d` reassumiu a
  // identidade de Carla, e quem testa "não sou membro" tem que continuar de fora.
  const g = connect(URL, { transports: ["websocket"] });
  const h = connect(URL, { transports: ["websocket"] });
  await Promise.all([waitFor(g, "connect"), waitFor(h, "connect")]);
  const joinG = await emit(g, "identify", { token: tokens.Davi });
  await emit(h, "identify", { token: tokens.Elena });
  const idG = joinG.selfId;

  check(
    "quem não é membro não cria canal em servidor alheio",
    (await emit(h, "channel:create", { guildId: homeId, type: "text", name: "x" })).error,
    "not-member",
  );

  const created = await emit(a, "guild:create", { name: "Servidor de Teste" });
  check("criar servidor devolve o servidor e o estado", [created.ok, created.guild?.name], [
    true,
    "Servidor de Teste",
  ]);
  const guildId = created.guild.id;
  check("quem cria é o dono", created.guild.ownerId, idA);
  // Criar o segundo não solta o primeiro: quem tem dois servidores continua nos dois.
  check(
    "o servidor anterior continua no estado de quem criou outro",
    created.state.guilds.map((guild) => guild.id).includes(homeId),
    true,
  );
  // Dois canais de largada: um servidor sem canal nenhum abre numa tela vazia.
  const mine = created.state.channels.filter((channel) => channel.guildId === guildId);
  check("o servidor novo nasce com um canal de texto e um de voz", mine.map((ch) => ch.type).sort(), [
    "text",
    "voice",
  ]);

  // Privado por padrão: quem não foi convidado não administra nem vê.
  check(
    "quem não é membro não administra",
    (await emit(h, "guild:admin", { guildId })).error,
    "not-member",
  );

  const channelCreated = waitFor(a, "channel:created");
  const newChannel = await emit(a, "channel:create", {
    guildId,
    type: "text",
    name: "  Assuntos  Gerais!! ",
  });
  check("nome de canal de texto é normalizado", newChannel.channel?.name, "assuntos-gerais");
  check("criar canal avisa quem é do servidor", (await channelCreated)?.channel?.id, newChannel.channel.id);

  const voiceOnly = mine.find((channel) => channel.type === "voice");
  check(
    "o último canal de voz não pode ser apagado",
    (await emit(a, "channel:delete", { channelId: voiceOnly.id })).error,
    "last-channel",
  );
  check(
    "canal extra pode ser apagado",
    (await emit(a, "channel:delete", { channelId: newChannel.channel.id })).ok,
    true,
  );

  // Convite de uso único: a segunda pessoa a tentar não entra.
  const invite = await emit(a, "invite:create", { guildId, maxUses: 1 });
  check("convite nasce com código", /^[BCDFGHJKLMNPQRSTVWXYZ23456789]{10}$/.test(invite.code ?? ""), true);

  const accepted = await emit(g, "invite:accept", { code: invite.code });
  check("convite aceito entra no servidor", [accepted.ok, accepted.guildId], [true, guildId]);
  check(
    "o servidor novo aparece no estado de quem entrou",
    accepted.state.guilds.some((guild) => guild.id === guildId),
    true,
  );
  check(
    "membro comum não altera o nome do servidor",
    (await emit(g, "guild:update", { guildId, name: "Nome indevido" })).error,
    "not-owner",
  );
  const renamedOnMember = waitFor(g, "guild:updated");
  const renamedGuild = await emit(a, "guild:update", { guildId, name: "Servidor Renomeado" });
  check("dono altera o nome do servidor", [renamedGuild.guild?.name, renamedGuild.guild?.initials], ["Servidor Renomeado", "SR"]);
  check("novo nome chega aos membros imediatamente", (await renamedOnMember)?.guild?.name, "Servidor Renomeado");

  const profileOnMember = waitFor(g, "member:state");
  const renamedProfile = await emit(a, "profile:update", {
    displayName: "Nome Repetido",
    publicId: "ana.nova",
  });
  check("perfil separa nome exibido do ID único", [renamedProfile.account?.username, renamedProfile.account?.publicId], ["Nome Repetido", "ana.nova"]);
  check("perfil atualizado chega ao servidor em comum", [(await profileOnMember)?.username, renamedProfile.member?.publicId], ["Nome Repetido", "ana.nova"]);
  const renamedDirect = await emit(a, "direct:react", { messageId: selfNote.message.id, emoji: "👍" });
  check("mensagem privada continua mostrando o nome exibido", renamedDirect.message?.username, "Nome Repetido");
  check(
    "outra pessoa não assume um ID existente",
    (await emit(g, "profile:update", { displayName: "Nome Repetido", publicId: "ana.nova" })).error,
    "public-id-taken",
  );
  check(
    "convite de uso único não serve duas vezes",
    (await emit(h, "invite:accept", { code: invite.code })).error,
    "invite-used-up",
  );
  check(
    "código inventado é recusado",
    (await emit(h, "invite:accept", { code: "ZZZZZZZZZZ" })).error,
    "invite-invalid",
  );

  // Expulsar remove inclusive da voz, mas preserva o direito de voltar.
  const openInvite = await emit(a, "invite:create", { guildId });
  await emit(a, "voice:join", { channelId: voiceOnly.id });
  await emit(g, "voice:join", { channelId: voiceOnly.id });
  const kickedFromVoice = waitFor(g, "voice:moderated");
  check("expulsar remove do elenco", (await emit(a, "member:kick", { guildId, userId: idG, reason: "teste de kick" })).ok, true);
  check("kick remove da call de forma autoritativa", (await kickedFromVoice)?.reason, "kick");
  check("kick permite voltar com convite válido", (await emit(g, "invite:accept", { code: openInvite.code })).ok, true);

  // Banir tira do servidor e da voz, registra o ator e impede convite válido.
  await emit(g, "voice:join", { channelId: voiceOnly.id });
  const bannedFromVoice = waitFor(g, "voice:moderated");
  const banReply = await emit(a, "member:ban", { guildId, userId: idG, reason: "teste de ban" });
  check("banir remove do elenco", banReply.ok, true);
  check("ban remove da call de forma autoritativa", (await bannedFromVoice)?.reason, "ban");
  check("ban registra moderador, data e motivo", [banReply.bans?.[0]?.moderatorId, banReply.bans?.[0]?.reason, Number.isFinite(banReply.bans?.[0]?.createdAt)], [idA, "teste de ban", true]);
  check(
    "quem foi banido não volta nem com convite válido",
    (await emit(g, "invite:accept", { code: openInvite.code })).error,
    "banned",
  );
  check("desbanir libera a volta", (await emit(a, "member:unban", { guildId, userId: idG })).ok, true);
  check("desbanir não adiciona o usuário automaticamente", (await emit(a, "guild:admin", { guildId })).roster.some((entry) => entry.id === idG), false);
  check(
    "depois de readmitido o convite funciona",
    (await emit(g, "invite:accept", { code: openInvite.code })).ok,
    true,
  );

  check(
    "quem não é dono não apaga canal",
    (await emit(g, "channel:delete", { channelId: voiceOnly.id })).error,
    "missing-permission",
  );
  check(
    "membro sem liderança não exclui o servidor",
    (await emit(g, "guild:delete", { guildId })).error,
    "not-owner",
  );
  check("quem não é dono pode sair", (await emit(g, "guild:leave", { guildId })).ok, true);
  check(
    "o dono não sai do próprio servidor",
    (await emit(a, "guild:leave", { guildId })).error,
    "is-owner",
  );

  const panel = await emit(a, "guild:admin", { guildId });
  check("o painel do dono traz elenco e convites", [panel.ok, panel.owner], [true, true]);
  check(
    "kick, ban e unban entram no audit log existente",
    ["member.kick", "member.ban", "member.unban"].every((action) => panel.auditLog.some((entry) => entry.action === action)),
    true,
  );

  // Exclusão é a saída definitiva do dono. Todos recebem o evento, a call fecha
  // e o snapshot devolvido já não contém o servidor nem seu conteúdo.
  await emit(g, "invite:accept", { code: openInvite.code });
  await emit(g, "voice:join", { channelId: voiceOnly.id });
  const globalAdmin = connect(URL, { transports: ["websocket"] });
  await waitFor(globalAdmin, "connect");
  await emit(globalAdmin, "identify", { token: tokens.Fábio });
  check(
    "administrador global sem liderança não exclui o servidor",
    (await emit(globalAdmin, "guild:delete", { guildId })).error,
    "not-owner",
  );
  const deletedOnMember = waitFor(g, "guild:deleted");
  const voiceClosedOnMember = waitFor(g, "voice:channel-closed");
  const deleted = await emit(a, "guild:delete", { guildId });
  check("dono exclui o servidor", deleted.ok, true);
  check("exclusão avisa os demais membros", (await deletedOnMember)?.name, "Servidor Renomeado");
  check("exclusão encerra a call do servidor", (await voiceClosedOnMember)?.channelId, voiceOnly.id);
  check("snapshot do dono não conserva o servidor excluído", deleted.state.guilds.some((guild) => guild.id === guildId), false);
  check("servidor excluído não pode mais ser administrado", (await emit(g, "guild:admin", { guildId })).error, "not-member");

  const persisted = new Database(databasePath, { readonly: true, fileMustExist: true });
  const relatedTables = ["guild_members", "roles", "channels", "guild_settings", "invites", "bans", "member_timeouts", "audit_log"];
  const remaining = {
    guild: persisted.prepare("SELECT COUNT(*) AS count FROM guilds WHERE id = ?").get(guildId).count,
    related: relatedTables.reduce(
      (total, table) => total + persisted.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE guild_id = ?`).get(guildId).count,
      0,
    ),
    foreignKeyViolations: persisted.pragma("foreign_key_check").length,
  };
  persisted.close();
  check("exclusão também remove os dados persistidos sem órfãos", remaining, {
    guild: 0,
    related: 0,
    foreignKeyViolations: 0,
  });
  globalAdmin.close();

  a.close();
  g.close();
  h.close();
} catch (error) {
  failed += 1;
  console.log(`FAIL  exceção inesperada: ${error.stack}`);
}

console.log(`\n${passed} passaram, ${failed} falharam`);
stopServer();
if (server.exitCode === null && server.signalCode === null) await once(server, "exit");
process.off("exit", stopServer);

const temporaryRoot = resolve(tmpdir());
const resolvedDirectory = resolve(testDirectory);
if (
  resolve(dirname(resolvedDirectory)) === temporaryRoot &&
  basename(resolvedDirectory).startsWith("draco-signaling-")
) {
  rmSync(resolvedDirectory, { recursive: true, force: true });
}
process.exitCode = failed === 0 ? 0 : 1;
