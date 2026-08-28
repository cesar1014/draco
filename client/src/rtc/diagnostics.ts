import { loadIceConfig, runIceDiagnostics } from "@/rtc/iceConfig";
import type { IceConfigResponse } from "@/types";

/**
 * Diagnóstico de conexão, o que está atrás do botão "Testar minha conexão".
 *
 * Regra que vale pra tudo aqui: nada é estimado. Cada item só reporta o que foi
 * possível medir de fato, e o que não pôde ser medido volta como `unknown` em vez
 * de um número inventado. Um relatório que diz "ping: 40 ms" sem ter medido nada
 * é pior que um que diz "não deu pra medir": o primeiro manda a pessoa procurar
 * o problema no lugar errado.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface Check {
  id: "ping" | "turn" | "ice" | "mic" | "camera";
  label: string;
  status: CheckStatus;
  /** Frase curta pra tela. Detalhe técnico fica no console, não aqui. */
  detail: string;
}

export type Verdict = "excelente" | "boa" | "limitada" | "problemas";

export interface DiagnosticsReport {
  verdict: Verdict;
  checks: Check[];
}

/** Acima disso a conversa começa a ficar desconfortável. */
const PING_WARN_MS = 150;
const PING_OK_MS = 80;

/**
 * Ida e volta até o servidor, medida em requisições HTTP curtas. Não é o RTT da
 * mídia — essa passa por TURN ou direto pelo par — mas é a única medida honesta
 * antes de a call existir, e é o que separa "internet ruim" de "servidor longe".
 */
async function measurePing(): Promise<Check> {
  const samples: number[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const started = performance.now();
    try {
      const response = await fetch(`/api/config?probe=${started}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.arrayBuffer();
      samples.push(performance.now() - started);
    } catch {
      // Uma amostra perdida não invalida a medida; todas perdidas, sim.
    }
  }

  if (samples.length === 0) {
    return {
      id: "ping",
      label: "Servidor",
      status: "fail",
      detail: "O servidor não respondeu.",
    };
  }

  // A mediana, não a média: um pico de garbage collection ou de Wi-Fi numa das
  // amostras dobraria a média e faria uma conexão boa parecer ruim.
  const sorted = [...samples].sort((a, b) => a - b);
  const median = Math.round(sorted[Math.floor(sorted.length / 2)]);
  const lost = 4 - samples.length;

  const status: CheckStatus = median <= PING_OK_MS && !lost ? "ok" : median <= PING_WARN_MS ? "warn" : "fail";
  return {
    id: "ping",
    label: "Servidor",
    status,
    detail:
      `${median} ms até o servidor` +
      (lost ? `, ${lost} de 4 tentativas sem resposta` : "") +
      (status === "ok" ? "." : status === "warn" ? ". Dá pra conversar." : ". A call pode travar."),
  };
}

/** O que a rede permite: STUN respondendo, TURN de pé, caminho nenhum. */
async function probeIce(config: IceConfigResponse): Promise<Check[]> {
  const turn: Check = config.hasTurn
    ? {
        id: "turn",
        label: "Servidor de retransmissão (TURN)",
        status: "ok",
        detail: "Configurado: a call atravessa rede corporativa e 4G.",
      }
    : {
        id: "turn",
        label: "Servidor de retransmissão (TURN)",
        status: "warn",
        detail: "Ausente. Funciona na maioria das redes domésticas, mas pode falhar em outras.",
      };

  let found: Awaited<ReturnType<typeof runIceDiagnostics>>;
  try {
    found = await runIceDiagnostics(config);
  } catch {
    return [
      turn,
      {
        id: "ice",
        label: "Caminhos de rede",
        status: "unknown",
        detail: "Não foi possível testar os caminhos de rede neste navegador.",
      },
    ];
  }

  const ice: Check = found.relay
    ? { id: "ice", label: "Caminhos de rede", status: "ok", detail: "Direto e por retransmissão, os dois disponíveis." }
    : found.srflx
      ? {
          id: "ice",
          label: "Caminhos de rede",
          status: config.hasTurn ? "warn" : "ok",
          detail: config.hasTurn
            ? "Caminho direto disponível; a retransmissão não respondeu."
            : "Caminho direto disponível."
        }
      : found.host
        ? {
            id: "ice",
            label: "Caminhos de rede",
            status: "fail",
            detail: "Só a rede local respondeu. Chamada com quem está fora dela provavelmente não conecta.",
          }
        : {
            id: "ice",
            label: "Caminhos de rede",
            status: "fail",
            detail: "Nenhum caminho de rede foi encontrado.",
          };

  return [turn, ice];
}

/**
 * Existe microfone e a permissão foi concedida. Abre e fecha na hora: um teste que
 * deixa o dispositivo aberto apareceria como "microfone em uso" pro resto do
 * sistema, e num app de call é o tipo de sobra que ninguém liga com a causa.
 */
async function probeDevice(kind: "mic" | "camera"): Promise<Check> {
  const label = kind === "mic" ? "Microfone" : "Câmera";
  if (!navigator.mediaDevices?.getUserMedia) {
    return { id: kind, label, status: "unknown", detail: "Este navegador não dá acesso aos dispositivos." };
  }

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia(
      kind === "mic" ? { audio: true } : { video: true },
    );
    const track = stream.getTracks()[0];
    const detail = track?.label ? `Funcionando: ${track.label}.` : "Funcionando.";
    return { id: kind, label, status: "ok", detail };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return { id: kind, label, status: "warn", detail: "Permissão negada pelo navegador." };
    }
    if (name === "NotFoundError") {
      return {
        id: kind,
        label,
        status: kind === "mic" ? "fail" : "warn",
        detail: "Nenhum dispositivo encontrado.",
      };
    }
    if (name === "NotReadableError") {
      return { id: kind, label, status: "warn", detail: "Em uso por outro programa." };
    }
    return { id: kind, label, status: "unknown", detail: "Não foi possível testar agora." };
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

/**
 * O veredito é o pior resultado que apareceu, não uma média: uma conexão com o
 * caminho de rede quebrado não é "boa em média", é uma call que não conecta.
 * Microfone e câmera pesam menos, porque negar a permissão agora não impede
 * ninguém de concedê-la ao entrar na call.
 */
function summarize(checks: Check[]): Verdict {
  const critical = checks.filter((check) => check.id !== "mic" && check.id !== "camera");
  if (critical.some((check) => check.status === "fail")) return "problemas";
  if (checks.some((check) => check.id === "mic" && check.status === "fail")) return "problemas";
  if (checks.some((check) => check.status === "warn")) return "limitada";
  if (critical.every((check) => check.status === "ok")) {
    return checks.every((check) => check.status === "ok") ? "excelente" : "boa";
  }
  return "boa";
}

/**
 * Roda o diagnóstico inteiro. Ping e dispositivos em paralelo com o teste de
 * rede, porque juntos levam uns oito segundos e em sequência levariam vinte, o
 * que ninguém espera olhando uma tela de configurações.
 */
export async function runConnectionDiagnostics(): Promise<DiagnosticsReport> {
  const config = await loadIceConfig();
  const [ping, iceChecks, mic, camera] = await Promise.all([
    measurePing(),
    probeIce(config),
    probeDevice("mic"),
    probeDevice("camera"),
  ]);

  const checks = [ping, ...iceChecks, mic, camera];
  return { verdict: summarize(checks), checks };
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  excelente: "Excelente",
  boa: "Boa",
  limitada: "Limitada",
  problemas: "Problemas detectados",
};
