window.onload = () => {
  const dropZone = document.getElementById('drop-zone')
  const btnSelectDir = document.getElementById('btn-select-dir')
  const outputPathInput = document.getElementById('output-path')
  const btnStart = document.getElementById('btn-start')
  const chkRenameByCtime = document.getElementById('chk-rename-by-ctime')
  const btnClear = document.getElementById('btn-clear')
  const queueList = document.getElementById('queue-list')
  const logOutput = document.getElementById('log-output')
  const totalProgress = document.getElementById('total-progress')

  let fileQueue = []
  let isProcessing = false

  // --- 强力拦截窗口默认拖拽 ---
  window.ondragover = window.ondrop = (e) => e.preventDefault()

  // --- 处理文件 ---
  function handleFiles(files) {
    let added = 0
    Array.from(files).forEach((file) => {
      const filePath = window.electron.getFilePath(file)
      if (
        filePath &&
        (filePath.toLowerCase().endsWith('.ts') || filePath.toLowerCase().endsWith('.flv'))
      ) {
        if (!fileQueue.some((f) => f.path === filePath)) {
          fileQueue.push({ path: filePath, name: file.name, status: 'ready' })
          added++
        }
      }
    })
    if (added > 0) {
      addLog(`✅ 已添加 ${added} 个文件`)
      updateQueueUI()
    }
  }

  // --- 拖拽交互事件 ---
  dropZone.addEventListener('dragenter', () => dropZone.classList.add('active'))
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('active'))
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    dropZone.classList.remove('active')
    handleFiles(e.dataTransfer.files)
  })

  dropZone.onclick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.ts,.flv'
    input.onchange = (e) => handleFiles(e.target.files)
    input.click()
  }

  // --- 开始转换前的检测逻辑 ---
  btnStart.onclick = async () => {
    if (isProcessing) return
    const tasks = fileQueue.filter((f) => f.status === 'ready')
    if (tasks.length === 0) return addLog('💡 队列中没有等待转换的文件')

    const customPath = outputPathInput.value.trim()

    // 1. 检测路径是否存在或可创建
    if (customPath) {
      addLog(`[系统] 正在检测路径: ${customPath}`)
      const check = await window.electron.ipcRenderer.invoke('ensure-directory', customPath)
      if (!check.success) {
        addLog(`❌ 路径错误: ${check.msg}`)
        alert(`无法创建或访问该目录，请检查权限或输入。`)
        return // 终止执行，队列不清空
      }
    }

    processNext()
  }

  async function processNext() {
    const nextFile = fileQueue.find((f) => f.status === 'ready')
    if (!nextFile) {
      isProcessing = false
      addLog('[系统] 转换任务全部完成')
      return
    }
    isProcessing = true
    nextFile.status = 'processing'
    updateQueueUI()

    window.electron.ipcRenderer.send('start-convert', {
      inputPath: nextFile.path,
      customFolder: outputPathInput.value.trim() || '',
      renameByCtime: !!chkRenameByCtime.checked
    })
  }

  // --- 基础设施 ---
  btnSelectDir.onclick = async () => {
    const folder = await window.electron.ipcRenderer.invoke('select-directory')
    if (folder) outputPathInput.value = folder
  }

  btnClear.onclick = () => {
    if (isProcessing && !confirm('正在转换，确定清空？')) return
    fileQueue = []
    isProcessing = false
    totalProgress.value = 0
    updateQueueUI()
    addLog('[系统] 队列已清空')
  }

  function updateQueueUI() {
    if (fileQueue.length === 0) {
      queueList.innerHTML =
        '<div style="color:#555; text-align:center; padding-top:20px;">等待添加任务...</div>'
      return
    }
    queueList.innerHTML = fileQueue
      .map(
        (file) => `
      <div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid #333; font-size:12px;">
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%;">${file.name}</span>
        <span style="color:${file.status === 'done' ? '#4ec9b0' : file.status === 'processing' ? '#ffaa00' : '#888'}">
          ${file.status === 'ready' ? '等待' : file.status === 'processing' ? '转换中...' : '完成'}
        </span>
      </div>
    `
      )
      .join('')
  }

  window.electron.ipcRenderer.on('log-message', (_, msg) => addLog(msg))
  window.electron.ipcRenderer.on('conversion-progress', (_, data) => {
    totalProgress.value = data.percent || 0
  })
  window.electron.ipcRenderer.on('conversion-done', (_, filePath) => {
    const file = fileQueue.find((f) => f.path === filePath)
    if (file) file.status = 'done'
    updateQueueUI()
    processNext()
  })

  // 接收主进程发来的显著提醒（例如回退到序号后缀）
  window.electron.ipcRenderer.on('conversion-warning', (_, msg) => {
    // 显示在页面顶部并突出
    const warn = document.createElement('div')
    warn.textContent = `⚠️ ${msg}`
    warn.style.background = '#ffe8a6'
    warn.style.color = '#663c00'
    warn.style.padding = '8px'
    warn.style.border = '1px solid #cc9a00'
    warn.style.borderRadius = '4px'
    warn.style.marginTop = '8px'
    document.body.insertBefore(warn, document.body.firstChild)
    setTimeout(() => warn.remove(), 15000)
  })

  function addLog(msg) {
    const div = document.createElement('div')
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
    logOutput.appendChild(div)
    logOutput.scrollTop = logOutput.scrollHeight
  }
}
