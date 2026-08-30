"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * A única ponte entre a página e o sistema.
 *
 * São cinco funções, e de propósito: listar fontes, registrar a escolhida (que já
 * volta dizendo se ela ainda existe), anotar uma falha de captura no console do
 * app, perguntar se há versão nova e pedir a abertura da página de release. A
 * página não recebe `ipcRenderer`, nem `require`, nem nada do Node, e se ela for
 * comprometida um dia, o máximo que consegue é pedir a lista de janelas, marcar
 * uma e abrir a página de releases do projeto no navegador. Conceder a captura em
 * si, e escolher o endereço a abrir, continua sendo decisão do processo principal.
 */
contextBridge.exposeInMainWorld("desktop", {
  version: process.versions.electron ?? "app",
  platform: process.platform,
  listSources: () => ipcRenderer.invoke("desktop:list-sources"),
  selectSource: (request) => ipcRenderer.invoke("desktop:select-source", request),
  logCaptureFailure: (report) => ipcRenderer.invoke("desktop:log-capture-failure", report),
  checkUpdate: () => ipcRenderer.invoke("desktop:check-update"),
  openRelease: () => ipcRenderer.invoke("desktop:open-release"),
  downloadUpdate: () => ipcRenderer.invoke("desktop:download-update"),
  installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
  onUpdateStatus: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("desktop:update-status", handler);
    return () => ipcRenderer.removeListener("desktop:update-status", handler);
  },
  showNotification: (payload) => ipcRenderer.invoke("desktop:notify", payload),
  onNotificationOpen: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, route) => listener(route);
    ipcRenderer.on("desktop:notification-open", handler);
    return () => ipcRenderer.removeListener("desktop:notification-open", handler);
  },
});
