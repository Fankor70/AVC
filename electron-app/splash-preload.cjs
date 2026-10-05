/**
 * AVC-Anime — preload для splash/окна ошибки запуска.
 * Открывает рендереру ТОЛЬКО три действия без секретов: логи / перезапуск / выход.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('avcSplash', {
  openLogs: () => ipcRenderer.send('avc:splash:open-logs'),
  relaunch: () => ipcRenderer.send('avc:splash:relaunch'),
  quit: () => ipcRenderer.send('avc:splash:quit'),
})
