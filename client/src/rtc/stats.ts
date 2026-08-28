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
  /**
   * Perda que o outro lado relatou do que saiu daqui, em porcentagem. É esta, e
   * não a de recepção, que diz que o seu upload está estourando.
   */
  sendLoss: number;
  /** Banda de subida que o navegador estima disponível, em kbit/s. `null` se não informa. */
  available: number | null;
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
  packetsOut: number;
  packetsLostOut: number;
}

const previous = new Map<string, Sample>();

const kbps = (bytes: number, seconds: number): number =>
  seconds > 0 ? Math.max(0, Math.round((bytes * 8) / seconds / 1000)) : 0;

const percent = (lost: number, total: number): number =>
  total + lost > 0 ? Math.round((lost / (total + lost)) * 100) : 0;

/**
 * Um recorte de uma conexão. Em malha cada conexão é uma pessoa e o recorte é a
 * conexão inteira; com SFU uma única conexão carrega a call toda, e é o `mid` de
 * cada trilha que diz de quem é o que está chegando.
 */
export interface StatsScope {
  key: string;
  /** `undefined` pega tudo. */
  mids?: ReadonlySet<string>;
}

export async function sampleScopes(
  pc: RTCPeerConnection,
  scopes: StatsScope[],
): Promise<Array<readonly [string, PeerStats]>> {
  if (scopes.length === 0) return [];

  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return [];
  }

  const at = performance.now();
  const results: Array<readonly [string, PeerStats]> = [];

  // Ida e volta e banda estimada são da conexão, não da trilha: valem pra todos
  // os recortes dela.
  let pairRtt: number | null = null;
  let available: number | null = null;
  report.forEach((entry: any) => {
    if (entry.type !== "candidate-pair" || entry.state !== "succeeded") return;
    if (typeof entry.currentRoundTripTime === "number") {
      pairRtt = Math.round(entry.currentRoundTripTime * 1000);
    }
    if (typeof entry.availableOutgoingBitrate === "number") {
      available = Math.round(entry.availableOutgoingBitrate / 1000);
    }
  });
  for (const scope of scopes) {
    const now: Sample = {
      at,
      bytesIn: 0,
      bytesOut: 0,
      packetsIn: 0,
      packetsLost: 0,
      packetsOut: 0,
      packetsLostOut: 0,
    };
    let rtt: number | null = pairRtt;
    let width = 0;
    let height = 0;
    let fps = 0;
    let sentWidth = 0;
    let sentHeight = 0;
    let sentFps = 0;
    const mine = (entry: any) => !scope.mids || (entry.mid && scope.mids.has(entry.mid));

    report.forEach((entry: any) => {
      if (entry.type === "inbound-rtp" && !entry.isRemote) {
        if (!mine(entry)) return;
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
        if (!mine(entry)) return;
        now.bytesOut += entry.bytesSent ?? 0;
        now.packetsOut += entry.packetsSent ?? 0;
        if ((entry.frameHeight ?? 0) > sentHeight) {
          sentWidth = entry.frameWidth ?? 0;
          sentHeight = entry.frameHeight ?? 0;
          sentFps = Math.round(entry.framesPerSecond ?? 0);
        }
      } else if (entry.type === "remote-inbound-rtp") {
        if (!mine(entry)) return;
        // O que o outro lado diz que perdeu do que saiu daqui.
        now.packetsLostOut += entry.packetsLost ?? 0;
        if (typeof entry.roundTripTime === "number") rtt = Math.round(entry.roundTripTime * 1000);
      }
    });

    const before = previous.get(scope.key);
    previous.set(scope.key, now);
    if (!before) continue;

    const seconds = (now.at - before.at) / 1000;

    results.push([
      scope.key,
      {
        down: kbps(now.bytesIn - before.bytesIn, seconds),
        up: kbps(now.bytesOut - before.bytesOut, seconds),
        rtt,
        loss: percent(
          Math.max(0, now.packetsLost - before.packetsLost),
          Math.max(0, now.packetsIn - before.packetsIn),
        ),
        sendLoss: percent(
          Math.max(0, now.packetsLostOut - before.packetsLostOut),
          Math.max(0, now.packetsOut - before.packetsOut),
        ),
        available,
        // Só o que está subindo quando nada desce: é o caso do próprio tile.
        width: height ? width : sentWidth,
        height: height || sentHeight,
        fps: height ? fps : sentFps,
      },
    ] as const);
  }

  return results;
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
