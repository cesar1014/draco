/**
 * Ciclo de vida das trilhas publicadas no SFU, e o som do sistema junto com a tela.
 *
 * O defeito que este teste existe pra impedir é específico e chato de achar à
 * mão: ligar a câmera/tela, desligar e ligar de novo, acumulando publicações até
 * a imagem ficar presa em "Conectando".
 *
 * A tela pede uma garantia a mais: parar tem que fechar a publicação no SFU, e
 * cada transmissão nova sobe com identificador próprio. Sem isso o servidor
 * continua anunciando uma transmissão que já acabou, e quem clica pra assistir
 * espera para sempre por uma trilha que ninguém alimenta.
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

async function loadVoiceEngine() {
  return (await bundle(join(root, "client", "src", "rtc", "VoiceEngine.ts"))).VoiceEngine;
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
    this.onended?.();
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

/** Que tipo de mídia cada slot carrega, como o motor espera encontrar. */
const KIND = { mic: "audio", camera: "video", screen: "video", screenAudio: "audio" };

/** Transporte que conta o que o motor pediu ao servidor, e pode recusar o que se pedir. */
function transportWith(overrides = {}) {
  const calls = { join: 0, publish: [], published: [], unpublish: [], subscribe: [], renegotiate: [] };
  const state = {
    rejectPublish: false,
    stale: false,
    acceptRenegotiate: true,
    subscribeError: null,
    // Com `attach`, o transporte devolve as trilhas assinadas como a Cloudflare
    // devolveria, e o motor tem o que entregar a quem está assistindo.
    attach: false,
    ...overrides,
  };
  return {
    calls,
    state,
    join: async () => {
      calls.join += 1;
      return true;
    },
    publish: async (_description, tracks) => {
      calls.publish.push(tracks.map((entry) => entry.slot));
      calls.published.push(...tracks);
      if (state.rejectPublish) return { description: null, stale: state.stale };
      return { description: { type: "answer", sdp: "v=0 sfu" }, stale: false };
    },
    unpublish: async (tracks) => {
      calls.unpublish.push(...tracks);
    },
    subscribe: async (refs) => {
      calls.subscribe.push(refs.map((ref) => `${ref.memberId}|${ref.slot}`));
      if (state.subscribeError) throw new Error(state.subscribeError);
      if (!state.attach) return { description: null, tracks: [] };
      const recv = FakePeerConnection.instances[1];
      return {
        description: { type: "offer", sdp: "v=0 sfu-offer" },
        tracks: refs.map((ref) => ({
          mid: recv.addTransceiver(new FakeTrack(KIND[ref.slot])).mid,
          trackName: ref.trackName ?? null,
        })),
      };
    },
    renegotiate: async (role) => {
      calls.renegotiate.push(role);
      return state.acceptRenegotiate;
    },
  };
}

const SfuEngine = await loadEngine();
const VoiceEngine = await loadVoiceEngine();

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

await test("desligar e religar a câmera reutiliza a publicação viva", async () => {
  const transport = transportWith();
  const { engine, send } = makeEngine(transport);

  await engine.setLocalTrack("mic", new FakeTrack("audio"));
  await engine.setLocalTrack("camera", new FakeTrack("video"));
  assert.deepEqual(transport.calls.publish, [["mic"], ["camera"]]);

  await engine.setLocalTrack("camera", null);
  assert.equal(transport.calls.publish.length, 2, "desligar não republica");
  assert.equal(send.getTransceivers()[1].sender.track, null, "o fluxo é interrompido");
  assert.notEqual(send.getTransceivers()[1].currentDirection, "stopped", "o transceiver segue reutilizável");

  const reopened = new FakeTrack("video");
  await engine.setLocalTrack("camera", reopened);
  assert.equal(transport.calls.publish.length, 2, "religar não renegocia");
  assert.equal(send.getTransceivers()[1].sender.track, reopened, "a nova captura ocupa a publicação existente");

  // Uma conexão definitivamente falha não é reutilizada; o dono recria a call.
  send.setConnectionState("failed");
  await engine.setLocalTrack("camera", new FakeTrack("video"));
  assert.equal(transport.calls.publish.length, 2, "a sessão morta não recebe nova publicação");
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

await test("replaceTrack recusado republica a captura atual", async () => {
  const transport = transportWith();
  const { engine, send } = makeEngine(transport);

  await engine.setLocalTrack("screen", new FakeTrack("video"));
  send.getTransceivers()[0].sender.replaceTrack = async () => {
    throw new Error("sender perdeu a publicação");
  };

  await quiet(() => engine.setLocalTrack("screen", new FakeTrack("video")));
  assert.equal(transport.calls.publish.length, 2, "a falha não deixa a tela presa");
  assert.equal(send.getTransceivers().length, 2, "uma publicação nova substitui a inválida");
});

/** O identificador com que a última publicação do slot subiu. */
const publicationId = (transport, slot) =>
  transport.calls.published.filter((entry) => entry.slot === slot).at(-1)?.publicationId ?? null;

/** As publicações que ainda estão enviando algo nesta conexão. */
const livePublications = (pc) =>
  pc.getTransceivers().filter((entry) => entry.currentDirection !== "stopped" && entry.sender.track);

await test("cinco transmissões de tela seguidas, cada uma com publicação própria", async () => {
  const transport = transportWith();
  const { engine, send } = makeEngine(transport);
  const mic = new FakeTrack("audio");
  await engine.setLocalTrack("mic", mic);

  const publicados = [];
  for (let round = 0; round < 5; round += 1) {
    const video = new FakeTrack("video");
    const audio = new FakeTrack("audio");
    await engine.setLocalTrack("screen", video);
    await engine.setLocalTrack("screenAudio", audio);
    publicados.push(publicationId(transport, "screen"));

    await engine.unpublish("screenAudio", audio);
    await engine.unpublish("screen", video);

    assert.equal(engine.localTrack("screen"), null, "a transmissão sai do estado do motor");
    assert.equal(engine.localTrack("screenAudio"), null);
    assert.deepEqual(
      transport.calls.unpublish.slice(-2).map((entry) => entry.slot),
      ["screenAudio", "screen"],
      "imagem e som são fechados no servidor de mídia",
    );
  }

  assert.equal(new Set(publicados).size, 5, "cada transmissão sobe com identificador próprio");
  assert.equal(publicados.filter(Boolean).length, 5, "e nenhuma sobe sem identificador");
  assert.deepEqual(
    transport.calls.unpublish.filter((entry) => entry.slot === "screen").map((entry) => entry.publicationId),
    publicados,
    "o servidor recebe o identificador da transmissão que acabou, na ordem em que acabaram",
  );

  const enviando = livePublications(send);
  assert.equal(enviando.length, 1, "nada continua enviando além do microfone");
  assert.equal(enviando[0].sender.track, mic, "e o microfone atravessa as cinco transmissões");
});

await test("parar a tela duas vezes encerra uma vez", async () => {
  const transport = transportWith();
  const { engine, send } = makeEngine(transport);
  const video = new FakeTrack("video");
  await engine.setLocalTrack("screen", video);

  // O botão do app e o "parar de compartilhar" do navegador chegando juntos.
  await Promise.all([engine.unpublish("screen", video), engine.unpublish("screen", video)]);
  await engine.unpublish("screen", video);

  assert.equal(transport.calls.unpublish.length, 1, "o servidor recebe um fechamento só");
  assert.equal(send.getTransceivers()[0].currentDirection, "stopped", "e o `m=` da tela está parado");
  assert.equal(livePublications(send).length, 0);
});

await test("parada atrasada da transmissão anterior não derruba a que está no ar", async () => {
  const transport = transportWith();
  const { engine, send } = makeEngine(transport);

  const primeira = new FakeTrack("video");
  await engine.setLocalTrack("screen", primeira);
  const idPrimeira = publicationId(transport, "screen");
  await engine.unpublish("screen", primeira);

  const segunda = new FakeTrack("video");
  await engine.setLocalTrack("screen", segunda);
  assert.notEqual(publicationId(transport, "screen"), idPrimeira, "a transmissão nova tem outro nome");

  // Retorno de chamada atrasado da primeira, com a segunda já transmitindo.
  await engine.unpublish("screen", primeira);

  assert.equal(engine.localTrack("screen"), segunda, "a transmissão no ar continua publicada");
  assert.equal(transport.calls.unpublish.length, 1, "e nada além da primeira foi fechado");
  const enviando = livePublications(send);
  assert.equal(enviando.length, 1);
  assert.equal(enviando[0].sender.track, segunda);
});

await test("tela sem som não publica áudio nem pede fechamento à toa", async () => {
  const transport = transportWith();
  const { engine } = makeEngine(transport);

  const video = new FakeTrack("video");
  await engine.setLocalTrack("screen", video);
  await engine.setLocalTrack("screenAudio", null);
  assert.deepEqual(transport.calls.publish, [["screen"]], "sem som capturado não há segunda publicação");

  await engine.unpublish("screenAudio", null);
  await engine.unpublish("screen", video);
  assert.deepEqual(
    transport.calls.unpublish.map((entry) => entry.slot),
    ["screen"],
    "só a imagem tinha o que fechar",
  );
});

await test("sair da call não pede fechamento de trilha em sessão que já morreu", async () => {
  const transport = transportWith();
  const { engine } = makeEngine(transport);

  const video = new FakeTrack("video");
  await engine.setLocalTrack("screen", video);
  engine.close();
  await engine.unpublish("screen", video);

  assert.equal(transport.calls.unpublish.length, 0, "as duas sessões inteiras já foram descartadas");
});

await test("malha só envia tela e som ao par que clicou para assistir", async () => {
  FakePeerConnection.instances = [];
  const engine = new VoiceEngine({
    selfId: "transmissor",
    configuration: {},
    sendSignal: () => {},
    onRemoteTrack: () => {},
  });
  engine.syncRemote([{ memberId: "espectador", slot: "mic", sessionId: null }]);
  const [peer] = FakePeerConnection.instances;
  const video = new FakeTrack("video");
  const audio = new FakeTrack("audio");

  await engine.setLocalTrack("screen", video);
  await engine.setLocalTrack("screenAudio", audio);
  assert.equal(peer.getTransceivers()[2].sender.track, null, "antes do clique não envia vídeo");
  assert.equal(peer.getTransceivers()[3].sender.track, null, "antes do clique não envia áudio");

  await engine.setScreenViewers(["espectador"]);
  assert.equal(peer.getTransceivers()[2].sender.track, video);
  assert.equal(peer.getTransceivers()[3].sender.track, audio);

  await engine.setScreenViewers([]);
  assert.equal(peer.getTransceivers()[2].sender.track, null, "fechar a tela interrompe o envio");
  assert.equal(peer.getTransceivers()[3].sender.track, null);

  const screenSender = peer.getTransceivers()[2].sender;
  let replacements = 0;
  screenSender.replaceTrack = async (next) => {
    replacements += 1;
    if (replacements === 1) await sleep(10);
    screenSender.track = next;
  };
  const opening = engine.setScreenViewers(["espectador"]);
  const closing = engine.setScreenViewers([]);
  await Promise.all([opening, closing]);
  assert.equal(screenSender.track, null, "um clique antigo não vence o fechamento mais novo");
  engine.close();
});

await test("na malha, parar a tela solta os senders dela e deixa voz e câmera de pé", async () => {
  FakePeerConnection.instances = [];
  const engine = new VoiceEngine({
    selfId: "transmissor",
    configuration: {},
    sendSignal: () => {},
    onRemoteTrack: () => {},
  });
  engine.syncRemote([{ memberId: "espectador", slot: "mic", sessionId: null }]);
  const [peer] = FakePeerConnection.instances;
  const mic = new FakeTrack("audio");
  const camera = new FakeTrack("video");
  const video = new FakeTrack("video");
  const audio = new FakeTrack("audio");

  await engine.setLocalTrack("mic", mic);
  await engine.setLocalTrack("camera", camera);
  await engine.setLocalTrack("screen", video);
  await engine.setLocalTrack("screenAudio", audio);
  await engine.setScreenViewers(["espectador"]);
  assert.equal(peer.getTransceivers()[2].sender.track, video, "o espectador está recebendo a tela");

  await engine.unpublish("screenAudio", audio);
  await engine.unpublish("screen", video);
  assert.equal(peer.getTransceivers()[2].sender.track, null, "e deixa de receber quando a transmissão acaba");
  assert.equal(peer.getTransceivers()[3].sender.track, null);
  assert.equal(engine.localTrack("screen"), null);
  assert.equal(peer.getTransceivers()[0].sender.track, mic, "o microfone continua indo");
  assert.equal(peer.getTransceivers()[1].sender.track, camera, "e a câmera também");

  // Parada atrasada da anterior com outra transmissão no ar.
  const nova = new FakeTrack("video");
  await engine.setLocalTrack("screen", nova);
  await engine.setScreenViewers(["espectador"]);
  await engine.unpublish("screen", video);
  assert.equal(peer.getTransceivers()[2].sender.track, nova, "a transmissão nova segue no ar");
  engine.close();
});

await test("erro de sessão desconectada invalida a recepção e não repete na sessão morta", async () => {
  const transport = transportWith({
    subscribeError: "Session appears to be disconnected. Please check if the PeerConnection is connected.",
  });
  const { engine, failures } = makeEngine(transport);

  await quiet(async () => {
    engine.syncRemote([{ memberId: "alguem", slot: "screen", sessionId: "sessao-morta" }]);
    await sleep(20);
    engine.syncRemote([{ memberId: "alguem", slot: "screen", sessionId: "sessao-morta" }]);
    await sleep(20);
  });

  assert.equal(transport.calls.subscribe.length, 1, "a assinatura não entra em retry na sessão morta");
  assert.deepEqual(failures, [
    "Session appears to be disconnected. Please check if the PeerConnection is connected.",
  ]);
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

await test("assistir acompanha a publicação da tela, e fechar libera a recepção", async () => {
  const transport = transportWith({ attach: true });
  const relatos = [];
  const { engine } = makeEngine(transport, {
    onRemoteTrack: (memberId, slot, _stream, live) => relatos.push(`${memberId}|${slot}|${live}`),
  });

  engine.syncRemote([
    { memberId: "dono", slot: "screen", sessionId: "s1", trackName: "dono-screen-aaa" },
  ]);
  await sleep(20);
  assert.deepEqual(relatos, ["dono|screen|true"], "quem clicou pra assistir recebe a trilha");

  // O dono parou e começou outra transmissão: mesma sessão, publicação nova.
  engine.syncRemote([
    { memberId: "dono", slot: "screen", sessionId: "s1", trackName: "dono-screen-bbb" },
  ]);
  await sleep(20);
  assert.equal(transport.calls.subscribe.length, 2, "a publicação nova é assinada em lugar da antiga");
  assert.equal(relatos.at(-2), "dono|screen|false", "a antiga é anunciada como encerrada");
  assert.equal(relatos.at(-1), "dono|screen|true", "e a nova entra no lugar");

  // Fechou a tela: a assinatura é soltada e a recepção para.
  engine.syncRemote([]);
  await sleep(20);
  assert.equal(relatos.at(-1), "dono|screen|false", "o elemento de vídeo é avisado do fim");

  engine.syncRemote([
    { memberId: "dono", slot: "screen", sessionId: "s1", trackName: "dono-screen-bbb" },
  ]);
  await sleep(20);
  assert.equal(transport.calls.subscribe.length, 3, "e voltar a assistir pede a trilha de novo");
  engine.close();
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
  const calls = { display: [], displayOptions: [], user: [], claims: [], failures: [] };
  // Node 22 passou a expor `navigator` como getter sem setter. Definir a
  // propriedade deixa o mesmo mock funcionar nele e no Node 24 da estação.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async (constraints) => {
          calls.display.push(constraints.audio);
          calls.displayOptions.push(constraints);
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
  assert.equal(calls.displayOptions[0].systemAudio, "include", "o navegador oferece áudio da tela inteira");
  assert.equal(calls.displayOptions[0].windowAudio, "system", "e áudio junto da janela");
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

await test("trocar a fonte não deixa o ended da captura antiga fechar a nova", async () => {
  const first = new FakeTrack("video");
  const second = new FakeTrack("video");
  let ended = 0;
  first.onended = () => { ended += 1; };
  fakeMedia({
    display: (_constraints, call) => screenStream([call === 1 ? first : second]),
  });

  const media = new MediaManager();
  await media.openScreen({ ...SHARE, systemAudio: false });
  first.onended = () => { ended += 1; };
  await media.openScreen({ ...SHARE, systemAudio: false });

  assert.equal(first.readyState, "ended");
  assert.equal(ended, 0, "cleanup interno não se confunde com o botão nativo de parar");
  assert.equal(media.screenTrack, second, "a segunda captura continua sendo a fonte real");
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
  assert.equal(calls.displayOptions[0].systemAudio, "exclude");
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
