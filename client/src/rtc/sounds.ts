import { audioContext } from "@/rtc/SpeakingDetector";

/**
 * Avisos sonoros gerados na hora, sem arquivo de áudio: dois osciladores e um
 * envelope. Evita carregar mp3 e mantém o volume igual em qualquer navegador.
 */

export type Cue = "join" | "leave" | "mute" | "unmute" | "deafen";

const CUES: Record<Cue, { notes: number[]; length: number; gain: number; type: OscillatorType }> = {
  join: { notes: [523.25, 783.99], length: 0.11, gain: 0.16, type: "sine" },
  leave: { notes: [523.25, 349.23], length: 0.13, gain: 0.16, type: "sine" },
  mute: { notes: [392], length: 0.07, gain: 0.12, type: "triangle" },
  unmute: { notes: [587.33], length: 0.07, gain: 0.12, type: "triangle" },
  deafen: { notes: [329.63, 246.94], length: 0.09, gain: 0.12, type: "triangle" },
};

let enabled = true;

export function setSoundsEnabled(value: boolean): void {
  enabled = value;
}

export function playCue(cue: Cue): void {
  if (!enabled) return;

  const ctx = audioContext();
  // Contexto suspenso ignora `start()` em silêncio; nada a fazer até haver gesto.
  if (ctx.state !== "running") return;

  const { notes, length, gain, type } = CUES[cue];
  notes.forEach((frequency, index) => {
    const at = ctx.currentTime + index * length;
    const osc = ctx.createOscillator();
    const envelope = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);

    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(gain, at + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);

    osc.connect(envelope).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length + 0.02);
  });
}
