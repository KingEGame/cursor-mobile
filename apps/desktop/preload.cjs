"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hubDesktop", {
  getStatus: () => ipcRenderer.invoke("hub:status"),
  openPair: () => ipcRenderer.invoke("hub:open-pair"),
  openHealth: () => ipcRenderer.invoke("hub:open-health"),
  refresh: () => ipcRenderer.invoke("hub:refresh"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  allowFirewall: () => ipcRenderer.invoke("hub:allow-firewall"),
  diagnostics: () => ipcRenderer.invoke("hub:diagnostics"),
  openLogs: () => ipcRenderer.invoke("hub:open-logs"),
  autostart: (enabled) => ipcRenderer.invoke("hub:autostart", enabled),
  onUpdate: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },
  onStatus: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on("hub:status", handler);
    return () => ipcRenderer.removeListener("hub:status", handler);
  },
});
