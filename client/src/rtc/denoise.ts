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

/** `floor` é o quanto sobra do ruído; `gate` é o quanto sobra entre as frases. */
const PRESETS: Record<DenoiseStrength, { floor: number; gate: number }> = {
  light: { floor: 0.36, gate: 0.5 },
  medium: { floor: 0.16, gate: 0.24 },
  strong: { floor: 0.06, gate: 0.09 },
};

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

export class MicChain {
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
