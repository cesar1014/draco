/** Leitura de `getStats` reduzida ao que cabe num rótulo de tile. */

export interface PeerStats {
  /** kbit/s recebidos deste par. */
  down: number;
  /** kbit/s enviados para este par. */
  up: number;
  /** Ida e volta em ms, `null` quando o par ainda não reportou. */
  rtt: number | null;
  /** Perda de pacotes recebidos, em porcentagem. */
  loss: number;
  /** Resolução do vídeo que está chegando, quando há vídeo. */
  width: number;
  height: number;
  fps: number;
}

interface Sample {
  at: number;
  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  packetsLost: number;
}

const previous = new Map<string, Sample>();

const kbps = (bytes: number, seconds: number): number =>
  seconds > 0 ? Math.max(0, Math.round((bytes * 8) / seconds / 1000)) : 0;

export async function samplePeer(peerId: string, pc: RTCPeerConnection): Promise<PeerStats | null> {
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }

  const now: Sample = { at: performance.now(), bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsLost: 0 };
  let rtt: number | null = null;
  let width = 0;
  let height = 0;
  let fps = 0;

  report.forEach((entry: any) => {
    if (entry.type === "inbound-rtp" && !entry.isRemote) {
      now.bytesIn += entry.bytesReceived ?? 0;
      now.packetsIn += entry.packetsReceived ?? 0;
      now.packetsLost += entry.packetsLost ?? 0;
      // Maior quadro entre as trilhas: é o que a pessoa está olhando.
      if ((entry.frameHeight ?? 0) > height) {
        width = entry.frameWidth ?? 0;
        height = entry.frameHeight ?? 0;
        fps = Math.round(entry.framesPerSecond ?? 0);
      }
    } else if (entry.type === "outbound-rtp") {
      now.bytesOut += entry.bytesSent ?? 0;
    } else if (entry.type === "candidate-pair" && entry.state === "succeeded") {
      if (typeof entry.currentRoundTripTime === "number") {
        rtt = Math.round(entry.currentRoundTripTime * 1000);
      }
    }
  });

  const before = previous.get(peerId);
  previous.set(peerId, now);
  if (!before) return null;

  const seconds = (now.at - before.at) / 1000;
  const deltaIn = Math.max(0, now.packetsIn - before.packetsIn);
  const deltaLost = Math.max(0, now.packetsLost - before.packetsLost);

  return {
    down: kbps(now.bytesIn - before.bytesIn, seconds),
    up: kbps(now.bytesOut - before.bytesOut, seconds),
    rtt,
    loss: deltaIn + deltaLost > 0 ? Math.round((deltaLost / (deltaIn + deltaLost)) * 100) : 0,
    width,
    height,
    fps,
  };
}

export function forgetStats(peerId?: string): void {
  if (peerId) previous.delete(peerId);
  else previous.clear();
}

/** Verde / amarelo / vermelho para o indicador de qualidade. */
export function statsGrade(stats: PeerStats | undefined): "good" | "ok" | "bad" {
  if (!stats) return "ok";
  if (stats.loss >= 5 || (stats.rtt !== null && stats.rtt >= 200)) return "bad";
  if (stats.loss >= 2 || (stats.rtt !== null && stats.rtt >= 100)) return "ok";
  return "good";
}
