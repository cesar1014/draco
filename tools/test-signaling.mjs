/**
 * Teste de integração da sinalização. Sobe o servidor num porta própria, conecta
 * clientes de verdade via socket.io-client e checa o protocolo inteiro —
 * incluindo as regras de segurança, que são as fáceis de quebrar sem perceber.
 *
 *   node tools/test-signaling.mjs
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { io as connect } from "socket.io-client";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3999;
const PASSWORD = "segredo";
const URL = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        esperado ${JSON.stringify(want)}\n        recebido ${JSON.stringify(got)}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera um evento chegar, com prazo — teste que trava é pior que teste que falha. */
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

const emit = (socket, event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, (response) => resolve(response)));

const server = spawn(process.execPath, ["server/index.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), ROOM_PASSWORD: PASSWORD, ORIGIN: "" },
  stdio: ["ignore", "ignore", "inherit"],
});

const shutdown = () => server.kill();
process.on("exit", shutdown);

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
  check("selfId volta pro cliente", joinA.selfId === a.id, true);

  const memberJoined = waitFor(b, "member:joined");
  await emit(b, "identify", { username: "Bruno", password: PASSWORD });
  await emit(c, "identify", { username: "Carla", password: PASSWORD });
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

  // --- entrar em voz -------------------------------------------------------
  const joinVoiceA = await emit(a, "voice:join", { channelId: "v-geral" });
  check("primeiro a entrar não vê ninguém", joinVoiceA, { ok: true, channelId: "v-geral", peers: [] });

  const peerJoinedOnA = waitFor(a, "voice:peer-joined");
  const joinVoiceB = await emit(b, "voice:join", { channelId: "v-geral" });
  check("segundo a entrar já recebe a lista", joinVoiceB.peers.map((p) => p.username), ["Ana"]);
  check("quem estava é avisado do novo", (await peerJoinedOnA)?.member?.username, "Bruno");
  check("canal de texto não serve pra voz", (await emit(a, "voice:join", { channelId: "t-geral" })).error, "no-channel");

  // --- relay de sinalização ------------------------------------------------
  const signalOnB = waitFor(b, "rtc:signal");
  a.emit("rtc:signal", { to: b.id, description: { type: "offer", sdp: "v=0 fake" } });
  const signal = await signalOnB;
  check("sinal é repassado ao destino", signal?.description?.sdp, "v=0 fake");
  check("sinal identifica quem mandou", signal?.from, a.id);

  const signalOnC = collect(c, "rtc:signal");
  const junkOnB = collect(b, "rtc:signal");
  a.emit("rtc:signal", { to: c.id, description: { type: "offer", sdp: "v=0 intruso" } });
  a.emit("rtc:signal", { to: b.id, description: { type: "offer" } });
  a.emit("rtc:signal", { to: b.id });
  await sleep(250);
  check("não repassa pra quem está fora do canal de voz", signalOnC.length, 0);
  check("descarta sinal malformado", junkOnB.length, 0);

  // --- estado de voz -------------------------------------------------------
  const stateOnC = waitFor(c, "member:state");
  a.emit("voice:state", { muted: true, camOn: true });
  const state = await stateOnC;
  check("estado de voz replica pra quem não está na call", [state?.muted, state?.camOn], [true, true]);

  // --- saída ---------------------------------------------------------------
  const peerLeftOnA = waitFor(a, "voice:peer-left");
  const memberLeftOnA = waitFor(a, "member:left");
  // O id tem que ser lido antes do close: o socket.io-client zera `.id` ao cair.
  const bId = b.id;
  b.close();
  check("saída avisa os peers da call", (await peerLeftOnA)?.memberId, bId);
  check("saída avisa a lista de membros", (await memberLeftOnA)?.id, bId);

  // --- rate limit ----------------------------------------------------------
  const flood = collect(c, "chat:message");
  for (let i = 0; i < 30; i += 1) a.emit("chat:send", { channelId: "t-geral", content: `spam ${i}` });
  await sleep(400);
  check("rate limit corta enxurrada de chat", flood.length <= 8, true);

  a.close();
  c.close();
} catch (error) {
  failed += 1;
  console.log(`FAIL  exceção inesperada: ${error.stack}`);
}

console.log(`\n${passed} passaram, ${failed} falharam`);
server.kill();
process.exit(failed === 0 ? 0 : 1);
