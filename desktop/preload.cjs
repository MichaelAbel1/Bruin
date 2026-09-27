const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bruin', {
  request: (method, params = {}) => ipcRenderer.invoke('bruin:request', method, params),
  onEvent: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('bruin:event', listener);
    return () => ipcRenderer.removeListener('bruin:event', listener);
  },
});
