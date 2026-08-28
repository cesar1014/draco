import { VoiceEngine } from "@/rtc/VoiceEngine";
import { audioContext } from "@/rtc/SpeakingDetector";
import { SLOT_ORDER, type MediaSlot } from "@/types";

/**
 * Teste ponta a ponta do WebRTC dentro de uma única aba.
 *
 * Duas instâncias de `VoiceEngine` conversam entre si com mídia sintética:
 * oscilador no lugar do microfone e canvas no lugar da câmera. Então não precisa
 * de webcam, nem de permissão, nem de uma segunda pessoa pra provar que o núcleo
 * funciona: conexão fechando, mídia trafegando nos dois sentidos, mute cortando
 * som, e câmera e tela ligando sem renegociar.
 *
 * Duas asserções carregam mais peso do que parecem:
 *
 * - As cores dos canvas (vermelho na câmera, azul na tela) permitem *ler o pixel*
 *   do vídeo recebido. É o que prova que cada trilha caiu no slot certo.
 * - O áudio é medido nos dois sentidos. `A` responde à oferta e `B` oferta, então
 *   testar só um lado deixaria metade do caminho sem cobertura, e foi exatamente
 *   ali que se esconderam os transceivers duplicados de quem responde.
 */

export interface TestResult {
  label: string;
  ok: boolean;
  detail?: string;
}

const A_ID = "aaa-peer-polite";
const B_ID = "bbb-peer-impolite";

/** Acima disso é som de verdade; abaixo do segundo é silêncio. */
const AUDIBLE = 0.02;
const SILENT = 0.005;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(120);
  }
  return predicate();
}

/** Tom contínuo no lugar do microfone. */
function syntheticAudio(frequency: number): { track: MediaStreamTrack; stop: () => void } {
  const ctx = audioContext();
  const oscillator = ctx.createOscillator();
  oscillator.frequency.value = frequency;
  const gain = ctx.createGain();
  gain.gain.value = 0.25;
  const destination = ctx.createMediaStreamDestination();
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  return {
    track: destination.stream.getAudioTracks()[0],
    stop: () => {
      oscillator.stop();
      oscillator.disconnect();
      gain.disconnect();
    },
  };
}

/**
 * Canvas de cor sólida animada no lugar de uma câmera. O retângulo que se move
 * existe porque codec de vídeo com imagem 100% estática quase não emite quadro,
 * e o teste precisa ver bytes chegando.
 */
function syntheticVideo(color: string): { track: MediaStreamTrack; stop: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  const timer = setInterval(() => {
    frame += 1;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Mancha discreta e escura: mexe o suficiente pro encoder trabalhar, sem
    // contaminar o pixel central que a asserção de cor vai ler.
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect((frame * 7) % canvas.width, 0, 24, 12);
  }, 66);

  const stream = canvas.captureStream(15);
  return {
    track: stream.getVideoTracks()[0],
    stop: () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/**
 * Medidor de volume de um áudio recebido.
 *
 * As estatísticas de `getStats()` que existiriam pra isso (`audioLevel` e
 * `totalAudioEnergy`) vêm zeradas aqui, e `bytesReceived` continua subindo com
 * o microfone mudo (a conexão segue mandando silêncio, que é justamente o que se
 * quer). Então quem mede de fato é um `AnalyserNode` sobre a trilha recebida.
 */
function remoteMeter(stream: MediaStream) {
  const ctx = audioContext();
  // Chrome só decodifica áudio remoto que tenha algum destino. O elemento em
  // volume 0 é esse destino, e não sai som nenhum pelo alto-falante.
  const sink = document.createElement("audio");
  sink.srcObject = stream;
  sink.volume = 0;
  sink.autoplay = true;
  void sink.play().catch(() => {});

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));

  return {
    /** Maior RMS observado na janela: pico, não média, pra não diluir a sílaba. */
    async peak(windowMs: number): Promise<number> {
      let peak = 0;
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) sum += value * value;
        peak = Math.max(peak, Math.sqrt(sum / buffer.length));
        await sleep(40);
      }
      return peak;
    },
    stop() {
      source.disconnect();
      analyser.disconnect();
      sink.srcObject = null;
    },
  };
}

/** Desenha um quadro do vídeo recebido e devolve a cor do centro. */
async function samplePixel(stream: MediaStream): Promise<[number, number, number]> {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch {
    // Autoplay pode recusar; o vídeo mudo normalmente passa, e se não passar a
    // asserção de cor falha com detalhe, o que já é a informação que interessa.
  }
  await waitUntil(() => video.videoWidth > 0, 5000);
  await sleep(400);

  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const [r, g, b] = ctx.getImageData(16, 16, 1, 1).data;
  video.srcObject = null;
  return [r, g, b];
}

async function inboundRows(pc: RTCPeerConnection, kind: "audio" | "video") {
  const rows: Record<string, number>[] = [];
  (await pc.getStats()).forEach((report) => {
    if (report.type === "inbound-rtp" && report.kind === kind) rows.push(report as never);
  });
  return rows;
}

/**
 * Quadros já decodificados de um slot, achado pela posição do transceiver. O
 * mesmo contrato de ordem que o motor usa, olhado por fora.
 */
async function framesDecoded(pc: RTCPeerConnection, slot: MediaSlot): Promise<number> {
  const receiver = pc.getTransceivers()[SLOT_ORDER.indexOf(slot)]?.receiver;
  if (!receiver) return -1;
  let frames = 0;
  (await receiver.getStats()).forEach((report) => {
    const row = report as unknown as Record<string, number>;
    if (report.type === "inbound-rtp") frames = Number(row.framesDecoded) || 0;
  });
  return frames;
}

const sumOf = (rows: Record<string, number>[], field: string) =>
  rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);

/**
 * Despeja o resultado parcial em `selftest-report.json`, via a rota que só o
 * servidor de desenvolvimento monta. A cada asserção, não só no fim: o teste é
 * pesado e, se a aba travar no meio, o console some, e o arquivo sobra com o
 * que já tinha sido verificado até ali.
 */
function publish(results: TestResult[]): void {
  const failed = results.filter((r) => !r.ok).length;
  void fetch("/api/dev/selftest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passed: results.length - failed, failed, results }),
  }).catch(() => {
    // Sem servidor de dev o console basta; falha aqui não é falha do teste.
  });
}

export async function runSelfTest(report: (result: TestResult) => void): Promise<void> {
  const results: TestResult[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    const result = { label, ok, detail };
    results.push(result);
    report(result);
    publish(results);
    return ok;
  };

  // O oscilador não produz nada com o contexto de áudio suspenso, e ele só sai
  // de suspenso depois de um gesto, daí este teste rodar a partir de um botão.
  const ctx = audioContext();
  if (ctx.state === "suspended") await ctx.resume();
  check("contexto de áudio ativo", ctx.state === "running", `state=${ctx.state}`);

  const configuration: RTCConfiguration = { iceServers: [] }; // loopback: candidato host basta
  const remote = new Map<string, MediaStream>();
  const live = new Map<string, boolean>();
  const at = (side: "A" | "B", slot: MediaSlot) => `${side}:${slot}`;

  let engineA: VoiceEngine | null = null;
  let engineB: VoiceEngine | null = null;
  const cleanup: Array<() => void> = [];

  try {
    engineA = new VoiceEngine({
      selfId: A_ID,
      configuration,
      sendSignal: (_to, payload) => queueMicrotask(() => engineB?.handleSignal(A_ID, payload)),
      onRemoteTrack: (_peerId, slot, stream, isLive) => {
        remote.set(at("A", slot), stream);
        live.set(at("A", slot), isLive);
      },
    });
    engineB = new VoiceEngine({
      selfId: B_ID,
      configuration,
      sendSignal: (_to, payload) => queueMicrotask(() => engineA?.handleSignal(B_ID, payload)),
      onRemoteTrack: (_peerId, slot, stream, isLive) => {
        remote.set(at("B", slot), stream);
        live.set(at("B", slot), isLive);
      },
    });

    const micA = syntheticAudio(440);
    const micB = syntheticAudio(660);
    const camA = syntheticVideo("rgb(220, 30, 30)");
    const screenA = syntheticVideo("rgb(30, 60, 220)");
    const screenAudioA = syntheticAudio(880);
    cleanup.push(micA.stop, micB.stop, camA.stop, screenA.stop, screenAudioA.stop);

    // Microfone já entra ligado nos dois, como acontece ao entrar numa call.
    await engineA.setLocalTrack("mic", micA.track);
    await engineB.setLocalTrack("mic", micB.track);

    engineA.addPeer(B_ID);
    engineB.addPeer(A_ID);

    const pcA = engineA.peerConnection(B_ID)!;
    const pcB = engineB.peerConnection(A_ID)!;

    // --- conexão -----------------------------------------------------------
    const connected = await waitUntil(
      () => pcA.connectionState === "connected" && pcB.connectionState === "connected",
      20000,
    );
    check("as duas pontas conectam", connected, `A=${pcA.connectionState} B=${pcB.connectionState}`);
    if (!connected) return;

    // Um ofertante só: quem espera não gasta oferta nenhuma.
    const openingNegotiations = engineA.negotiationCount(B_ID) + engineB.negotiationCount(A_ID);
    check(
      "abre com uma negociação só",
      openingNegotiations === 1,
      `A=${engineA.negotiationCount(B_ID)} B=${engineB.negotiationCount(A_ID)}`,
    );

    // --- áudio nos dois sentidos -------------------------------------------
    await sleep(1200);
    const micAtB = remote.get(at("B", "mic"));
    const micAtA = remote.get(at("A", "mic"));
    if (!micAtB || !micAtA) {
      check("microfone chega nos dois sentidos", false, `B=${Boolean(micAtB)} A=${Boolean(micAtA)}`);
      return;
    }

    const meterB = remoteMeter(micAtB);
    const meterA = remoteMeter(micAtA);
    cleanup.push(meterB.stop, meterA.stop);

    const heardAtB = await meterB.peak(900);
    const heardAtA = await meterA.peak(900);
    check(
      "áudio de quem responde chega em quem ofertou",
      heardAtB > AUDIBLE,
      `pico=${heardAtB.toFixed(4)}`,
    );
    check(
      "áudio de quem ofertou chega em quem respondeu",
      heardAtA > AUDIBLE,
      `pico=${heardAtA.toFixed(4)}`,
    );

    // --- mute ---------------------------------------------------------------
    micA.track.enabled = false;
    await sleep(700);
    const mutedPeak = await meterB.peak(900);
    micA.track.enabled = true;
    await sleep(700);
    const unmutedPeak = await meterB.peak(900);

    check(
      "mutar corta o som sem derrubar a conexão",
      mutedPeak < SILENT && unmutedPeak > AUDIBLE && pcB.connectionState === "connected",
      `mudo=${mutedPeak.toFixed(4)} falando=${unmutedPeak.toFixed(4)}`,
    );

    // --- câmera, tela e áudio da tela sem renegociar ------------------------
    const negotiationsBefore = engineA.negotiationCount(B_ID) + engineB.negotiationCount(A_ID);

    await engineA.setLocalTrack("camera", camA.track);
    await engineA.setLocalTrack("screen", screenA.track);
    await engineA.setLocalTrack("screenAudio", screenAudioA.track);
    await sleep(2500);

    const negotiationsAfter = engineA.negotiationCount(B_ID) + engineB.negotiationCount(A_ID);
    check(
      "ligar câmera, tela e áudio da tela não renegocia",
      negotiationsAfter === negotiationsBefore,
      `antes=${negotiationsBefore} depois=${negotiationsAfter}`,
    );

    const videoIn = await inboundRows(pcB, "video");
    const videoBytes = sumOf(videoIn, "bytesReceived");
    check("vídeo chega no outro lado", videoBytes > 0, `${videoBytes} bytes em ${videoIn.length} trilhas`);

    check(
      "câmera e tela chegam como duas trilhas separadas",
      Boolean(live.get(at("B", "camera"))) && Boolean(live.get(at("B", "screen"))),
      `camera=${live.get(at("B", "camera"))} screen=${live.get(at("B", "screen"))}`,
    );

    // A prova do mapeamento por posição: a cor que sai da câmera tem que chegar
    // no slot da câmera, e não no da tela.
    const cameraStream = remote.get(at("B", "camera"));
    const screenStream = remote.get(at("B", "screen"));
    if (cameraStream && screenStream) {
      const [cr, cg, cb] = await samplePixel(cameraStream);
      const [sr, sg, sb] = await samplePixel(screenStream);
      check(
        "trilha da câmera cai no slot da câmera (vermelho)",
        cr > 140 && cr > cb + 40,
        `rgb(${cr},${cg},${cb})`,
      );
      check("trilha da tela cai no slot da tela (azul)", sb > 140 && sb > sr + 40, `rgb(${sr},${sg},${sb})`);
    } else {
      check("trilhas de vídeo identificadas por slot", false, "slot sem stream");
    }

    // O áudio da tela tem slot próprio pra não degradar o microfone; se ele
    // caísse no slot do mic, este medidor pegaria os dois tons somados.
    const screenAudioStream = remote.get(at("B", "screenAudio"));
    if (screenAudioStream) {
      const screenMeter = remoteMeter(screenAudioStream);
      cleanup.push(screenMeter.stop);
      const screenAudioPeak = await screenMeter.peak(900);
      check(
        "áudio da tela chega no slot próprio",
        screenAudioPeak > AUDIBLE,
        `pico=${screenAudioPeak.toFixed(4)}`,
      );
    } else {
      check("áudio da tela chega no slot próprio", false, "slot sem stream");
    }

    // --- desligar a câmera --------------------------------------------------
    // Não se olha o `muted` da trilha recebida aqui: `replaceTrack(null)` para de
    // enviar, mas o navegador não promete avisar por evento, e um clone que
    // dependesse disso deixaria o último quadro congelado na tela. Quem apaga o
    // tile é o estado que vem pelo socket; o que o motor precisa garantir é que
    // os quadros param de chegar, e que só os da câmera param.
    await engineA.setLocalTrack("camera", null);
    await sleep(2500);
    const cameraStopped = await framesDecoded(pcB, "camera");
    const screenRunning = await framesDecoded(pcB, "screen");
    await sleep(2000);
    const cameraLater = await framesDecoded(pcB, "camera");
    const screenLater = await framesDecoded(pcB, "screen");
    check(
      "desligar a câmera para os quadros dela, e só dela",
      cameraLater === cameraStopped && screenLater > screenRunning,
      `camera=${cameraStopped}→${cameraLater} tela=${screenRunning}→${screenLater}`,
    );
    check(
      "desligar também não renegocia",
      engineA.negotiationCount(B_ID) + engineB.negotiationCount(A_ID) === negotiationsAfter,
    );

    // --- recuperação de rede -------------------------------------------------
    // Os dois caminhos que o motor usa quando a conexão cai: quem oferta
    // reinicia o ICE por conta própria, e quem espera cobra uma oferta nova em
    // vez de ofertar (ver `VoiceEngine#recover`). Forçar as duas pontas a
    // reiniciar ao mesmo tempo, o glare clássico, não entra aqui: em loopback na
    // mesma aba isso derruba o renderer do navegador, e é justamente o que a
    // assimetria de quem oferta existe pra nunca acontecer. O tratamento de
    // colisão fica no motor como rede de segurança.
    // `engineB` é declarado com `let` (as duas instâncias se referenciam), e esse
    // tipo não sobrevive dentro dos closures de espera abaixo, daí o atalho.
    const negotiationsB = () => engineB!.negotiationCount(A_ID);
    const bothConnected = () => pcA.connectionState === "connected" && pcB.connectionState === "connected";

    const negotiationsBeforeRestart = negotiationsB();
    pcB.restartIce();
    const restarted = await waitUntil(() => negotiationsB() > negotiationsBeforeRestart && bothConnected(), 20000);
    check(
      "reinício de ICE reconecta com uma negociação",
      restarted && negotiationsB() === negotiationsBeforeRestart + 1,
      `negociações=${negotiationsBeforeRestart}→${negotiationsB()} A=${pcA.connectionState} B=${pcB.connectionState}`,
    );
    check("áudio continua depois do reinício", (await meterB.peak(900)) > AUDIBLE);

    // A cobrança, pelo mesmo caminho que o socket usaria: A pede, B oferta.
    const negotiationsBeforeRequest = negotiationsB();
    engineB.handleSignal(A_ID, { requestOffer: true });
    const answered = await waitUntil(() => negotiationsB() > negotiationsBeforeRequest && bothConnected(), 20000);
    check(
      "pedido de oferta faz o outro lado ofertar",
      answered,
      `negociações=${negotiationsBeforeRequest}→${negotiationsB()}`,
    );

    const afterRecovery = await meterB.peak(900);
    check("áudio continua depois da recuperação", afterRecovery > AUDIBLE, `pico=${afterRecovery.toFixed(4)}`);
  } finally {
    cleanup.forEach((fn) => {
      try {
        fn();
      } catch {
        // Encerrando: falha de limpeza não deve esconder o resultado do teste.
      }
    });
    engineA?.close();
    engineB?.close();

    // No `finally` de propósito: quando uma asserção crítica falha o teste sai
    // pela metade, e é justamente aí que se quer o relatório no console.
    const failed = results.filter((r) => !r.ok).length;
    console.log(`[selftest] ${results.length - failed} passaram, ${failed} falharam`);
    for (const result of results) {
      console.log(
        `[selftest] ${result.ok ? "PASS" : "FAIL"} ${result.label}${result.detail ? ` (${result.detail})` : ""}`,
      );
    }
  }
}
