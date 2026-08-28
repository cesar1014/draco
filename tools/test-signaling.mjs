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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3999;
const PASSWORD = "segredo";
const URL = `http://localhost:${PORT}`;
const testDirectory = mkdtempSync(join(tmpdir(), "draco-signaling-"));
const databasePath = join(testDirectory, "draco.sqlite");

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
    ROOM_PASSWORD: PASSWORD,
    ORIGIN: "",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

const stopServer = () => {
  if (server.exitCode === null && server.signalCode === null) server.kill();
};
process.on("exit", stopServer);

try {
  await sleep(1200);

  // --- entrada e senha -----------------------------------------------------
  const a = connect(URL, { transports: ["websocket"] });
  const b = connect(URL, { transports: ["websocket"] });
  const c = connect(URL, { transports: ["websocket"] });
  await Promise.all([waitFor(a, "connect"), waitFor(b, "connect"), waitFor(c, "connect")]);

  check("senha errada é recusada", await emit(a, "identify", { username: "Ana", password: "errada" }), {
    ok: false,
    error: "bad-password",
  });
  check(
    "nome curto é recusado",
    (await emit(a, "identify", { username: "x", password: PASSWORD })).error,
    "bad-username",
  );

  const joinA = await emit(a, "identify", { username: "Ana", password: PASSWORD });
  check("entrada com senha certa", joinA.ok, true);
  check("snapshot traz os canais", joinA.state.channels.length > 0, true);
  // O id da pessoa não é o do socket: é ele que sobrevive a uma reconexão.
  check("selfId é uma identidade própria", /^[0-9a-f-]{36}$/.test(joinA.selfId ?? ""), true);
  check("a entrada devolve um token de sessão assinado", /^v1\.[\w-]+\.[\w-]+$/.test(joinA.token ?? ""), true);
  check("identidade não é o id do socket", joinA.selfId !== a.id, true);
  const idA = joinA.selfId;
  const tokenA = joinA.token;

  const memberJoined = waitFor(b, "member:joined");
  const joinB = await emit(b, "identify", { username: "Bruno", password: PASSWORD });
  const joinC = await emit(c, "identify", { username: "Carla", password: PASSWORD });
  const idB = joinB.selfId;
  const idC = joinC.selfId;
  const tokenC = joinC.token;
  check("identificar duas vezes é recusado", (await emit(b, "identify", { username: "Bruno2", password: PASSWORD })).error, "already-identified");
  void memberJoined;

  // --- chat ----------------------------------------------------------------
  const chatOnB = waitFor(b, "chat:message");
  a.emit("chat:send", { channelId: "t-geral", content: "  olá mundo  " });
  const message = await chatOnB;
  check("mensagem chega nos outros", message?.content, "olá mundo");
  check("mensagem traz o autor", message?.username, "Ana");

  const chatInVoice = collect(b, "chat:message");
  a.emit("chat:send", { channelId: "v-geral", content: "isso é canal de voz" });
  a.emit("chat:send", { channelId: "t-geral", content: "" });
  a.emit("chat:send", { channelId: "inexistente", content: "oi" });
  await sleep(250);
  check("canal de voz e mensagem vazia não geram chat", chatInVoice.length, 0);

  // --- histórico -----------------------------------------------------------
  // Uma mensagem só no canal: não há passado antes dela, e o servidor precisa
  // dizer isso em vez de devolver uma página vazia como se fosse conteúdo.
  const history = await emit(b, "chat:history", { channelId: "t-geral", beforeId: message.id });
  check("histórico responde com a página anterior", [history.ok, history.messages, history.more], [
    true,
    [],
    false,
  ]);
  check(
    "histórico recusa id que não é do canal",
    (await emit(b, "chat:history", { channelId: "t-avisos", beforeId: message.id })).error,
    "no-message",
  );
  check(
    "histórico recusa canal de voz",
    (await emit(b, "chat:history", { channelId: "v-geral", beforeId: message.id })).error,
    "no-channel",
  );
  check(
    "histórico recusa pedido sem âncora",
    (await emit(b, "chat:history", { channelId: "t-geral" })).error,
    "bad-request",
  );

  // --- entrar em voz -------------------------------------------------------
  const joinVoiceA = await emit(a, "voice:join", { channelId: "v-geral" });
  check("primeiro a entrar não vê ninguém", [joinVoiceA.ok, joinVoiceA.channelId, joinVoiceA.peers], [
    true,
    "v-geral",
    [],
  ]);
  // Sem credenciais da Cloudflare no ambiente, o servidor manda seguir em malha.
  check("sem SFU configurado o servidor avisa", joinVoiceA.sfu, false);

  const peerJoinedOnA = waitFor(a, "voice:peer-joined");
  const joinVoiceB = await emit(b, "voice:join", { channelId: "v-geral" });
  check("segundo a entrar já recebe a lista", joinVoiceB.peers.map((p) => p.username), ["Ana"]);
  check("a lista traz a identidade estável", joinVoiceB.peers.map((p) => p.id), [idA]);
  check("quem estava é avisado do novo", (await peerJoinedOnA)?.member?.username, "Bruno");
  check("canal de texto não serve pra voz", (await emit(a, "voice:join", { channelId: "t-geral" })).error, "no-channel");

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
  a.emit("voice:state", { muted: true, camOn: true });
  const state = await stateOnC;
  check("estado de voz replica pra quem não está na call", [state?.muted, state?.camOn], [true, true]);

  // --- reconexão com a mesma identidade ------------------------------------
  const d = connect(URL, { transports: ["websocket"] });
  await waitFor(d, "connect");
  const rejoin = await emit(d, "identify", { username: "Carla", password: PASSWORD, token: tokenC });
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
  const impostor = await emit(e, "identify", { username: "Falsa", password: PASSWORD, userId: idA });
  check("mandar o userId de outra pessoa não assume a identidade dela", impostor.selfId !== idA, true);
  const forged = `${tokenA.split(".").slice(0, 2).join(".")}.assinaturafalsa`;
  const f = connect(URL, { transports: ["websocket"] });
  await waitFor(f, "connect");
  const tampered = await emit(f, "identify", { username: "Falsa2", password: PASSWORD, token: forged });
  check("token com assinatura trocada não vale", tampered.selfId !== idA, true);
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
  const peerLeftOnA = waitFor(a, "voice:peer-left");
  const memberLeftOnA = waitFor(a, "member:left");
  b.close();
  check("saída avisa os peers da call", (await peerLeftOnA)?.memberId, idB);
  check("saída avisa a lista de membros", (await memberLeftOnA)?.id, idB);

  // --- rate limit ----------------------------------------------------------
  const flood = collect(c, "chat:message");
  for (let i = 0; i < 30; i += 1) a.emit("chat:send", { channelId: "t-geral", content: `spam ${i}` });
  await sleep(400);
  check("rate limit corta enxurrada de chat", flood.length <= 8, true);

  // --- servidores, canais, convites e banimentos ----------------------------
  // A ordem importa: cada bloco usa o que o anterior criou. Dois sockets novos
  // porque os antigos não servem: `c` foi derrubado quando `d` reassumiu a
  // identidade de Carla, e quem testa "não sou membro" tem que continuar de fora.
  const g = connect(URL, { transports: ["websocket"] });
  const h = connect(URL, { transports: ["websocket"] });
  await Promise.all([waitFor(g, "connect"), waitFor(h, "connect")]);
  const joinG = await emit(g, "identify", { username: "Davi", password: PASSWORD });
  await emit(h, "identify", { username: "Elena", password: PASSWORD });
  const idG = joinG.selfId;

  const defaultChannels = joinA.state.channels.length;
  check(
    "servidor do catálogo padrão não aceita canal novo",
    (await emit(a, "channel:create", { guildId: "g-main", type: "text", name: "x" })).error,
    "default-guild",
  );

  const created = await emit(a, "guild:create", { name: "Servidor de Teste" });
  check("criar servidor devolve o servidor e o estado", [created.ok, created.guild?.name], [
    true,
    "Servidor de Teste",
  ]);
  const guildId = created.guild.id;
  check("quem cria é o dono", created.guild.ownerId, idA);
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
    "convite de uso único não serve duas vezes",
    (await emit(h, "invite:accept", { code: invite.code })).error,
    "invite-used-up",
  );
  check(
    "código inventado é recusado",
    (await emit(h, "invite:accept", { code: "ZZZZZZZZZZ" })).error,
    "invite-invalid",
  );

  // Banir tira do servidor e impede a volta pelo mesmo convite.
  const openInvite = await emit(a, "invite:create", { guildId });
  check("banir remove do elenco", (await emit(a, "member:ban", { guildId, userId: idG })).ok, true);
  check(
    "quem foi banido não volta nem com convite válido",
    (await emit(g, "invite:accept", { code: openInvite.code })).error,
    "banned",
  );
  check("readmitir libera a volta", (await emit(a, "member:unban", { guildId, userId: idG })).ok, true);
  check(
    "depois de readmitido o convite funciona",
    (await emit(g, "invite:accept", { code: openInvite.code })).ok,
    true,
  );

  check(
    "quem não é dono não apaga canal",
    (await emit(g, "channel:delete", { channelId: voiceOnly.id })).error,
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
  // O catálogo padrão continua de todo mundo: nada disso mexeu nele.
  check("o servidor padrão segue intacto", joinA.state.channels.length, defaultChannels);

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
