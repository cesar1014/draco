"use strict";

const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, webContents } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { checkForUpdates, currentVersion } = require("./updater.js");

/**
 * Processo principal do app de desktop.
 *
 * O app é uma janela dedicada em volta do **mesmo site** que está no ar, não uma
 * segunda versão do projeto. Isso importa por dois motivos: você continua tendo
 * um link pra mandar pros amigos (eles não instalam nada), e não existe risco de
 * o app e o navegador falarem protocolos diferentes, porque é o mesmo código.
 *
 * O que só o app tem é privilégio de sistema. `getDisplayMedia`, num navegador,
 * obriga o diálogo do próprio navegador, que está ali por segurança.
 * Aqui o Electron deixa a gente responder àquele pedido no lugar dele
 * (`setDisplayMediaRequestHandler`), e é exatamente por isso que o app de
 * verdade consegue ter o seletor de miniaturas: ele também é Electron.
 */

/** Log com categoria, no mesmo formato do servidor. */
const log = {
  info: (message, detail) => console.log("[ELECTRON]", message, detail ?? ""),
  warn: (message, detail) => console.warn("[ELECTRON]", message, detail ?? ""),
  error: (message, detail) => console.error("[ELECTRON]", message, detail ?? ""),
  debug: (message, detail) => {
    if (process.env.LOG_LEVEL === "debug") console.log("[ELECTRON]", message, detail ?? "");
  },
};

const describe = (error) => (error instanceof Error ? error.message : String(error));

/** Endereço publicado. Override existe só no Electron não empacotado, para desenvolvimento. */
const DEFAULT_URL = "https://dracocall.duckdns.org";

const urlFromArgv = process.argv.find((arg) => arg.startsWith("--url="))?.slice(6);
const developmentUrl = app.isPackaged ? null : urlFromArgv || process.env.DESKTOP_URL;
const APP_URL = (developmentUrl || DEFAULT_URL).trim().replace(/\/+$/, "");
const APP_ORIGIN = new URL(APP_URL).origin;
const STATUS_URL = pathToFileURL(path.join(__dirname, "status.html")).href;

/** Comparação por origem, não por texto: barra no fim e caminho não podem enganar. */
function sameOrigin(value) {
  try {
    return new URL(value).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function localStatusPage(value) {
  try {
    const candidate = new URL(value);
    const status = new URL(STATUS_URL);
    return candidate.protocol === "file:" && candidate.pathname === status.pathname;
  } catch {
    return false;
  }
}

/** Nunca entrega protocolos do sistema nem URL sem HTTPS ao `openExternal`. */
function openSafeExternal(value) {
  try {
    const url = new URL(value);
    const officialRelease =
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith("/cesar1014/draco/releases/");
    if (!officialRelease) return false;
    void shell.openExternal(url.href);
    return true;
  } catch {
    return false;
  }
}

/**
 * Captura escolhida no seletor de miniaturas, esperando o `getDisplayMedia` que
 * vem logo atrás. É um passo em dois tempos porque `getDisplayMedia` não aceita
 * "quero esta janela" como argumento: quem decide é sempre o lado privilegiado.
 *
 * Uma reserva por `webContents`, não uma global: com duas janelas abertas (ou uma
 * janela e um popup), a reserva de uma atenderia o pedido da outra, e a pessoa
 * transmitiria a tela que o vizinho escolheu.
 *
 * Guarda o id, não o objeto que o `desktopCapturer` devolveu. Entre escolher e
 * capturar a janela pode ter sido fechada ou reaberta, e conceder um handle velho
 * resulta em captura de nada, sem erro que ajude a entender o porquê.
 */
const pendingCaptures = new Map();

/** Reserva vencida é reserva que não existe: uma escolha esquecida não vale a próxima captura. */
const CAPTURE_CLAIM_TTL_MS = 60_000;

/**
 * A reserva de quem está pedindo a captura. `webContents.fromFrame` é o caminho
 * normal; quando ele não resolve o frame, uma reserva única serve, porque com uma
 * janela só não há ambiguidade nenhuma. Com duas ou mais pendentes, não há como
 * saber de quem é, e conceder a errada mostraria a tela que o vizinho escolheu.
 */
function takeClaim(frame) {
  const requester = frame ? webContents.fromFrame(frame) : null;
  const key =
    requester?.id ?? (pendingCaptures.size === 1 ? [...pendingCaptures.keys()][0] : null);
  if (key === null) return null;

  const claim = pendingCaptures.get(key);
  pendingCaptures.delete(key);
  if (!claim) return null;
  return Date.now() - claim.at > CAPTURE_CLAIM_TTL_MS ? null : claim;
}

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
      const capture = takeClaim(request.frame);

      if (!capture) {
        // Ninguém escolheu nada: não há o que conceder. Acontece só se a página
        // pedir captura sem passar pelo painel, e aí conceder qualquer coisa
        // mostraria uma tela que ninguém pediu.
        callback({});
        return;
      }

      let source = null;
      try {
        source = await findSource(capture.sourceId);
      } catch (error) {
        log.error("falha ao reler as fontes de captura", { motivo: describe(error) });
      }

      if (!source) {
        log.warn("fonte reservada não existe mais", { etapa: "getDisplayMedia" });
        callback({});
        return;
      }

      // `loopback` é o som do sistema, e só existe no Windows. Em outro sistema,
      // pedir isso não daria erro visível, viria uma trilha muda: a pessoa acha
      // que mandou o áudio do jogo e ninguém ouviu nada.
      const loopback =
        request.audioRequested && capture.systemAudio && process.platform === "win32";

      const kind = capture.sourceId.startsWith("screen:") ? "tela" : "janela";
      log.info("captura concedida", {
        tipo: kind,
        audioSistema: loopback,
        // Registrado à parte porque é a assimetria que a gente persegue: com
        // fonte `screen:` o WASAPI recusa o loopback em algumas configurações, e
        // com `window:` passa. Sem isto, o log não diz se a concessão que a
        // página recebeu era a que pedia som ou a que já vinha muda.
        audioPedido: request.audioRequested === true,
        audioEscolhido: capture.systemAudio === true,
      });
      if (request.audioRequested && capture.systemAudio && !loopback) {
        log.warn("som do sistema não concedido", { tipo: kind, plataforma: process.platform });
      }
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

  log.debug("fontes listadas", { telas: sources.filter((s) => s.id.startsWith("screen:")).length });
  return sources.map((source) => {
    const isScreen = source.id.startsWith("screen:");
    return {
      id: source.id,
      // `name` é o que o Electron precisa de volta na hora de conceder, então vai
      // cru. `label` é o que a pessoa lê, então a tradução fica só nele.
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
 * existe. Validar aqui, e não só na hora de conceder, permite à página
 * dizer "essa janela foi fechada" em vez de mostrar uma falha de permissão que
 * não tem nada a ver com permissão.
 */
ipcMain.handle("desktop:select-source", async (event, request) => {
  if (!sameOrigin(event.senderFrame?.url ?? "")) return { ok: false, reason: "denied" };
  // Só o que precisamos, e só do tipo certo: o que chega aqui vem do renderer, e
  // repassar objeto inteiro de outro processo pra dentro do Electron é risco.
  if (!request || typeof request.sourceId !== "string" || request.sourceId.length > 128) {
    return { ok: false, reason: "invalid" };
  }
  if (!/^(screen|window):/.test(request.sourceId)) return { ok: false, reason: "invalid" };

  const contentsId = event.sender.id;
  try {
    if (!(await findSource(request.sourceId))) {
      pendingCaptures.delete(contentsId);
      return { ok: false, reason: "gone" };
    }
  } catch (error) {
    log.error("falha ao validar a fonte escolhida", { motivo: describe(error) });
    return { ok: false, reason: "failed" };
  }

  pendingCaptures.set(contentsId, {
    sourceId: request.sourceId,
    systemAudio: request.systemAudio === true,
    at: Date.now(),
  });
  log.debug("fonte reservada", {
    tipo: request.sourceId.startsWith("screen:") ? "tela" : "janela",
    audioSistema: request.systemAudio === true,
  });
  return { ok: true };
});

/**
 * Diagnóstico de captura no console do app. Fica aqui, e não na interface: quem
 * está na call quer uma frase útil, não `name`, `sourceId` e etapa da falha.
 *
 * O id da fonte não é registrado: ele carrega o identificador da janela do
 * sistema, e o que ajuda a diagnosticar é o tipo e a etapa, não qual janela era.
 */
ipcMain.handle("desktop:log-capture-failure", (event, report) => {
  if (!sameOrigin(event.senderFrame?.url ?? "")) return;
  if (!report || typeof report !== "object") return;
  log.error("captura de tela falhou", {
    etapa: String(report.stage ?? ""),
    erro: `${report.name ?? "?"}: ${String(report.message ?? "").slice(0, 200)}`,
    tipoFonte: String(report.sourceKind ?? ""),
    audioSistema: report.systemAudio === true,
    plataforma: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  });
});

/**
 * Versão instalada e, quando houver, a publicada. Verificar aqui e não na página
 * é o ponto: só o processo principal sabe a versão do executável, e a página só
 * recebe o resultado — nunca a capacidade de baixar ou executar nada.
 */
ipcMain.handle("desktop:check-update", async (event) => {
  if (!sameOrigin(event.senderFrame?.url ?? "")) return null;
  const result = await checkForUpdates();
  if (result.available) log.info("atualização disponível", { versao: result.latest });
  return result;
});

/**
 * Abre a página da release no navegador do sistema. O endereço não vem da página:
 * ela pede a abertura, e quem escolhe o link é o resultado da verificação, que já
 * foi conferido como um endereço do repositório de releases. Aceitar uma URL do
 * renderer aqui transformaria isto num "abra qualquer coisa".
 */
ipcMain.handle("desktop:open-release", async (event) => {
  if (!sameOrigin(event.senderFrame?.url ?? "")) return false;
  const result = await checkForUpdates();
  if (!result.url) return false;
  return openSafeExternal(result.url);
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
      // é obrigatório. O preload expõe um punhado de funções e nada além.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A página nunca precisa abrir um `file://`, e negar isso fecha o caminho
      // clássico de ler o disco a partir de conteúdo remoto.
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Uma janela nova (popup autorizado) herda estas preferências mas não os
  // handlers; instalá-los pra qualquer `webContents` que apareça é o que impede
  // uma segunda janela de navegar pra onde a principal não pode.
  window.webContents.on("did-create-window", (child) => guardNavigation(child.webContents));
  guardNavigation(window.webContents);

  window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    // `-3` é navegação abortada pelo próprio Chromium (acontece em redirect), e
    // não é falha. Sub-frame que falha também não vale trocar a janela toda.
    if (!isMainFrame || code === -3) return;
    log.error("falha ao carregar a página", { codigo: code, motivo: description });
    showError(window, description);
  });

  void window.loadURL(APP_URL);
  return window;
}

/**
 * Navegação fechada na origem do app. Link de fora abre no navegador do sistema,
 * não dentro do app: numa janela sem barra de endereço ninguém vê pra onde o link
 * levou, e uma página qualquer carregada aqui herdaria as permissões de captura.
 *
 * A página local de erro é a exceção: ela é o `status.html` que este processo
 * carrega, e não uma navegação vinda de conteúdo remoto.
 */
function guardNavigation(contents) {
  contents.on("will-navigate", (event, url) => {
    if (sameOrigin(url) || localStatusPage(url)) return;
    event.preventDefault();
    openSafeExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: "allow" };
    openSafeExternal(url);
    return { action: "deny" };
  });
  // Anexar um devtools ou um webview seria outra porta pra carregar conteúdo com
  // as permissões desta janela.
  contents.on("will-attach-webview", (event) => event.preventDefault());
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
    log.info("app iniciado", { versao: currentVersion(), origem: APP_ORIGIN });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
