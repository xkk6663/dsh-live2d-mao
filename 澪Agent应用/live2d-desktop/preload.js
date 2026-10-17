const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mioDesktop', {
  getState: () => ipcRenderer.invoke('mio-desktop:get-state'),
  setInteractive: (interactive) => ipcRenderer.send('mio-desktop:set-interactive', Boolean(interactive)),
  setModelBounds: (bounds) => ipcRenderer.send('mio-desktop:model-bounds', bounds || null),
  setStripBounds: (bounds) => ipcRenderer.send('mio-desktop:strip-bounds', bounds || null),
  setUiOpen: (open) => ipcRenderer.send('mio-desktop:ui-open', Boolean(open)),
  setClickThroughLocked: (enabled) => ipcRenderer.send('mio-desktop:set-click-through-locked', Boolean(enabled)),
  setLockControlAnchor: (bounds) => ipcRenderer.send('mio-desktop:set-lock-control-anchor', bounds),
  setAlwaysOnTop: (enabled) => ipcRenderer.send('mio-desktop:set-always-on-top', Boolean(enabled)),
  setAgentPlugin: (payload) => ipcRenderer.send('mio-desktop:set-agent-plugin', payload || {}),
  setChatWindowOpen: (open) => ipcRenderer.send('mio-desktop:set-chat-window-open', Boolean(open)),
  toggleChatWindow: (anchor) => ipcRenderer.invoke('mio-desktop:toggle-chat-window', anchor || {}),
  showChatWindow: (anchor) => ipcRenderer.invoke('mio-desktop:show-chat-window', anchor || {}),
  restoreVisibility: () => ipcRenderer.send('mio-desktop:restore-visibility'),
  importModel: () => ipcRenderer.invoke('mio-desktop:import-model'),
  selectModel: (modelId) => ipcRenderer.invoke('mio-desktop:select-model', String(modelId || '')),
  openAgent: () => ipcRenderer.invoke('mio-desktop:open-agent'),
  // 双击桌宠直达 DSH 面板（主进程打开管理窗并触发 dsh-panel.show()）
  openDshPanel: () => ipcRenderer.invoke('mio-desktop:open-dsh-panel'),
  getVersion: () => ipcRenderer.invoke('mio-desktop:get-version'),
  close: () => ipcRenderer.send('mio-desktop:close'),
  sendPetEvent: (event) => ipcRenderer.send('mio-desktop:pet-event', event),
  onModelsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('mio-desktop:models-changed', listener)
    return () => ipcRenderer.removeListener('mio-desktop:models-changed', listener)
  },
  onClickThroughChanged: (callback) => {
    const listener = (_event, enabled) => callback(Boolean(enabled))
    ipcRenderer.on('mio-desktop:click-through-changed', listener)
    return () => ipcRenderer.removeListener('mio-desktop:click-through-changed', listener)
  },
  onPetEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('mio-pet-event', listener)
    return () => ipcRenderer.removeListener('mio-pet-event', listener)
  },
  onMouseMove: (callback) => {
    const listener = (_event, payload) => callback(payload || {})
    ipcRenderer.on('mio-desktop:mouse-move', listener)
    return () => ipcRenderer.removeListener('mio-desktop:mouse-move', listener)
  },
  onWindowStable: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('mio-desktop:window-stable', listener)
    return () => ipcRenderer.removeListener('mio-desktop:window-stable', listener)
  },
})
