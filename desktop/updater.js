"use strict";

const { app, net } = require("electron");
const { autoUpdater } = require("electron-updater");

/**
 * Verificação de atualização do app de desktop.
 *
 * Só verifica e avisa: o download e a instalação continuam sendo um clique da
 * pessoa, no navegador. É deliberado — baixar e executar um instalador de forma
 * automática exige assinatura de código e um canal de release confiável, e sem
 * essas duas coisas o "auto-update" seria um caminho pronto pra instalar
 * qualquer coisa na máquina de quem usa o Draco.
 *
 * Quando houver assinatura, o passo seguinte é o `electron-updater` apontado pro
 * mesmo repositório: este módulo já responde no formato que ele usa (versão
 * disponível, notas, endereço), então trocar o meio não mexe no resto do app.
 */

/** Onde as releases são publicadas. `DRACO_UPDATE_FEED` troca o canal em teste. */
const DEFAULT_FEED = "https://api.github.com/repos/cesar1014/draco/releases/latest";
const TIMEOUT_MS = 8000;

/** Uma verificação por sessão a cada seis horas: release não sai de hora em hora. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let lastCheck = 0;
let lastResult = null;
let updateWindow = null;
let updateLog = null;
let secureUpdaterReady = false;
let downloaded = false;

const secureUpdatesEnabled = () => app.isPackaged && process.env.DRACO_SIGNED_UPDATES === "1";

function publishStatus(status) {
  if (!updateWindow || updateWindow.isDestroyed()) return;
  updateWindow.webContents.send("desktop:update-status", status);
}

function configureAutoUpdater(window, log) {
  updateWindow = window;
  updateLog = log;
  if (!secureUpdatesEnabled() || secureUpdaterReady) return secureUpdatesEnabled();
  secureUpdaterReady = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => publishStatus({ phase: "checking" }));
  autoUpdater.on("update-available", (info) => publishStatus({ phase: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => publishStatus({ phase: "idle" }));
  autoUpdater.on("download-progress", (progress) => publishStatus({ phase: "downloading", percent: Math.round(progress.percent), bytesPerSecond: progress.bytesPerSecond }));
  autoUpdater.on("update-downloaded", (info) => {
    downloaded = true;
    publishStatus({ phase: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (error) => {
    updateLog?.error("atualização do desktop falhou", { motivo: String(error?.message ?? error).slice(0, 200) });
    publishStatus({ phase: "error", message: "Não foi possível concluir a atualização." });
  });
  return true;
}

const currentVersion = () => app.getVersion();

/** `1.2.10` > `1.2.9`: comparação numérica por parte, não alfabética. */
function isNewer(candidate, current) {
  const parse = (value) =>
    value
      .replace(/^v/i, "")
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));

  const left = parse(candidate);
  const right = parse(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/**
 * `net.request` em vez de `fetch`: ele usa a pilha de rede do Chromium, e com ela
 * o proxy e os certificados do sistema já valem, que é o que faz a verificação
 * funcionar em rede corporativa.
 */
function fetchFeed(url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: "GET", url });
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error("tempo esgotado"));
    }, TIMEOUT_MS);

    request.setHeader("Accept", "application/vnd.github+json");
    request.setHeader("User-Agent", `Draco/${currentVersion()}`);

    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timer);
        request.abort();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        // Teto de leitura: a resposta esperada tem alguns kilobytes, e um corpo
        // sem fim ocuparia memória do processo principal até a máquina reclamar.
        if (size > 512 * 1024) {
          request.abort();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("resposta ilegível"));
        }
      });
      response.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

/**
 * Última versão publicada, comparada com a instalada.
 *
 * O endereço devolvido é sempre a página da release, nunca o binário: quem abre é
 * o navegador do sistema, e a instalação continua passando pelo aviso do Windows.
 *
 * @returns {Promise<{current: string, latest: string|null, available: boolean, url: string|null, notes: string|null}>}
 */
async function checkForUpdates({ feed = (!app.isPackaged && process.env.DRACO_UPDATE_FEED) || DEFAULT_FEED } = {}) {
  if (secureUpdatesEnabled() && secureUpdaterReady) {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version ?? null;
    return { current: currentVersion(), latest, available: Boolean(latest && isNewer(latest, currentVersion())), url: null, notes: result?.updateInfo?.releaseNotes ?? null, automatic: true };
  }
  const current = currentVersion();
  if (lastResult && Date.now() - lastCheck < CHECK_INTERVAL_MS) return lastResult;

  const empty = { current, latest: null, available: false, url: null, notes: null };
  // Só HTTPS: um feed em texto claro poderia ser trocado no caminho, e o app
  // anunciaria uma "atualização" apontando pra onde o atacante quisesse.
  if (!/^https:\/\//i.test(feed)) return empty;

  try {
    const release = await fetchFeed(feed);
    const tag = typeof release?.tag_name === "string" ? release.tag_name : null;
    if (!tag) return empty;

    const pageUrl = typeof release.html_url === "string" ? release.html_url : null;
    lastCheck = Date.now();
    lastResult = {
      current,
      latest: tag.replace(/^v/i, ""),
      available: isNewer(tag, current),
      // Confere a origem do link: um feed comprometido não deve conseguir mandar
      // o app abrir um endereço qualquer no navegador de quem usa.
      url:
        pageUrl && /^https:\/\/github\.com\/cesar1014\/draco\/releases\//i.test(pageUrl)
          ? pageUrl
          : null,
      notes: typeof release.body === "string" ? release.body.slice(0, 2000) : null,
    };
    return lastResult;
  } catch {
    // Sem internet, sem release publicada ou API fora do ar: o app não avisa nada
    // e tenta na próxima vez. Falha de verificação não é problema de quem usa.
    return empty;
  }
}

async function downloadUpdate() {
  if (!secureUpdatesEnabled() || !secureUpdaterReady) return { ok: false, error: "signed-updates-unavailable" };
  await autoUpdater.downloadUpdate();
  return { ok: true };
}

function installUpdate() {
  if (!secureUpdatesEnabled() || !secureUpdaterReady || !downloaded) return false;
  autoUpdater.quitAndInstall(false, true);
  return true;
}

module.exports = { checkForUpdates, configureAutoUpdater, currentVersion, downloadUpdate, installUpdate, secureUpdatesEnabled };
