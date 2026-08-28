/**
 * Ajuste do Opus no SDP. O padrão do Chrome é ~32 kb/s mono com FEC desligado:
 * serve pra chamada de telefone, não pra passar a tarde na call. A primeira
 * m-line de áudio é o microfone e a segunda é o som da tela. A ordem é o
 * contrato de slots do motor.
 *
 * Só a linha `a=fmtp` do Opus é reescrita. Mexer em m-line ou payload é o que
 * transforma munging em conexão morta.
 */

const MIC = {
  maxaveragebitrate: "64000",
  stereo: "0",
  "sprop-stereo": "0",
  useinbandfec: "1",
  usedtx: "0",
  maxplaybackrate: "48000",
};

const SCREEN = {
  maxaveragebitrate: "160000",
  stereo: "1",
  "sprop-stereo": "1",
  useinbandfec: "1",
  usedtx: "0",
  maxplaybackrate: "48000",
};

export function tuneAudioSdp(sdp: string | undefined): string | undefined {
  if (!sdp || !sdp.includes("opus/48000")) return sdp;
  let audio = 0;
  return sdp
    .split(/(?=^m=)/m)
    .map((section) =>
      section.startsWith("m=audio") ? withOpus(section, audio++ === 0 ? MIC : SCREEN) : section,
    )
    .join("");
}

function withOpus(section: string, params: Record<string, string>): string {
  const payload = /^a=rtpmap:(\d+) opus\/48000/im.exec(section)?.[1];
  if (!payload) return section;

  const merged = new Map<string, string>();
  const line = new RegExp(`^a=fmtp:${payload} (.*)$`, "im");
  const current = line.exec(section);
  for (const part of (current?.[1] ?? "").split(";")) {
    const [key, value] = part.split("=");
    if (key?.trim()) merged.set(key.trim(), (value ?? "").trim());
  }
  for (const [key, value] of Object.entries(params)) merged.set(key, value);

  const fmtp = `a=fmtp:${payload} ${[...merged]
    .map(([key, value]) => (value ? `${key}=${value}` : key))
    .join(";")}`;

  if (current) return section.replace(line, fmtp);
  const eol = section.includes("\r\n") ? "\r\n" : "\n";
  return section.replace(/^(a=rtpmap:\d+ opus\/48000[^\r\n]*)$/im, `$1${eol}${fmtp}`);
}
