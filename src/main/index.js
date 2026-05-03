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
ipcMain.on('start-convert', (event, { inputPath, customFolder, renameByCtime = false }) => {
  const fileNameNoExt = basename(inputPath, extname(inputPath))
  const outputDir = customFolder ? customFolder : dirname(inputPath)

  // 默认输出路径占位，实际名称可能会根据选项调整
  let outputPath = path.join(outputDir, fileNameNoExt + '.mp4')

  // Helper: safe random suffix (alphanumeric) up to length
  function genRandomSuffix(maxLen = 10) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const len = Math.min(maxLen, Math.floor(Math.random() * (maxLen - 2)) + 3) // between 3 and maxLen
    let s = ''
    for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length))
    return s
  }

  // Helper: format birthtime
  function formatBirthtime(date) {
    const y = date.getFullYear().toString()
    const M = (date.getMonth() + 1).toString().padStart(2, '0')
    const d = date.getDate().toString().padStart(2, '0')
    const h = date.getHours().toString().padStart(2, '0')
    const m = date.getMinutes().toString().padStart(2, '0')
    const s = date.getSeconds().toString().padStart(2, '0')
    return `${y}${M}${d}${h}${m}${s}`
  }

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
        event.reply('log-message', `✅ 完成: ${basename(output)}`)
        event.reply('conversion-done', input)
      })
      .run()
  }
  // 如果渲染进程请求按创建日期重命名，则尝试生成一个唯一文件名
  if (renameByCtime) {
    try {
      const stats = fs.statSync(inputPath)
      const birth = stats.birthtime && stats.birthtime.getTime() > 0 ? stats.birthtime : stats.ctime
      const ts = formatBirthtime(new Date(birth))
      const baseName = `${fileNameNoExt}_${ts}`

      // Try several times to generate a random suffix that doesn't collide
      let chosen = null
      const maxRandomAttempts = 20
      for (let attempt = 0; attempt < maxRandomAttempts; attempt++) {
        const suffix = genRandomSuffix(10)
        const candidate = `${baseName}_${suffix}.mp4`
        // check filename length (use 200 as safety for filename length)
        if (candidate.length > 200) continue
        const candidatePath = path.join(outputDir, candidate)
        if (!fs.existsSync(candidatePath)) {
          chosen = candidate
          break
        }
      }

      // If couldn't find a unique random suffix, fallback to sequential numeric suffix 001+
      if (!chosen) {
        let idx = 1
        let seqName = null
        while (idx < 10000) {
          const numeric = String(idx).padStart(3, '0')
          const candidate = `${baseName}_${numeric}.mp4`
          if (candidate.length > 200) {
            idx++
            continue
          }
          const candidatePath = path.join(outputDir, candidate)
          if (!fs.existsSync(candidatePath)) {
            seqName = candidate
            break
          }
          idx++
        }
        if (seqName) {
          chosen = seqName
          event.reply(
            'conversion-warning',
            `文件 ${basename(inputPath)} 的重命名回退到序号后缀（${seqName}），避免随机后缀冲突或名称过长。`
          )
        } else {
          // 最后兜底，使用时间戳 + 原名
          chosen = `${fileNameNoExt}_${ts}.mp4`
          event.reply(
            'conversion-warning',
            `文件 ${basename(inputPath)} 使用时间戳命名（${chosen}），因无法生成唯一后缀）。`
          )
        }
      }

      outputPath = path.join(outputDir, chosen)
    } catch (e) {
      // 若读取文件信息失败，继续使用默认名称并记录日志
      event.reply('log-message', `⚠️ 无法读取创建时间，使用默认文件名: ${e.message}`)
      outputPath = path.join(outputDir, fileNameNoExt + '.mp4')
    }
  } else {
    outputPath = path.join(outputDir, fileNameNoExt + '.mp4')
  }

  // 启动转换，输出至已确定的 outputPath
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
