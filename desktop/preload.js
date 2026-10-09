const { contextBridge, ipcRenderer } = require('electron');

// The only thing the page gets from the desktop shell: the server it should talk to.
contextBridge.exposeInMainWorld('BILETAI', { defaultServer: ipcRenderer.sendSync('biletai:config').serverUrl });
