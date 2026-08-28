/**
 * Ponte com o app de desktop (Electron), quando é ele que está exibindo a página.
 *
 * No navegador `window.desktop` simplesmente não existe: `isDesktopApp()` dá
 * falso, `listDesktopSources()` devolve lista vazia e `claimDesktopSource()`
 * responde que não há nada a reservar. É assim que a mesma build serve pros dois:
 * o app ganha o seletor de miniaturas com as janelas abertas, e o link que você
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

/** Contexto de uma falha de captura, pro console do app, nunca pra interface. */
export interface CaptureFailure {
  stage: "claim" | "getDisplayMedia" | "systemAudio";
  name: string;
  message: string;
  sourceId: string;
  sourceKind: "screen" | "window" | "browser";
  systemAudio: boolean;
}

/** Versão instalada e, quando houver, a publicada. */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  /** Página da release. `null` quando o app não confirmou a origem do link. */
  url: string | null;
  notes: string | null;
}

/**
 * O que o app oferece à página.
 *
 * `platform` e `logCaptureFailure` só existem a partir da 1.1.0, e `checkUpdate`
 * e `openRelease` a partir da 1.2.0. Não há auto-update, então um app instalado
 * antes disso continua abrindo esta mesma página, porque é a publicada. Declarar
 * cada um como opcional é o que faz o compilador cobrar a checagem em cada uso,
 * em vez de deixar a falha pra alguém descobrir compartilhando a tela.
 */
interface DesktopBridge {
  /** Versão do Electron, só pra aparecer nas configurações. */
  version: string;
  platform?: string;
  listSources: () => Promise<DesktopSource[]>;
  /** `id` e `name` são o formato que a 1.0.0 exigia; `undefined` é a resposta dela. */
  selectSource: (request: {
    sourceId: string;
    systemAudio: boolean;
    id: string;
    name: string;
  }) => Promise<ClaimResult | undefined>;
  logCaptureFailure?: (report: CaptureFailure) => Promise<void>;
  checkUpdate?: () => Promise<UpdateStatus | null>;
  openRelease?: () => Promise<boolean>;
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
 * "quero esta janela" como argumento: quem escolhe é sempre o lado privilegiado,
 * e o Electron é o único que tem esse lado.
 *
 * Guarda o id, não o objeto que veio na listagem: entre escolher a miniatura e
 * clicar em compartilhar a janela pode ter sido fechada, e é por isso que o
 * processo principal reconfere e responde `gone` em vez de conceder um handle
 * morto, que capturaria nada, sem erro que explique o porquê.
 */
export async function claimDesktopSource(
  sourceId: string,
  systemAudio: boolean,
): Promise<ClaimResult> {
  const bridge = window.desktop;
  if (!bridge) return { ok: false, reason: "unavailable" };
  try {
    // Os campos antigos vão junto porque o app até a 1.0.0 exigia `{ id, name }`
    // e ignora `sourceId`: sem eles, ele não reserva nada e a captura devolve a
    // tela errada ou nenhuma. Quem escolhe é sempre o id, o nome só precisa ser
    // texto pra passar pela validação de lá.
    const claim = await bridge.selectSource({
      sourceId,
      systemAudio,
      id: sourceId,
      name: sourceId,
    });
    // E aquele app reservava a fonte sem responder nada. Ler o silêncio como
    // falha tiraria dele o compartilhamento de tela inteiro.
    return claim ?? { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export function reportCaptureFailure(report: CaptureFailure): void {
  // O `?.` no método, e não só na ponte: até a 1.0.0 esta função não existia, e
  // chamar o que não existe estouraria aqui, em cima da falha de captura que
  // esta linha deveria estar registrando, escondendo justamente o erro que
  // importa.
  void window.desktop?.logCaptureFailure?.(report)?.catch(() => {});
}

/**
 * Pergunta ao app se há versão nova. `null` quando não é o app, quando ele é
 * antigo demais pra saber responder, ou quando a verificação não deu certo — e
 * nos três casos a interface simplesmente não mostra nada sobre atualização.
 */
export async function checkDesktopUpdate(): Promise<UpdateStatus | null> {
  try {
    return (await window.desktop?.checkUpdate?.()) ?? null;
  } catch {
    return null;
  }
}

/** Pede ao app pra abrir a página da release no navegador do sistema. */
export async function openDesktopRelease(): Promise<boolean> {
  try {
    return (await window.desktop?.openRelease?.()) === true;
  } catch {
    return false;
  }
}
