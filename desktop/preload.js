"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * A única ponte entre a página e o sistema.
 *
 * São duas funções, e de propósito: listar fontes e registrar a escolhida. A
 * página não recebe `ipcRenderer`, nem `require`, nem nada do Node — se ela for
 * comprometida um dia, o máximo que consegue é pedir a lista de janelas e marcar
 * uma. Conceder a captura em si continua sendo decisão do processo principal.
 */
contextBridge.exposeInMainWorld("desktop", {
  version: process.versions.electron ?? "app",
  listSources: () => ipcRenderer.invoke("desktop:list-sources"),
  selectSource: (source) => ipcRenderer.invoke("desktop:select-source", source),
});
