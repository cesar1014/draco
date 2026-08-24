/**
 * Ponte com o app de desktop (Electron), quando é ele que está exibindo a página.
 *
 * No navegador `window.desktop` simplesmente não existe: `isDesktopApp()` dá
 * falso, `listDesktopSources()` devolve lista vazia e `selectDesktopSource()`
 * não faz nada. É assim que a mesma build serve pros dois — o app ganha o
 * seletor de miniaturas com as janelas abertas, e o link que você manda pros amigos
 * continua funcionando sem uma linha de diferença.
 *
 * Quem preenche isso é `desktop/preload.js`, via `contextBridge`.
 */

export interface DesktopSource {
  /** Id do Electron, no formato `screen:0:0` ou `window:12345:0`. */
  id: string;
  /** Nome cru do sistema. Vai de volta pro Electron na hora de conceder a captura. */
  name: string;
  /** O mesmo nome, mas em português quando é uma tela ("Tela 1"). É o que a pessoa lê. */
  label: string;
  /** PNG em data URL, pronto pro `src` de um `<img>`. Vazio se a janela está minimizada. */
  thumbnail: string;
  /** Ícone do programa, quando o sistema informa. */
  appIcon: string | null;
  isScreen: boolean;
}

interface DesktopBridge {
  /** Versão do app, só pra aparecer nas configurações. */
  version: string;
  listSources: () => Promise<DesktopSource[]>;
  selectSource: (source: { id: string; name: string }) => Promise<void>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export const isDesktopApp = (): boolean => Boolean(window.desktop);

export const desktopVersion = (): string | null => window.desktop?.version ?? null;

export const listDesktopSources = async (): Promise<DesktopSource[]> =>
  (await window.desktop?.listSources()) ?? [];

/**
 * Registra no processo principal qual fonte a próxima chamada de
 * `getDisplayMedia` deve devolver. Precisa ser em dois passos porque o
 * `getDisplayMedia` não aceita "quero esta janela" como argumento — quem escolhe
 * é sempre o lado privilegiado, e o Electron é o único que tem esse lado.
 */
export const selectDesktopSource = (source: DesktopSource): Promise<void> =>
  window.desktop?.selectSource({ id: source.id, name: source.name }) ?? Promise.resolve();
