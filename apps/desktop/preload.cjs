"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hubDesktop", {
  getStatus: () => ipcRenderer.invoke("hub:status"),
  openPair: () => ipcRenderer.invoke("hub:open-pair"),
  openHealth: () => ipcRenderer.invoke("hub:open-health"),
  refresh: () => ipcRenderer.invoke("hub:refresh"),
  onStatus: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("hub:status", handler);
    return () => ipcRenderer.removeListener("hub:status", handler);
  },
});
