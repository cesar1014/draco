/**
 * Ciclo de vida das trilhas publicadas no SFU, e o som do sistema junto com a tela.
 *
 * O defeito que este teste existe pra impedir é específico e chato de achar à
 * mão: ligar a câmera, desligar, esperar, ligar de novo, e a imagem não chegar do
 * outro lado — sem erro nenhum, porque o `replaceTrack` "deu certo" numa
 * publicação que o SFU já tinha descartado.
 *
 * A segunda metade cobre o outro defeito da mesma família: compartilhar a tela
 * inteira com o som marcado e a transmissão começar muda, porque o Windows recusa
 * o loopback junto de uma fonte `screen:` em algumas configurações.
 *
 * `SfuEngine` e `MediaManager` são código de navegador, então aqui eles são
 * compilados pelo esbuild e rodam contra um `RTCPeerConnection` e um
 * `navigator.mediaDevices` de mentira que registram o que foi pedido. O que se
 * afirma não é o SDP: é quantas publicações e quantas capturas foram feitas, e
 * quando.
 *
 *   node tools/test-media.mjs
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;

async function test(label, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}\n        ${error.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Silencia o console durante um trecho. Os casos de recusa fazem o motor
 * registrar a falha, que é o comportamento certo, e a pilha de erro de um módulo
 * carregado por data URL ocupa a saída inteira do teste.
 */
async function quiet(run) {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    await run();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

/** Compila o motor com as dependências dele, resolvendo o alias `@` do Vite. */
async function loadEngine() {
  return (await bundle(join(root, "client", "src", "rtc", "SfuEngine.ts"))).SfuEngine;
}

/**
 * Compila um módulo do cliente e o importa. O `?url` do worklet de denoise vira
 * texto vazio: aqui ninguém abre `AudioContext`, e o esbuild não sabe resolver o
 * sufixo que é do Vite.
 */
async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    alias: { "@": join(root, "client", "src") },
    plugins: [
      {
        name: "vite-url-suffix",
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "url" }));
          builder.onLoad({ filter: /.*/, namespace: "url" }, () => ({
            contents: 'export default "";',
            loader: "js",
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

// --- WebRTC de mentira -------------------------------------------------------

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = "live";
    this.muted = false;
    this.contentHint = "";
  }
  stop() {
    this.readyState = "ended";
  }
}

class FakeTransceiver {
  constructor(mid, track) {
    this.mid = mid;
    this.currentDirection = "sendonly";
    this.direction = "sendonly";
    this.sender = {
      track,
      replaceTrack: async (next) => {
        if (this.currentDirection === "stopped") throw new Error("transceiver encerrado");
        this.sender.track = next;
      },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {},
    };
    this.receiver = { track: new FakeTrack(track?.kind ?? "audio") };
  }
  stop() {
    this.currentDirection = "stopped";
  }
}

class FakePeerConnection {
  static instances = [];

  constructor() {
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.localDescription = null;
    this.remoteDescription = null;
    this.transceivers = [];
    this.offers = 0;
    this.iceRestarts = 0;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.ontrack = null;
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(track) {
    const transceiver = new FakeTransceiver(String(this.transceivers.length), track);
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers() {
    return this.transceivers;
  }

  async createOffer(options) {
    this.offers += 1;
    if (options?.iceRestart) this.iceRestarts += 1;
    return { type: "offer", sdp: `v=0 offer-${this.offers}` };
  }

  async createAnswer() {
    return { type: "answer", sdp: "v=0 answer" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async getStats() {
    return new Map();
  }

  close() {
    this.signalingState = "closed";
  }

  /** Dispara a transição como o navegador faria, pro motor reagir. */
  setConnectionState(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  setIceState(state) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

/** Transporte que conta o que o motor pediu ao servidor, e pode recusar o que se pedir. */
function transportWith(overrides = {}) {
  const calls = { join: 0, publish: [], subscribe: [], renegotiate: [] };
  const state = { rejectPublish: false, stale: false, acceptRenegotiate: true, ...overrides };
  return {
    calls,
    state,
    join: async () => {
      calls.join += 1;
      return true;
    },
    publish: async (_description, tracks) => {
      calls.publish.push(tracks.map((entry) => entry.slot));
      if (state.rejectPublish) return { description: null, stale: state.stale };
      return { description: { type: "answer", sdp: "v=0 sfu" }, stale: false };
    },
    subscribe: async (refs) => {
      calls.subscribe.push(refs.map((ref) => `${ref.memberId}|${ref.slot}`));
      return { description: null, tracks: [] };
    },
    renegotiate: async (role) => {
      calls.renegotiate.push(role);
      return state.acceptRenegotiate;
    },
  };
}

const SfuEngine = await loadEngine();

globalThis.RTCPeerConnection = FakePeerConnection;
globalThis.MediaStream = class {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  addTrack(track) {
    this.tracks.push(track);
  }
  removeTrack(track) {
    this.tracks = this.tracks.filter((item) => item !== track);
  }
};

function makeEngine(transport, options = {}) {
  FakePeerConnection.instances = [];
  const failures = [];
  const engine = new SfuEngine({
    configuration: {},
    transport,
    onRemoteTrack: () => {},
    onFailure: (reason) => failures.push(reason),
    ...options,
  });
  const [send, recv] = FakePeerConnection.instances;
  return { engine, send, recv, failures };
}

await test("desligar e religar a câmera republica em vez de reusar a publicação morta", async () => {
  const transport = transportWith();
  const { engine, send } = makeEngine(transport);

  await engine.setLocalTrack("mic", new FakeTrack("audio"));
  await engine.setLocalTrack("camera", new FakeTrack("video"));
  assert.deepEqual(transport.calls.publish, [["mic"], ["camera"]]);

  // Desligar é `replaceTrack(null)`: a publicação continua viva e não custa
  // negociação, que é o caminho barato de mutar e desmutar.
  await engine.setLocalTrack("camera", null);
  assert.equal(transport.calls.publish.length, 2, "desligar não republica");

  await engine.setLocalTrack("camera", new FakeTrack("video"));
  assert.equal(transport.calls.publish.length, 2, "religar numa publicação viva também não");

  // Agora o transporte de envio cai: toda publicação deixa de valer.
  send.setConnectionState("failed");
  await engine.setLocalTrack("camera", null);
  await engine.setLocalTrack("camera", new FakeTrack("video"));
  assert.deepEqual(
    transport.calls.publish.at(-1),
    ["mic", "camera"],
    "depois da queda as duas trilhas sobem de novo",
  );
});

await test("transceiver encerrado pelo navegador força republicação", async () => {
  const transport = transportWith();
  const { engine, send } = makeEngine(transport);

  await engine.setLocalTrack("screen", new FakeTrack("video"));
  assert.equal(transport.calls.publish.length, 1);

  // A pessoa encerrou a captura pela barra do Windows e o transceiver morreu.
  send.getTransceivers()[0].stop();
  await engine.setLocalTrack("screen", new FakeTrack("video"));
  assert.equal(transport.calls.publish.length, 2, "a tela volta com publicação nova");
});

await test("liga e desliga a tela cinco vezes sem acumular publicação", async () => {
  const transport = transportWith();
  const { engine } = makeEngine(transport);

  for (let round = 0; round < 5; round += 1) {
    await engine.setLocalTrack("screen", new FakeTrack("video"));
    await engine.setLocalTrack("screen", null);
  }
  assert.equal(transport.calls.publish.length, 1, "uma publicação serve pras cinco voltas");
});

await test("recusa do SFU avisa o dono e invalida o que estava publicado", async () => {
  const transport = transportWith({ rejectPublish: true });
  const { engine, failures } = makeEngine(transport);

  await quiet(async () => {
    await engine.setLocalTrack("mic", new FakeTrack("audio"));
    await sleep(20);
  });
  assert.deepEqual(failures, ["o servidor de mídia recusou a transmissão"]);
});

await test("sessão trocada no meio da publicação é relatada como substituição", async () => {
  const transport = transportWith({ rejectPublish: true, stale: true });
  const { engine, failures } = makeEngine(transport);

  await quiet(async () => {
    await engine.setLocalTrack("mic", new FakeTrack("audio"));
    await sleep(20);
  });
  assert.deepEqual(failures, ["a sessão de mídia foi substituída"]);
});

await test("ICE que falha reinicia na conexão certa, com teto de tentativas", async () => {
  const transport = transportWith();
  const { engine, send, failures } = makeEngine(transport);

  await engine.setLocalTrack("mic", new FakeTrack("audio"));
  const before = send.iceRestarts;

  send.setIceState("failed");
  await sleep(20);
  assert.equal(send.iceRestarts, before + 1, "a primeira falha tenta ICE novo");
  assert.deepEqual(transport.calls.renegotiate, ["send"], "o ICE do envio vai pra sessão de envio");

  send.setIceState("failed");
  await sleep(20);
  assert.equal(send.iceRestarts, before + 2);

  send.setIceState("failed");
  await sleep(20);
  assert.equal(send.iceRestarts, before + 2, "o teto impede o laço de reinícios");
  assert.deepEqual(failures, ["envio não reconectou"]);
});

await test("ICE apenas desconectado espera antes de agir", async () => {
  const transport = transportWith();
  const { engine, send } = makeEngine(transport);

  await engine.setLocalTrack("mic", new FakeTrack("audio"));
  const before = send.iceRestarts;

  send.setIceState("disconnected");
  await sleep(30);
  assert.equal(send.iceRestarts, before, "não reinicia de imediato");

  // Voltou sozinho, que é o caso comum numa troca de rede.
  send.setIceState("connected");
  await sleep(30);
  assert.equal(send.iceRestarts, before, "e não reinicia depois de voltar");
});

await test("assinatura de quem reconectou troca junto com a sessão", async () => {
  const transport = transportWith();
  const { engine } = makeEngine(transport);

  engine.syncRemote([{ memberId: "alguem", slot: "camera", sessionId: "s1" }]);
  await sleep(20);
  assert.deepEqual(transport.calls.subscribe, [["alguem|camera"]]);

  // Mesma pessoa, sessão nova: a assinatura antiga não entrega mais nada.
  engine.syncRemote([{ memberId: "alguem", slot: "camera", sessionId: "s2" }]);
  await sleep(20);
  assert.equal(transport.calls.subscribe.length, 2, "a sessão nova é assinada de novo");
});

await test("fechar o motor solta os temporizadores e as conexões", async () => {
  const transport = transportWith();
  const { engine, send, recv } = makeEngine(transport);

  await engine.setLocalTrack("mic", new FakeTrack("audio"));
  send.setIceState("disconnected");
  engine.close();
  await sleep(30);

  assert.equal(send.signalingState, "closed");
  assert.equal(recv.signalingState, "closed");
  assert.equal(send.iceRestarts, 0, "temporizador pendente não age depois do fechamento");
});

// --- Som do sistema junto com a tela ----------------------------------------

/**
 * O defeito que estes casos existem pra impedir: compartilhar a tela inteira com
 * o som marcado, e a transmissão começar muda. O Windows recusa o loopback junto
 * de uma fonte `screen:` em algumas configurações e aceita junto de `window:`, e
 * quem paga o preço é quem escolheu a tela inteira.
 */
const { MediaManager, describeSystemAudioFailure } = await bundle(
  join(root, "client", "src", "rtc", "MediaManager.ts"),
);
const {
  DEFAULT_SCREEN_OPTIONS,
  normalizeScreenOptions,
  screenDegradation,
} = await bundle(join(root, "client", "src", "rtc", "MediaManager.ts"));
const { preferLowLatency } = await bundle(join(root, "client", "src", "rtc", "engine.ts"));
const { normalizeUpdateStatus } = await bundle(join(root, "client", "src", "desktop.ts"));

await test("padrão de tela prioriza fluidez sem esconder as opções maiores", async () => {
  assert.equal(DEFAULT_SCREEN_OPTIONS.resolution, "720");
  assert.equal(DEFAULT_SCREEN_OPTIONS.frameRate, 30);
  assert.equal(normalizeScreenOptions({}).resolution, "720");
  assert.equal(screenDegradation("auto"), "balanced");
  assert.equal(screenDegradation("game"), "maintain-framerate");
  assert.equal(screenDegradation("text"), "maintain-resolution");
});

await test("receptor da tela pede buffer mínimo quando o navegador permite", async () => {
  const receiver = {};
  preferLowLatency(receiver);
  assert.equal(receiver.playoutDelayHint, 0);
  assert.equal(receiver.jitterBufferTarget, 0);
});

await test("build 1.2 de teste oferece a 1.0 oficial em vez de tratá-la como downgrade", async () => {
  const legacy = normalizeUpdateStatus({
    current: "1.2.0",
    latest: "1.0.0",
    available: false,
    url: "https://github.com/cesar1014/draco/releases/tag/v1.0.0",
    notes: null,
  });
  assert.equal(legacy.available, true);
  assert.equal(
    normalizeUpdateStatus({ ...legacy, current: "1.0.0", available: false }).available,
    false,
  );
});

const namedError = (name) => Object.assign(new Error(name), { name });

/** Recusa padrão do caminho legado: os casos que esperam som passam o próprio `user`. */
const refuseUserMedia = () => {
  throw namedError("NotAllowedError");
};

/**
 * Substitui `navigator.mediaDevices` e a ponte do app pelo que o caso precisa, e
 * devolve o registro do que foi pedido. `display` e `user` decidem o que cada
 * chamada faz: devolver trilhas, ou estourar o erro que o Windows estouraria.
 */
function fakeMedia({ display, user = refuseUserMedia, platform = "win32" }) {
  const calls = { display: [], user: [], claims: [], failures: [] };
  // Node 22 passou a expor `navigator` como getter sem setter. Definir a
  // propriedade deixa o mesmo mock funcionar nele e no Node 20 da estação.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async (constraints) => {
          calls.display.push(constraints.audio);
          return display(constraints, calls.display.length);
        },
        getUserMedia: async (constraints) => {
          calls.user.push(constraints);
          return user(constraints);
        },
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      desktop: {
        version: "1.0.0",
        platform,
        listSources: async () => [],
        selectSource: async (request) => {
          calls.claims.push(request.systemAudio);
          return { ok: true };
        },
        logCaptureFailure: async (report) => {
          calls.failures.push(report.stage);
        },
      },
    },
  });
  return calls;
}

const screenStream = (tracks) => new globalThis.MediaStream(tracks);

/**
 * O que o caminho legado devolve no Windows: som e imagem. A imagem vem porque
 * pedir só o áudio mata o renderer do Electron, e é descartada logo depois — o
 * `legacyStream` guarda a trilha de vídeo pra que o teste confira isso.
 */
function legacyStream() {
  const video = new FakeTrack("video");
  const stream = screenStream([new FakeTrack("audio"), video]);
  stream.videoOferecido = video;
  return stream;
}

const SHARE = { resolution: "1080", frameRate: 30, systemAudio: true, content: "auto" };

await test("Windows recusando o som da tela inteira ainda traz áudio pelo caminho legado", async () => {
  const calls = fakeMedia({
    // Primeira chamada com áudio: recusada, como o WASAPI faz com fonte `screen:`.
    display: (constraints, nth) =>
      nth === 1 && constraints.audio
        ? Promise.reject(namedError("NotReadableError"))
        : screenStream([new FakeTrack("video")]),
    user: legacyStream,
  });

  const capture = await new MediaManager().openScreen(SHARE, "screen:0:0");

  assert.equal(capture.systemAudioFailure, null, "o som veio, então não há aviso a dar");
  assert.ok(capture.audio, "e a trilha de som existe");
  assert.equal(capture.audio.contentHint, "music", "marcada como música, não como fala");
  assert.equal(calls.user.length, 1, "o caminho legado foi tentado uma vez");
  assert.deepEqual(calls.claims, [true, false], "a segunda reserva já não pede som");
  // Vídeo pedido, e com o id da fonte: sem a trilha de vídeo no pedido, o
  // renderer do Electron 39 morre, e a call cai junto.
  assert.equal(calls.user[0].video.mandatory.chromeMediaSource, "desktop");
  assert.equal(calls.user[0].video.mandatory.chromeMediaSourceId, "screen:0:0");
});

await test("a imagem do caminho legado é descartada, e não fica capturando à toa", async () => {
  let legado = null;
  fakeMedia({
    display: (constraints, nth) =>
      nth === 1 && constraints.audio
        ? Promise.reject(namedError("NotReadableError"))
        : screenStream([new FakeTrack("video")]),
    user: () => {
      legado = legacyStream();
      return legado;
    },
  });

  const capture = await new MediaManager().openScreen(SHARE, "screen:0:0");

  assert.equal(legado.videoOferecido.readyState, "ended", "duas capturas da mesma tela custariam CPU");
  assert.equal(legado.getVideoTracks().length, 0, "e sai da stream, pra não voltar num loop de trilhas");
  assert.equal(capture.video.kind, "video", "quem transmite é a captura que já tinha vindo");
});

await test("captura sem trilha de som cai no caminho legado sem repetir a captura", async () => {
  const calls = fakeMedia({
    // Concedida, mas muda: é assim que o loopback falha calado.
    display: () => screenStream([new FakeTrack("video")]),
    user: legacyStream,
  });

  const capture = await new MediaManager().openScreen(SHARE, "screen:0:0");

  assert.equal(capture.systemAudioFailure, null);
  assert.ok(capture.audio);
  assert.equal(calls.display.length, 1, "a imagem já estava boa: não recaptura a tela");
  assert.ok(calls.failures.includes("systemAudioEmpty"), "e o silêncio é registrado no log do app");
});

await test("a trilha do caminho legado entra na mesma stream, pra parar junto com a tela", async () => {
  fakeMedia({
    display: () => screenStream([new FakeTrack("video")]),
    user: legacyStream,
  });

  const media = new MediaManager();
  const capture = await media.openScreen(SHARE, "screen:0:0");
  media.closeScreen();

  assert.equal(capture.audio.readyState, "ended", "sem isto o app seguiria ouvindo o computador");
  assert.equal(capture.video.readyState, "ended");
});

await test("sem som nos dois caminhos, a transmissão começa muda e diz o porquê", async () => {
  const calls = fakeMedia({
    display: (constraints, nth) =>
      nth === 1 && constraints.audio
        ? Promise.reject(namedError("NotReadableError"))
        : screenStream([new FakeTrack("video")]),
  });

  const capture = await new MediaManager().openScreen(SHARE, "screen:0:0");

  assert.equal(capture.audio, null);
  assert.equal(capture.systemAudioFailure, "refused");
  assert.match(describeSystemAudioFailure("refused"), /janela do programa/);
  assert.ok(capture.video, "a imagem é o essencial: ela vai de qualquer jeito");
  assert.ok(calls.failures.includes("systemAudioLegacy"), "as duas etapas ficam no log");
});

await test("fora do Windows o caminho legado não é tentado", async () => {
  const calls = fakeMedia({
    display: () => screenStream([new FakeTrack("video")]),
    platform: "darwin",
  });

  const capture = await new MediaManager().openScreen(SHARE, "screen:0:0");

  assert.equal(calls.user.length, 0, "`chromeMediaSource` só faz loopback no Windows");
  assert.equal(capture.systemAudioFailure, "empty");
});

await test("quem não pediu som não ganha tentativa nenhuma de áudio", async () => {
  const calls = fakeMedia({ display: () => screenStream([new FakeTrack("video")]) });

  const capture = await new MediaManager().openScreen(
    { ...SHARE, systemAudio: false },
    "screen:0:0",
  );

  assert.deepEqual(calls.display, [false]);
  assert.equal(calls.user.length, 0);
  assert.equal(capture.systemAudioFailure, null, "não pedir som não é falha");
});

await test("cancelar o diálogo de captura não vira segunda tentativa", async () => {
  const calls = fakeMedia({ display: () => Promise.reject(namedError("NotAllowedError")) });

  await assert.rejects(() => new MediaManager().openScreen(SHARE, "screen:0:0"));
  assert.equal(calls.display.length, 1, "desistir é intenção, não falha de áudio");
  assert.equal(calls.user.length, 0);
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exitCode = failed === 0 ? 0 : 1;
