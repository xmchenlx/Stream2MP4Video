const { contextBridge, ipcRenderer, webUtils } = require('electron')

try {
  contextBridge.exposeInMainWorld('electron', {
    ipcRenderer: {
      send: (channel, data) => ipcRenderer.send(channel, data),
      invoke: (channel, data) => ipcRenderer.invoke(channel, data),
      on: (channel, func) => {
        const subscription = (event, ...args) => func(event, ...args)
        ipcRenderer.on(channel, subscription)
      }
    },
    // 关键：暴露获取文件真实路径的方法
    getFilePath: (file) => webUtils.getPathForFile(file)
  })
  console.log('✅ Preload 脚本加载成功')
} catch (error) {
  console.error('❌ Preload 暴露失败:', error)
}
