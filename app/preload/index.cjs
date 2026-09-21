const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('事件监听器必须是函数');
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('workbench', Object.freeze({
  invoke: (id, name, args) => ipcRenderer.invoke('workbench:invoke', { id, name, args }),
  cancel: id => ipcRenderer.send('workbench:cancel', id),
  requestExit: () => ipcRenderer.invoke('workbench:exit'),
  retryStartup: () => ipcRenderer.invoke('workbench:retry'),
  openLogs: () => ipcRenderer.invoke('workbench:logs'),
  openExternal: url => ipcRenderer.invoke('workbench:external', String(url || '')),
  onEvent: listener => subscribe('workbench:event', listener),
  onStartupStatus: listener => subscribe('desktop:startup-status', listener),
  onBackendStatus: listener => subscribe('desktop:backend-status', listener),
}));
