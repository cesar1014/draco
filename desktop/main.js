"use strict";

const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } = require("electron");
const path = require("node:path");

/**
 * Processo principal do app de desktop.
 *
 * O app é uma janela dedicada em volta do **mesmo site** que está no ar — não uma
 * segunda versão do projeto. Isso importa por dois motivos: você continua tendo
 * um link pra mandar pros amigos (eles não instalam nada), e não existe risco de
 * o app e o navegador falarem protocolos diferentes, porque é o mesmo código.
 *
 * O que só o app tem é privilégio de sistema. `getDisplayMedia`, num navegador,
 * obriga o diálogo do próprio navegador — é barreira de segurança, não descuido.
 * Aqui o Electron deixa a gente responder àquele pedido no lugar dele
 * (`setDisplayMediaRequestHandler`), e é exatamente por isso que o app de
 * verdade consegue ter o seletor de miniaturas: ele também é Electron.
 */

/** Endereço publicado. `DESKTOP_URL` ou `--url=` mandam mais, pra apontar pro localhost em teste. */
const DEFAULT_URL = "https://dracocall.duckdns.org";

const urlFromArgv = process.argv.find((arg) => arg.startsWith("--url="))?.slice(6);
const APP_URL = (urlFromArgv || process.env.DESKTOP_URL || DEFAULT_URL).trim().replace(/\/+$/, "");
const APP_ORIGIN = new URL(APP_URL).origin;

/** Comparação por origem, não por texto: barra no fim e caminho não podem enganar. */
function sameOrigin(value) {
  try {
    return new URL(value).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Captura escolhida no seletor de miniaturas, esperando o `getDisplayMedia` que
 * vem logo atrás. É um passo em dois tempos porque `getDisplayMedia` não aceita
 * "quero esta janela" como argumento: quem decide é sempre o lado privilegiado.
 *
 * Guarda o id, não o objeto que o `desktopCapturer` devolveu. Entre escolher e
 * capturar a janela pode ter sido fechada ou reaberta, e conceder um handle velho
 * resulta em captura de nada — sem erro que ajude a entender o porquê.
 */
let pendingCapture = null;

/** Handle atual daquele id, ou `null` quando a tela/janela não existe mais. */
async function findSource(sourceId) {
  const types = sourceId.startsWith("screen:") ? ["screen"] : ["window"];
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.find((source) => source.id === sourceId) ?? null;
}

/** Permissões que o app concede à própria página. O resto é recusado. */
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "audioCapture",
  "videoCapture",
  "display-capture",
  "speaker-selection",
  "fullscreen",
  "clipboard-sanitized-write",
  "notifications",
]);

function configureSession(ses) {
  // Sem isto o Chromium pergunta, e não há a quem perguntar num app. Conceder só
  // pra nossa origem é o que mantém a coisa fechada: se a página for substituída
  // por outra qualquer, ela não herda câmera, microfone nem captura de tela.
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && sameOrigin(contents.getURL()));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && sameOrigin(requestingOrigin);
  });

  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const capture = pendingCapture;
      pendingCapture = null;

      if (!capture) {
        // Ninguém escolheu nada: não há o que conceder. Acontece só se a página
        // pedir captura sem passar pelo painel — e aí não compartilhar é o certo,
        // porque mostrar a tela errada é pior que não mostrar nenhuma.
        callback({});
        return;
      }

      let source = null;
      try {
        source = await findSource(capture.sourceId);
      } catch (error) {
        console.error("[desktop] falha ao reler as fontes de captura:", error);
      }

      if (!source) {
        console.warn(`[desktop] fonte ${capture.sourceId} sumiu antes da captura`);
        callback({});
        return;
      }

      // `loopback` é o som do sistema, e só existe no Windows. Em outro sistema,
      // pedir isso não daria erro visível — viria uma trilha muda, que é pior:
      // a pessoa acha que mandou o áudio do jogo e ninguém ouviu nada.
      const loopback =
        request.audioRequested && capture.systemAudio && process.platform === "win32";

      callback({ video: source, ...(loopback ? { audio: "loopback" } : {}) });
    },
    // O seletor de miniaturas é o nosso; o do sistema abriria em cima dele.
    { useSystemPicker: false },
  );
}

/** Telas e janelas abertas, com miniatura em PNG pronta pro `<img>` da página. */
ipcMain.handle("desktop:list-sources", async (event) => {
  if (!sameOrigin(event.senderFrame?.url ?? "")) return [];

  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });

  return sources.map((source) => {
    const isScreen = source.id.startsWith("screen:");
    return {
      id: source.id,
      // `name` é o que o Electron precisa de volta na hora de conceder, então vai
      // cru. `label` é o que a pessoa lê — daí traduzir só ele.
      name: source.name,
      label: isScreen
        ? source.name.replace(/^Entire screen$/i, "Tela inteira").replace(/^Screen (\d+)$/i, "Tela $1")
        : source.name,
      // Janela minimizada devolve miniatura vazia; a página desenha um ícone.
      thumbnail: source.thumbnail.isEmpty() ? "" : source.thumbnail.toDataURL(),
      appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
      isScreen,
    };
  });
});

/**
 * Marca a fonte do próximo `getDisplayMedia` e confirma, ali mesmo, que ela ainda
 * existe. Validar aqui — e não só na hora de conceder — é o que permite à página
 * dizer "essa janela foi fechada" em vez de mostrar uma falha de permissão que
 * não tem nada a ver com permissão.
 */
ipcMain.handle("desktop:select-source", async (event, request) => {
  if (!sameOrigin(event.senderFrame?.url ?? "")) return { ok: false, reason: "denied" };
  // Só o que precisamos, e só do tipo certo: o que chega aqui vem do renderer, e
  // repassar objeto inteiro de outro processo pra dentro do Electron é convite.
  if (!request || typeof request.sourceId !== "string") return { ok: false, reason: "invalid" };

  try {
    if (!(await findSource(request.sourceId))) {
      pendingCapture = null;
      return { ok: false, reason: "gone" };
    }
  } catch (error) {
    console.error("[desktop] falha ao validar a fonte escolhida:", error);
    return { ok: false, reason: "failed" };
  }

  pendingCapture = { sourceId: request.sourceId, systemAudio: request.systemAudio === true };
  return { ok: true };
});

/**
 * Diagnóstico de captura no console do app. Fica aqui, e não na interface: quem
 * está na call quer uma frase útil, não `name`, `sourceId` e etapa da falha.
 */
ipcMain.handle("desktop:log-capture-failure", (event, report) => {
  if (!sameOrigin(event.senderFrame?.url ?? "")) return;
  if (!report || typeof report !== "object") return;
  console.error("[desktop] captura de tela falhou:", {
    stage: String(report.stage ?? ""),
    error: `${report.name ?? "?"}: ${report.message ?? ""}`,
    sourceId: String(report.sourceId ?? ""),
    sourceKind: String(report.sourceKind ?? ""),
    systemAudio: report.systemAudio === true,
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  });
});

function showError(window, message) {
  void window.loadFile(path.join(__dirname, "status.html"), {
    query: { url: APP_URL, message },
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    // Mesmo cinza do app: evita o clarão branco enquanto a página não chegou.
    backgroundColor: "#313338",
    autoHideMenuBar: true,
    title: "Draco",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // A página é conteúdo remoto: isolar o contexto e manter o Node fora dela
      // não é exagero, é o mínimo. O preload expõe três funções e nada além.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Link de fora abre no navegador do sistema, não dentro do app: uma janela sem
  // barra de endereço é o pior lugar possível pra abrir um site desconhecido.
  window.webContents.on("will-navigate", (event, url) => {
    if (sameOrigin(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // `-3` é navegação abortada pelo próprio Chromium (acontece em redirect), e
    // não é falha. Sub-frame que falha também não vale trocar a janela toda.
    if (!isMainFrame || code === -3) return;
    console.error(`[desktop] falhou ao carregar ${url}: ${description} (${code})`);
    showError(window, description);
  });

  void window.loadURL(APP_URL);
  return window;
}

// Uma janela só. Segunda tentativa de abrir traz a primeira pra frente, em vez
// de subir outra instância que entraria na call como se fosse outra pessoa.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(() => {
    configureSession(session.defaultSession);
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
