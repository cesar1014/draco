/**
 * Um `AudioContext` pra aplicação inteira. Navegador limita quantos existem, e
 * cada um custa uma thread de áudio — criar por usuário derrubaria a call.
 */
let shared: AudioContext | null = null;

export function audioContext(): AudioContext {
  shared ??= new AudioContext();
  return shared;
}

/**
 * Navegador começa com o áudio suspenso até haver gesto do usuário. Chamar isso
 * em todo clique é barato e evita o clássico "entrei na call e não ouço ninguém".
 */
export function resumeAudio(): void {
  const ctx = shared;
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

/** Acima disso começa a falar. */
const SPEAK_ON_DB = -45;
/** Abaixo disso pode parar — a folga entre os dois evita o anel piscando. */
const SPEAK_OFF_DB = -55;
/** Silêncio precisa durar isso pra apagar; senão o anel apaga entre sílabas. */
const RELEASE_MS = 250;
const SAMPLE_INTERVAL_MS = 60;

/**
 * Escuta o próprio microfone e avisa quando começa e para de falar.
 *
 * Roda em `setInterval`, não em `requestAnimationFrame`, de propósito: o rAF
 * congela quando a aba vai pro fundo, e aí você continuaria "falando" pros
 * outros enquanto usa outra janela.
 */
export class SpeakingDetector {
  #analyser: AnalyserNode;
  #source: MediaStreamAudioSourceNode;
  // O `ArrayBuffer` explícito não é enfeite: a Web Audio API recusa view sobre
  // `SharedArrayBuffer`, e é isso que o tipo genérico está registrando.
  #buffer: Float32Array<ArrayBuffer>;
  #timer: ReturnType<typeof setInterval>;
  #speaking = false;
  #quietSince = 0;
  #level = 0;

  constructor(stream: MediaStream, private onChange: (speaking: boolean) => void) {
    const ctx = audioContext();
    this.#source = ctx.createMediaStreamSource(stream);
    this.#analyser = ctx.createAnalyser();
    this.#analyser.fftSize = 512;
    this.#analyser.smoothingTimeConstant = 0.2;
    this.#source.connect(this.#analyser);
    // Sem `connect(ctx.destination)`: analisar não pode devolver o próprio som
    // pro alto-falante, senão a pessoa se ouve com atraso.
    this.#buffer = new Float32Array(new ArrayBuffer(this.#analyser.fftSize * 4));
    this.#timer = setInterval(() => this.#sample(), SAMPLE_INTERVAL_MS);
  }

  /** Volume atual de 0 a 1, pro medidor da tela de configurações. */
  get level(): number {
    return this.#level;
  }

  #sample(): void {
    this.#analyser.getFloatTimeDomainData(this.#buffer);

    let sum = 0;
    for (const value of this.#buffer) sum += value * value;
    const rms = Math.sqrt(sum / this.#buffer.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

    // Faixa de -60 dB a 0 dB achatada em 0..1 — é o que o olho lê bem numa barra.
    this.#level = Math.max(0, Math.min(1, (db + 60) / 60));

    const now = Date.now();
    if (db > SPEAK_ON_DB) {
      this.#quietSince = 0;
      this.#set(true);
    } else if (db < SPEAK_OFF_DB) {
      if (this.#quietSince === 0) this.#quietSince = now;
      if (now - this.#quietSince >= RELEASE_MS) this.#set(false);
    }
  }

  #set(speaking: boolean): void {
    if (this.#speaking === speaking) return;
    this.#speaking = speaking;
    this.onChange(speaking);
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#source.disconnect();
    this.#analyser.disconnect();
    if (this.#speaking) this.onChange(false);
  }
}
