const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mioPetChat', {
  isElectron: true,
  hide: () => ipcRenderer.send('mio-pet-chat:hide'),
  openAdmin: () => ipcRenderer.send('mio-pet-chat:open-admin'),
  sendPetEvent: (ev) => ipcRenderer.send('mio-desktop:pet-event', ev),
})
