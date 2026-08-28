/**
 * Ponte com o app de desktop (Electron), quando é ele que está exibindo a página.
 *
 * No navegador `window.desktop` simplesmente não existe: `isDesktopApp()` dá
 * falso, `listDesktopSources()` devolve lista vazia e `claimDesktopSource()`
 * responde que não há nada a reservar. É assim que a mesma build serve pros dois
 * — o app ganha o seletor de miniaturas com as janelas abertas, e o link que você
 * manda pros amigos continua funcionando sem uma linha de diferença.
 *
 * Quem preenche isso é `desktop/preload.js`, via `contextBridge`.
 */

export interface DesktopSource {
  /** Id do Electron, no formato `screen:0:0` ou `window:12345:0`. */
  id: string;
  /** Nome cru do sistema. */
  name: string;
  /** O mesmo nome, mas em português quando é uma tela ("Tela 1"). É o que a pessoa lê. */
  label: string;
  /** PNG em data URL, pronto pro `src` de um `<img>`. Vazio se a janela está minimizada. */
  thumbnail: string;
  /** Ícone do programa, quando o sistema informa. */
  appIcon: string | null;
  isScreen: boolean;
}

/** Por que a fonte escolhida não pôde ser reservada pra próxima captura. */
export type ClaimFailure = "gone" | "denied" | "invalid" | "failed" | "unavailable";

export type ClaimResult = { ok: true } | { ok: false; reason: ClaimFailure };

/** Contexto de uma falha de captura, pro console do app — nunca pra interface. */
export interface CaptureFailure {
  stage: "claim" | "getDisplayMedia" | "systemAudio";
  name: string;
  message: string;
  sourceId: string;
  sourceKind: "screen" | "window" | "browser";
  systemAudio: boolean;
}

interface DesktopBridge {
  /** Versão do Electron, só pra aparecer nas configurações. */
  version: string;
  platform: string;
  listSources: () => Promise<DesktopSource[]>;
  selectSource: (request: { sourceId: string; systemAudio: boolean }) => Promise<ClaimResult>;
  logCaptureFailure: (report: CaptureFailure) => Promise<void>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export const isDesktopApp = (): boolean => Boolean(window.desktop);

export const desktopVersion = (): string | null => window.desktop?.version ?? null;

export const desktopPlatform = (): string | null => window.desktop?.platform ?? null;

export const listDesktopSources = async (): Promise<DesktopSource[]> =>
  (await window.desktop?.listSources()) ?? [];

/**
 * Reserva no processo principal a fonte que o próximo `getDisplayMedia` deve
 * devolver. Precisa ser em dois passos porque o `getDisplayMedia` não aceita
 * "quero esta janela" como argumento — quem escolhe é sempre o lado privilegiado,
 * e o Electron é o único que tem esse lado.
 *
 * O id vale mais que o objeto que veio na listagem: entre escolher a miniatura e
 * clicar em compartilhar a janela pode ter sido fechada, e é por isso que o
 * processo principal reconfere e responde `gone` em vez de conceder um handle
 * morto — que capturaria nada, sem erro que explique o porquê.
 */
export async function claimDesktopSource(
  sourceId: string,
  systemAudio: boolean,
): Promise<ClaimResult> {
  const bridge = window.desktop;
  if (!bridge) return { ok: false, reason: "unavailable" };
  try {
    return await bridge.selectSource({ sourceId, systemAudio });
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export function reportCaptureFailure(report: CaptureFailure): void {
  void window.desktop?.logCaptureFailure(report).catch(() => {});
}
