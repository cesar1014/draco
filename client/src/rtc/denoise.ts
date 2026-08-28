import workletUrl from "@/rtc/denoise-worklet.js?url";
import { audioContext, resumeAudio } from "@/rtc/SpeakingDetector";

/**
 * Caminho do microfone quando a redução de ruído é a nossa: passa-alta pra tirar
 * o ronco da mesa, o worklet espectral, e sai num stream novo que a call envia
 * no lugar do dispositivo.
 */

export type DenoiseMode = "off" | "browser" | "draco";
export type DenoiseStrength = "light" | "medium" | "strong";

export const DENOISE_MODES: readonly DenoiseMode[] = ["off", "browser", "draco"] as const;
export const DENOISE_STRENGTHS: readonly DenoiseStrength[] = ["light", "medium", "strong"] as const;

/**
 * Quanto sobra do ruído (`floor`), quanto sobra dele na faixa da voz
 * (`voiceFloor`) e quanto sobra entre as frases (`gate`).
 *
 * Os dois pisos separados são o que permite ao `strong` ser forte de verdade sem
 * ficar ininteligível: fora de 250–3800 Hz ele corta fundo, porque ali não há
 * fala pra preservar, e dentro da banda ele segura a mão, porque é onde estão as
 * consoantes surdas — s, f, ch, t têm pouca energia e somem antes do ruído.
 *
 * `medium` continua sendo o padrão: apaga ventilador, ar-condicionado e cooler
 * sem que ninguém note que há filtro.
 */
const PRESETS: Record<DenoiseStrength, { floor: number; voiceFloor: number; gate: number }> = {
  light: { floor: 0.36, voiceFloor: 0.4, gate: 0.5 },
  medium: { floor: 0.14, voiceFloor: 0.2, gate: 0.24 },
  strong: { floor: 0.03, voiceFloor: 0.1, gate: 0.08 },
};

/**
 * Ponto de troca do processamento de voz. Hoje há uma implementação, a espectral
 * daqui, e é por isso que a interface é pequena: quando entrar um denoise neural
 * (RNNoise em WASM, por exemplo), ele só precisa aceitar um stream, devolver
 * outro e responder a uma mudança de força.
 *
 * Nada é carregado antecipadamente: o módulo do worklet entra na primeira vez que
 * alguém liga o filtro, e um WASM de centenas de kilobytes seguiria a mesma
 * regra, sem pesar em quem só quer entrar na call.
 */
export interface VoiceProcessor {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack | null;
  tune(strength: DenoiseStrength): void;
  close(): void;
}

let loading: Promise<boolean> | null = null;

/** O módulo entra uma vez por contexto. Falhou, o chamador cai na do navegador. */
export function loadDenoise(): Promise<boolean> {
  loading ??= (async () => {
    const ctx = audioContext();
    if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") return false;
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      return true;
    } catch (error) {
      console.warn("[audio] redução de ruído própria indisponível:", error);
      return false;
    }
  })();
  return loading;
}

export class MicChain implements VoiceProcessor {
  readonly #source: MediaStreamAudioSourceNode;
  readonly #highpass: BiquadFilterNode;
  readonly #node: AudioWorkletNode;
  readonly #output: MediaStreamAudioDestinationNode;

  constructor(input: MediaStream, strength: DenoiseStrength) {
    const ctx = audioContext();
    // Contexto suspenso não deixa nada passar, e a call sairia muda.
    resumeAudio();

    this.#source = ctx.createMediaStreamSource(input);
    this.#highpass = ctx.createBiquadFilter();
    this.#highpass.type = "highpass";
    this.#highpass.frequency.value = 85;
    this.#highpass.Q.value = 0.7;

    this.#node = new AudioWorkletNode(ctx, "draco-denoise", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: PRESETS[strength],
    });

    this.#output = ctx.createMediaStreamDestination();
    this.#output.channelCount = 1;
    this.#source.connect(this.#highpass).connect(this.#node).connect(this.#output);
  }

  get stream(): MediaStream {
    return this.#output.stream;
  }

  get track(): MediaStreamTrack | null {
    return this.#output.stream.getAudioTracks()[0] ?? null;
  }

  /** Trocar a força é uma mensagem, não um caminho novo: a fala não corta. */
  tune(strength: DenoiseStrength): void {
    this.#node.port.postMessage(PRESETS[strength]);
  }

  close(): void {
    this.#node.port.onmessage = null;
    this.#source.disconnect();
    this.#highpass.disconnect();
    this.#node.disconnect();
    this.#output.stream.getTracks().forEach((track) => track.stop());
  }
}
