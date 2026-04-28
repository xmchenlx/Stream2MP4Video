import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename, extname, dirname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import ffmpeg from 'fluent-ffmpeg'
import path from 'path'
import fs from 'fs'

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发环境加载逻辑
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- 辅助函数：格式化时间戳 ---
function getTimeStamp() {
  const now = new Date()
  return (
    now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0') +
    '_' +
    now.getHours().toString().padStart(2, '0') +
    now.getMinutes().toString().padStart(2, '0') +
    now.getSeconds().toString().padStart(2, '0')
  )
}

// --- IPC 监听：检查并创建路径 ---
ipcMain.handle('ensure-directory', async (event, dirPath) => {
  if (!dirPath) return { success: true }
  try {
    const absolutePath = path.resolve(dirPath)
    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true })
    }
    return { success: true }
  } catch (err) {
    return { success: false, msg: err.message }
  }
})

// --- IPC 监听：文件夹选择 ---
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: '选择输出保存目录'
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

// --- IPC 监听：转换逻辑 ---
ipcMain.on('start-convert', (event, { inputPath, customFolder }) => {
  const fileNameNoExt = basename(inputPath, extname(inputPath))
  const outputDir = customFolder ? customFolder : dirname(inputPath)
  const outputPath = path.join(outputDir, fileNameNoExt + '.mp4')

  function performConversion({ input, output, useReencode = false }) {
    const command = ffmpeg(input).output(output)

    if (useReencode) {
      command
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions(['-preset veryfast', '-movflags +faststart'])
    } else {
      command.videoCodec('copy').audioCodec('copy')
    }

    command
      .on('start', () => {
        event.reply(
          'log-message',
          `🚀 处理中: ${basename(inputPath)} ${useReencode ? '(重编码)' : ''}`
        )
      })
      .on('progress', (progress) => {
        event.reply('conversion-progress', { percent: progress.percent, filePath: inputPath })
      })
      .on('error', (err) => {
        const ext = extname(input).toLowerCase()
        if (!useReencode && ext === '.flv') {
          event.reply('log-message', `⚠️ 直接拷贝失败，尝试对 .flv 进行重编码：${err.message}`)
          performConversion({ input, output, useReencode: true })
          return
        }

        const errorDir = path.join(outputDir, 'errorvideo')
        try {
          if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true })

          let targetName = basename(input)
          const errorPath = path.join(errorDir, targetName)
          if (fs.existsSync(errorPath)) {
            const extn = extname(input)
            const nameOnly = basename(input, extn)
            targetName = `${nameOnly}_${getTimeStamp()}${extn}`
          }

          fs.copyFileSync(input, path.join(errorDir, targetName))
          event.reply('log-message', `❌ 失败已备份: ${targetName}`)
        } catch (e) {
          event.reply('log-message', `❌ 备份失败: ${e.message}`)
        }
        event.reply('conversion-done', input)
      })
      .on('end', () => {
        event.reply('log-message', `✅ 完成: ${fileNameNoExt}.mp4`)
        event.reply('conversion-done', input)
      })
      .run()
  }

  performConversion({ input: inputPath, output: outputPath, useReencode: false })
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
