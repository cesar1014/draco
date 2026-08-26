import { audioContext } from "@/rtc/SpeakingDetector";

/**
 * Avisos sonoros gerados na hora, sem arquivo de áudio. Cada nota é uma
 * fundamental com a oitava e uma terceira harmônica fracas por cima, passando
 * num passa-baixa: dá um sino curto em vez do bipe de micro-ondas.
 */

export type Cue = "login" | "join" | "leave" | "mute" | "unmute" | "deafen";

interface Note {
  hz: number;
  /** Atraso em relação ao começo do aviso. */
  at: number;
  len: number;
  level: number;
}

const note = (hz: number, at: number, len: number, level = 1): Note => ({ hz, at, len, level });

/** Terças e quintas: intervalo consonante não incomoda repetido cem vezes por dia. */
const CUES: Record<Cue, Note[]> = {
  login: [note(440, 0, 0.55), note(554.37, 0.085, 0.5), note(659.25, 0.17, 0.7)],
  join: [note(587.33, 0, 0.24), note(880, 0.07, 0.34)],
  leave: [note(783.99, 0, 0.24), note(523.25, 0.075, 0.36)],
  mute: [note(415.3, 0, 0.22, 0.85)],
  unmute: [note(622.25, 0, 0.22, 0.85)],
  deafen: [note(392, 0, 0.22), note(261.63, 0.07, 0.34)],
};

const PARTIALS: readonly [number, number][] = [
  [1, 1],
  [2, 0.22],
  [3, 0.07],
];

let enabled = true;
let volume = 0.7;

export function setSoundsEnabled(value: boolean): void {
  enabled = value;
}

export function setSoundVolume(value: number): void {
  volume = Math.max(0, Math.min(1, value));
}

export function playCue(cue: Cue): void {
  if (!enabled || volume === 0) return;

  const ctx = audioContext();
  // Contexto suspenso não toca nada. Destravar e tocar em seguida é o que faz o
  // som de login existir: ele nasce no mesmo clique que criou o contexto.
  if (ctx.state !== "running") {
    void ctx.resume().then(() => {
      if (ctx.state === "running") render(ctx, cue);
    });
    return;
  }
  render(ctx, cue);
}

function render(ctx: AudioContext, cue: Cue): void {
  const soft = ctx.createBiquadFilter();
  soft.type = "lowpass";
  soft.frequency.value = 5200;

  const master = ctx.createGain();
  master.gain.value = 0.16 * volume;
  soft.connect(master).connect(ctx.destination);

  const start = ctx.currentTime + 0.02;
  for (const item of CUES[cue]) {
    const at = start + item.at;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(item.level, at + 0.014);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + item.len);
    envelope.connect(soft);

    for (const [multiple, amplitude] of PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(item.hz * multiple, at);
      const partial = ctx.createGain();
      partial.gain.value = amplitude;
      osc.connect(partial).connect(envelope);
      osc.start(at);
      osc.stop(at + item.len + 0.05);
    }
  }
}
