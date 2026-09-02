/**
 * Uma transmissão de tela inteira, do clique em compartilhar até o fim, com a
 * store de verdade no comando.
 *
 * Os defeitos que estes casos existem pra impedir são todos da mesma família, e
 * todos aparecem só na segunda transmissão: parar e recomeçar e a imagem não
 * voltar, o "parar de compartilhar" do navegador deixar a publicação de pé no
 * servidor, um encerramento atrasado derrubar a transmissão que acabou de subir,
 * cancelar o diálogo de captura matar a tela que já estava no ar.
 *
 * A store é código de navegador: aqui ela é compilada pelo esbuild e roda contra
 * um socket, um `RTCPeerConnection`, uma captura de tela e um `AudioContext` de
 * mentira, que registram o que foi pedido. O que se afirma não é o SDP — é o que
 * o servidor ouviu, e o que sobrou vivo depois de cada parada.
 *
 *   node tools/test-screenshare.mjs
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VOICE = "canal-voz";
const SHARE = { resolution: "1080", frameRate: 30, systemAudio: true, content: "auto" };
/** Que tipo de mídia cada slot carrega, como a store espera encontrar. */
const KIND = { mic: "audio", camera: "video", screen: "video", screenAudio: "audio" };

let passed = 0;
let failed = 0;

async function test(label, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}\n        ${error.stack ?? error.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * As calls abertas pelos casos. Um caso que falha no meio não chega a sair da
 * call, e o detector de fala e o coletor de estatísticas dela manteriam o
 * processo vivo depois do resumo: cada boot fecha o que ficou pra trás.
 */
const abertas = [];
const encerrarAbertas = () => {
  while (abertas.length > 0) {
    const store = abertas.pop();
    try {
      store.getState().leaveVoice();
    } catch {
      // O caso já falhou por outro motivo; aqui só interessa soltar os timers.
    }
  }
};
const set = (name, value) =>
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// --- navegador de mentira ----------------------------------------------------

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = "live";
    this.enabled = true;
    this.muted = false;
    this.contentHint = "";
    this.onended = null;
  }
  /** O mesmo que o navegador faz: encerrar avisa quem estava escutando. */
  stop() {
    this.readyState = "ended";
    this.onended?.();
  }
}

class FakeStream {
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
    this.transceivers = [];
    this.offers = 0;
    FakePeerConnection.instances.push(this);
  }
  addTransceiver(track) {
    const transceiver = new FakeTransceiver(String(this.transceivers.length), track);
    this.transceivers.push(transceiver);
    return transceiver;
  }
  /** Como o SFU aparece de quem recebe: chega mídia, e nada sai por aqui. */
  addReceiver(kind) {
    const transceiver = new FakeTransceiver(String(this.transceivers.length), null);
    transceiver.currentDirection = "recvonly";
    transceiver.direction = "recvonly";
    transceiver.receiver.track = new FakeTrack(kind);
    this.transceivers.push(transceiver);
    return transceiver;
  }
  getTransceivers() {
    return this.transceivers;
  }
  async createOffer() {
    this.offers += 1;
    return { type: "offer", sdp: `v=0 offer-${this.offers}` };
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0 answer" };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async setRemoteDescription() {}
  async getStats() {
    return new Map();
  }
  close() {
    this.signalingState = "closed";
    // Fechar a conexão encerra os transceivers dela, como no navegador: sem isso
    // uma conexão morta ainda pareceria estar enviando a tela.
    for (const transceiver of this.transceivers) transceiver.stop();
  }
}

/** Web Audio de mentira: o medidor de voz e os avisos sonoros da store passam por aqui. */
class FakeAudioNode {
  constructor() {
    this.gain = FakeAudioNode.param();
    this.frequency = FakeAudioNode.param();
    this.fftSize = 512;
    this.smoothingTimeConstant = 0;
    this.type = "";
  }
  static param() {
    return {
      value: 0,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
    };
  }
  connect(next) {
    return next;
  }
  disconnect() {}
  start() {}
  stop() {}
  getFloatTimeDomainData(buffer) {
    buffer.fill(0);
  }
}

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.destination = new FakeAudioNode();
  }
  async resume() {}
  async close() {}
  createGain() {
    return new FakeAudioNode();
  }
  createBiquadFilter() {
    return new FakeAudioNode();
  }
  createOscillator() {
    return new FakeAudioNode();
  }
  createAnalyser() {
    return new FakeAudioNode();
  }
  createMediaStreamSource() {
    return new FakeAudioNode();
  }
}

/** O que a captura de tela devolve. Cada caso troca isto pelo que quer exercitar. */
const capture = {
  display: () => new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]),
};

const guarda = new Map();
set("localStorage", {
  getItem: (key) => (guarda.has(key) ? guarda.get(key) : null),
  setItem: (key, value) => void guarda.set(key, String(value)),
  removeItem: (key) => void guarda.delete(key),
});
set("window", {
  addEventListener() {},
  removeEventListener() {},
  location: { origin: "http://localhost", href: "http://localhost/", search: "", pathname: "/" },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
set("document", {
  addEventListener() {},
  removeEventListener() {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
  documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
  hidden: false,
  visibilityState: "visible",
});
set("navigator", {
  userAgent: "node",
  mediaDevices: {
    enumerateDevices: async () => [],
    getUserMedia: async () => new FakeStream([new FakeTrack("audio")]),
    getDisplayMedia: async (constraints) => capture.display(constraints),
  },
});
set("fetch", async () => ({ ok: false, status: 503, json: async () => ({}) }));
set("AudioContext", FakeAudioContext);
set("RTCPeerConnection", FakePeerConnection);
set("MediaStream", FakeStream);

// --- servidor e socket de mentira --------------------------------------------

const member = (id, extra = {}) => ({
  id,
  username: id,
  publicId: null,
  color: "#8ab4f8",
  voiceChannelId: VOICE,
  muted: false,
  deafened: false,
  camOn: false,
  screenOn: false,
  speaking: false,
  since: 0,
  sfuSessionId: `sessao-${id}`,
  sfuTracks: {},
  presence: "online",
  customStatus: null,
  statusExpiresAt: null,
  ...extra,
});

/**
 * O servidor de sinalização reduzido ao que a tela precisa: responde os `sfu:*`
 * e guarda o que foi pedido. `published` e `closed` são a memória que o teste
 * consulta pra saber se o SFU ficou com uma transmissão fantasma.
 */
function fakeServer() {
  const sfu = { joins: 0, published: [], closed: [], subscribed: [], viewing: [] };
  const reply = (event, payload) => {
    switch (event) {
      case "identify":
        return {
          ok: true,
          selfId: "eu",
          guestToken: "visita",
          sfu: true,
          state: {
            guilds: [{ id: "g1", name: "Draco", ownerId: "eu" }],
            channels: [{ id: VOICE, guildId: "g1", name: "Geral", type: "voice" }],
            members: [member("eu", { voiceChannelId: null }), member("par", { voiceChannelId: null })],
            messages: {},
          },
        };
      case "ice:get":
        return { ok: true, config: { iceServers: [], iceTransportPolicy: "all" } };
      case "voice:join":
        return { ok: true, sfu: true, screenViewers: {}, peers: [member("eu"), member("par")] };
      case "sfu:join":
        sfu.joins += 1;
        return { ok: true };
      case "sfu:publish":
        sfu.published.push(...payload.tracks);
        return { ok: true, description: { type: "answer", sdp: "v=0 sfu" } };
      case "sfu:unpublish":
        sfu.closed.push(...payload.tracks);
        return { ok: true, closed: true };
      case "sfu:subscribe": {
        sfu.subscribed.push(payload.tracks);
        // Devolve as trilhas assinadas como a Cloudflare devolveria: é o que dá
        // a quem está assistindo alguma coisa pra colocar na tela.
        const recv = FakePeerConnection.instances.at(-1);
        return {
          ok: true,
          description: { type: "offer", sdp: "v=0 sfu-offer" },
          tracks: payload.tracks.map((ref) => ({
            mid: recv.addReceiver(KIND[ref.slot]).mid,
            trackName: ref.trackName,
          })),
        };
      }
      case "sfu:renegotiate":
        return { ok: true };
      case "screen:view":
        sfu.viewing.push(payload);
        return { ok: true };
      default:
        return { ok: true };
    }
  };
  return { sfu, reply };
}

function fakeSocket(server) {
  const handlers = new Map();
  const sent = [];
  const socket = {
    connected: false,
    on(event, handler) {
      handlers.set(event, handler);
      return socket;
    },
    off(event) {
      handlers.delete(event);
      return socket;
    },
    io: { on() {}, off() {} },
    connect() {
      socket.connected = true;
      setTimeout(() => handlers.get("connect")?.(), 0);
      return socket;
    },
    disconnect() {
      socket.connected = false;
      return socket;
    },
    emit(event, payload, ack) {
      sent.push({ event, payload });
      const answer = server.reply(event, payload);
      if (ack) setTimeout(() => ack(answer), 0);
      return socket;
    },
    /** Evento vindo do servidor, como o `member:state` de quem parou de transmitir. */
    fire(event, payload) {
      handlers.get(event)?.(payload);
    },
    of(event) {
      return sent.filter((entry) => entry.event === event).map((entry) => entry.payload);
    },
  };
  return socket;
}

// --- a store de verdade ------------------------------------------------------

/**
 * Compila a store com as dependências dela. `socket.io-client` é substituído
 * pelo socket do teste: é o único ponto em que a store fala com o mundo, e
 * trocá-lo aqui deixa o resto do caminho igual ao que roda no navegador.
 */
async function bundleStore() {
  const result = await build({
    entryPoints: [join(root, "client", "src", "state", "store.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
    alias: { "@": join(root, "client", "src") },
    plugins: [
      {
        name: "test-doubles",
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "url" }));
          builder.onLoad({ filter: /.*/, namespace: "url" }, () => ({
            contents: 'export default "";',
            loader: "js",
          }));
          builder.onResolve({ filter: /^socket\.io-client$/ }, () => ({
            path: "io",
            namespace: "double",
          }));
          builder.onLoad({ filter: /^io$/, namespace: "double" }, () => ({
            contents: "export const io = () => globalThis.__socket();",
            loader: "js",
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

const storeCode = await bundleStore();
let instances = 0;

/**
 * Um app novo por caso: entra na conta de visitante, entra no canal de voz e
 * devolve o que o teste precisa pra dirigir e pra conferir. Módulo novo a cada
 * chamada porque a store é um singleton, e um caso não deve herdar a tela do outro.
 */
async function boot() {
  encerrarAbertas();
  instances += 1;
  guarda.clear();
  FakePeerConnection.instances = [];
  capture.display = () => new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);

  const server = fakeServer();
  const socket = fakeSocket(server);
  set("__socket", () => socket);

  const source = `${storeCode}\n//${instances}`;
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const store = module.useStore;
  abertas.push(store);

  await store.getState().connectGuest("eu", "CONVITE", 20);
  assert.equal(store.getState().status, "ready", "o app precisa estar conectado pro caso valer");
  await store.getState().joinVoice(VOICE);
  assert.ok(store.getState().voiceChannelId, "e dentro do canal de voz");

  return {
    socket,
    sfu: server.sfu,
    media: module.media,
    state: () => store.getState(),
    /** As duas conexões do SFU: a primeira envia, a segunda recebe. */
    send: () => FakePeerConnection.instances[0],
    /** Tudo que continua sendo enviado, em qualquer conexão desta call. */
    sending: () =>
      FakePeerConnection.instances
        .flatMap((pc) => pc.getTransceivers())
        .filter((entry) => entry.currentDirection !== "stopped" && entry.sender.track),
    screenIds: () => server.sfu.published.filter((entry) => entry.slot === "screen").map((entry) => entry.publicationId),
    closedIds: () => server.sfu.closed.filter((entry) => entry.slot === "screen").map((entry) => entry.publicationId),
    /** O que a store anunciou aos outros sobre a tela, na ordem. */
    announced: () =>
      socket
        .of("voice:state")
        .filter((patch) => patch.screenOn !== undefined)
        .map((patch) => patch.screenOn),
  };
}

// --- os casos ----------------------------------------------------------------

await test("cinco transmissões seguidas: nome novo em cada uma, e nenhuma sobra no servidor", async () => {
  const app = await boot();

  const publicadas = [];
  for (let volta = 1; volta <= 5; volta += 1) {
    await app.state().startScreen(SHARE, null);
    assert.equal(app.state().screenOn, true, `a transmissão ${volta} entrou no ar`);
    assert.ok(app.media.screenTrack, "e a captura está viva");
    publicadas.push(app.screenIds().at(-1));

    await app.state().toggleScreen();
    assert.equal(app.state().screenOn, false, `a transmissão ${volta} saiu do ar`);
    assert.equal(app.media.screenTrack, null, "a captura foi encerrada");
    assert.equal(app.state().mediaError, null, "e ninguém viu erro nenhum");
  }

  assert.equal(new Set(publicadas).size, 5, "cada transmissão publica um nome próprio");
  assert.deepEqual(
    app.closedIds(),
    publicadas,
    "e cada parada fecha no servidor exatamente a publicação que estava no ar",
  );
  assert.deepEqual(
    app.announced().slice(1),
    [true, false, true, false, true, false, true, false, true, false],
    "os outros são avisados de cada começo e de cada fim",
  );

  const enviando = app.sending();
  assert.equal(enviando.length, 1, "nada continua enviando além do microfone");
  assert.equal(enviando[0].sender.track, app.media.micTrack, "e é o microfone mesmo");
  app.state().leaveVoice();
});

/** Os slots de tela que passaram por uma lista de trilhas do servidor. */
const screenSlots = (tracks) =>
  tracks.filter((entry) => entry.slot.startsWith("screen")).map((entry) => entry.slot);

/** Espera algo virar verdade, sem prender o teste pra sempre se não virar. */
const until = async (condition, what) => {
  for (let volta = 0; volta < 200; volta += 1) {
    if (condition()) return;
    await sleep(5);
  }
  assert.fail(`esperei demais por ${what}`);
};

await test("tela sem som do sistema entra no ar avisando que o som não veio", async () => {
  const app = await boot();
  // A captura vem só com imagem: é o que o Windows devolve quando o loopback
  // não está disponível, e é o caso em que a transmissão não pode falhar.
  capture.display = () => new FakeStream([new FakeTrack("video")]);

  await app.state().startScreen(SHARE, null);
  assert.equal(app.state().screenOn, true, "a imagem entra no ar mesmo sem o som");
  assert.equal(app.state().mediaError, null, "ficar sem som não é falha de transmissão");
  assert.ok(app.state().notice, "mas quem transmite fica sabendo que o som não veio");
  assert.deepEqual(screenSlots(app.sfu.published), ["screen"], "e nada de áudio é publicado");

  await app.state().toggleScreen();
  assert.deepEqual(screenSlots(app.sfu.closed), ["screen"], "parar não pede pra fechar um áudio que nunca subiu");
  assert.equal(app.state().screenOn, false);
  app.state().leaveVoice();
});

await test("o botão e o parar do navegador chegando juntos encerram a publicação uma vez", async () => {
  const app = await boot();
  await app.state().startScreen(SHARE, null);
  const publicada = app.screenIds().at(-1);
  const avisoDoNavegador = app.media.screenTrack.onended;
  assert.ok(avisoDoNavegador, "a store escuta o fim da captura");

  await Promise.all([app.state().toggleScreen(), Promise.resolve().then(avisoDoNavegador)]);
  await sleep(20);
  assert.equal(app.state().screenOn, false, "a transmissão sai do ar");
  assert.deepEqual(app.closedIds(), [publicada], "e o servidor recebe um pedido de fechamento só");
  assert.equal(app.state().screenPickerOpen, false, "sem abrir o painel de escolher tela por engano");

  await app.state().toggleScreen();
  assert.deepEqual(app.closedIds(), [publicada], "com a tela desligada o botão não fecha nada de novo");
  assert.equal(app.state().screenPickerOpen, true, "ele volta a ser o convite pra escolher uma tela");
  app.state().leaveVoice();
});

await test("o parar de compartilhar do navegador faz a mesma limpeza que o botão", async () => {
  const app = await boot();
  await app.state().startScreen(SHARE, null);
  const publicada = app.screenIds().at(-1);

  // O navegador encerra a trilha por fora do app: é o que a barra dele faz.
  app.media.screenTrack.stop();
  // Sem promessa pra esperar: o fim vem de um retorno do navegador, e a limpeza
  // corre por conta dela mesma até chegar ao servidor.
  await until(() => app.closedIds().length > 0, "o fim da captura chegar ao servidor");

  assert.equal(app.state().screenOn, false, "a transmissão sai do ar sozinha");
  assert.deepEqual(app.closedIds(), [publicada], "a publicação é fechada no servidor");
  assert.equal(app.media.screenTrack, null, "a captura é liberada");
  assert.equal(app.announced().at(-1), false, "e os outros são avisados do fim");
  const enviando = app.sending();
  assert.equal(enviando.length, 1, "a voz não é levada junto");
  assert.equal(enviando[0].sender.track, app.media.micTrack, "e continua sendo o microfone");
  app.state().leaveVoice();
});

await test("aviso atrasado da transmissão anterior não derruba a que está no ar", async () => {
  const app = await boot();
  await app.state().startScreen(SHARE, null);
  const primeira = app.screenIds().at(-1);
  // Guardado antes de parar: é o retorno atrasado que chega depois da troca.
  const avisoAntigo = app.media.screenTrack.onended;
  await app.state().toggleScreen();

  await app.state().startScreen(SHARE, null);
  const segunda = app.screenIds().at(-1);
  const noAr = app.media.screenTrack;
  assert.notEqual(segunda, primeira, "a transmissão nova subiu com nome próprio");

  avisoAntigo();
  await sleep(20);
  assert.equal(app.state().screenOn, true, "a transmissão nova continua no ar");
  assert.equal(app.media.screenTrack, noAr, "com a captura dela intacta");
  assert.deepEqual(app.closedIds(), [primeira], "e o servidor só fechou a que realmente acabou");
  assert.ok(app.sending().some((entry) => entry.sender.track === noAr), "a imagem continua sendo enviada");
  app.state().leaveVoice();
});

await test("trocar de tela sem parar fecha a antiga e sobe uma publicação nova", async () => {
  const app = await boot();
  await app.state().startScreen(SHARE, null);
  const primeira = app.screenIds().at(-1);

  await app.state().startScreen(SHARE, null);
  const segunda = app.screenIds().at(-1);
  assert.notEqual(segunda, primeira, "a tela nova sobe com nome próprio");
  assert.deepEqual(app.closedIds(), [primeira], "e a antiga sai do servidor");
  assert.equal(app.state().screenOn, true, "sem passar por um intervalo desligado");

  const imagens = app.sending().filter((entry) => entry.sender.track?.kind === "video");
  assert.equal(imagens.length, 1, "só uma imagem de tela continua no ar");
  assert.equal(imagens[0].sender.track, app.media.screenTrack, "e é a captura nova");
  app.state().leaveVoice();
});

await test("desistir da escolha de tela não interrompe a transmissão que está no ar", async () => {
  const app = await boot();
  await app.state().startScreen(SHARE, null);
  const publicada = app.screenIds().at(-1);
  const noAr = app.media.screenTrack;

  capture.display = () =>
    Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
  await app.state().startScreen(SHARE, null);

  assert.equal(app.state().screenOn, true, "continua transmitindo");
  assert.equal(app.media.screenTrack, noAr, "a mesma captura de antes");
  assert.deepEqual(app.screenIds(), [publicada], "nada de novo foi publicado");
  assert.deepEqual(app.closedIds(), [], "e nada foi fechado no servidor");
  assert.equal(app.state().mediaError, null, "desistir não é erro pra mostrar");
  app.state().leaveVoice();
});

await test("assistir é sob demanda: a tela do outro só é assinada depois do clique", async () => {
  const app = await boot();
  const trilhas = { mic: "par-mic-1", screen: "par-screen-a1", screenAudio: "par-screenAudio-a1" };
  app.socket.fire("member:state", member("par", { screenOn: true, sfuTracks: trilhas }));
  await until(() => app.sfu.subscribed.length > 0, "a voz do par ser assinada");

  const antes = app.sfu.subscribed.at(-1);
  assert.deepEqual(antes.map((ref) => ref.slot), ["mic"], "a voz vem sozinha; a tela não vem sem pedido");
  assert.equal(app.state().remote.par?.streams.screen, undefined, "e nada de tela chega antes do clique");

  app.state().watch("par:screen", true);
  await until(() => app.state().remote.par?.live.screen === true, "a tela do par começar a chegar");

  assert.deepEqual(app.sfu.subscribed.at(-1), [
    { memberId: "par", slot: "screen", sessionId: "sessao-par", trackName: "par-screen-a1" },
    { memberId: "par", slot: "screenAudio", sessionId: "sessao-par", trackName: "par-screenAudio-a1" },
  ], "o clique assina imagem e som pelo nome que o dono publicou");
  assert.deepEqual(app.socket.of("screen:view").at(-1), { ownerId: "par", watching: true }, "e o servidor sabe quem está assistindo");
  assert.equal(app.state().remote.par.live.screenAudio, true, "o som da tela chega junto");
  const recebida = app.state().remote.par.streams.screen.getTracks()[0];

  // Quem transmitia parou, e quem assistia não deveria ter que fazer nada.
  app.socket.fire("member:state", member("par", { screenOn: false, sfuTracks: { mic: "par-mic-1" } }));
  await until(() => app.state().remote.par?.live.screen === false, "a transmissão terminar pra quem assistia");
  assert.equal(app.state().watching["par:screen"], undefined, "a tela sai da lista do que se está assistindo");
  assert.equal(recebida.readyState, "ended", "e a trilha recebida é solta em vez de seguir sendo decodificada");

  // E dá pra assistir de novo quando ele voltar, agora com outra publicação.
  app.socket.fire("member:state", member("par", { screenOn: true, sfuTracks: { ...trilhas, screen: "par-screen-b2" } }));
  await sleep(20);
  app.state().watch("par:screen", true);
  await until(() => app.state().remote.par?.live.screen === true, "a segunda transmissão do par chegar");
  const assinada = app.sfu.subscribed.at(-1).find((ref) => ref.slot === "screen");
  assert.equal(assinada.trackName, "par-screen-b2", "assinando a publicação nova, não a que acabou");
  app.state().leaveVoice();
});

await test("sair do canal com a tela no ar não deixa nada ligado, e entrar de novo transmite outra vez", async () => {
  const app = await boot();
  await app.state().startScreen(SHARE, null);
  const primeira = app.screenIds().at(-1);
  const enviava = app.send();

  app.state().leaveVoice();
  await sleep(20);
  assert.equal(app.state().screenOn, false, "a tela sai do ar junto da call");
  assert.equal(app.state().voiceChannelId, null);
  assert.equal(app.media.screenTrack, null, "a captura de tela é liberada");
  assert.equal(app.media.micTrack, null, "e o microfone também");
  assert.equal(enviava.signalingState, "closed", "a conexão de mídia é fechada");
  assert.deepEqual(app.closedIds(), [], "sair fecha a sessão inteira, então não há trilha a encerrar uma por uma");

  await app.state().joinVoice(VOICE);
  await app.state().startScreen(SHARE, null);
  assert.equal(app.state().screenOn, true, "voltar e transmitir de novo funciona sem reiniciar nada");
  assert.notEqual(app.screenIds().at(-1), primeira, "com uma publicação nova");
  app.state().leaveVoice();
});

await test("queda e volta do socket republica a tela, e parar fecha a publicação que está no ar", async () => {
  const app = await boot();
  await app.state().startScreen(SHARE, null);
  const antiga = app.screenIds().at(-1);
  const capturada = app.media.screenTrack;

  app.socket.fire("disconnect", "transport close");
  assert.equal(app.state().reconnecting, true, "a queda aparece na interface");
  app.socket.connect();
  await until(() => app.screenIds().length > 1, "a tela voltar ao ar depois da reconexão");

  assert.equal(app.state().reconnecting, false, "e a volta também");
  assert.equal(app.state().screenOn, true, "a transmissão continua de pé");
  assert.equal(app.media.screenTrack, capturada, "sem pedir a tela de novo a quem transmite");
  const nova = app.screenIds().at(-1);
  assert.notEqual(nova, antiga, "com publicação nova, porque a sessão anterior morreu com o socket");
  assert.deepEqual(app.closedIds(), [], "e sem pedir o fechamento de uma trilha que já não existe");

  await app.state().toggleScreen();
  assert.deepEqual(app.closedIds(), [nova], "parar fecha a publicação que está no ar agora");
  assert.equal(app.state().screenOn, false);
  const enviando = app.sending();
  assert.equal(enviando.length, 1, "e nada além da voz continua sendo enviado, em conexão nenhuma");
  assert.equal(enviando[0].sender.track, app.media.micTrack, "nem sobra da conexão que caiu");
  app.state().leaveVoice();
});

encerrarAbertas();

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exitCode = failed === 0 ? 0 : 1;
