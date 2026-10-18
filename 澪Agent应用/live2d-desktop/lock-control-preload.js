const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mioLockControl', {
  // 左键：切换「固定并穿透」
  toggle: () => ipcRenderer.send('mio-lock-control:toggle'),
  // 右键：把桌宠叫回右下角（不改变锁定状态）
  reset: () => ipcRenderer.send('mio-lock-control:reset'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state || {})
    ipcRenderer.on('mio-lock-control:state', listener)
    return () => ipcRenderer.removeListener('mio-lock-control:state', listener)
  },
})
