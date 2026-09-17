const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  if (typeof listener !== "function") return () => {};
  const handler = (_event, value) => listener(value && typeof value === "object" ? value : {});
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("superBaodanDesktop", Object.freeze({
  isDesktop: true,
  requestExit: () => ipcRenderer.invoke("desktop:request-exit"),
  retryStartup: () => ipcRenderer.invoke("desktop:retry-startup"),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", String(url || "")),
  onStartupStatus: (listener) => subscribe("desktop:startup-status", listener),
  onBackendStatus: (listener) => subscribe("desktop:backend-status", listener),
}));
