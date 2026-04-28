const fs = require('fs')
const { execSync } = require('child_process')
const path = require('path')

const distPath = path.resolve(__dirname, '../dist')

function listLockingProcesses() {
  try {
    // Windows: use tasklist to find likely culprits
    const out = execSync('tasklist /FO LIST', { encoding: 'utf8' })
    const lines = out.split(/\r?\n/)
    const procs = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('Image Name:')) {
        const name = line.split(':')[1].trim()
        const pidLine = lines[i + 1] || ''
        const pidMatch = pidLine.match(/PID:\s*(\d+)/)
        const pid = pidMatch ? pidMatch[1] : ''
        if (/app-builder.exe|app-builder-bin|app-builder|electron.exe|node.exe/i.test(name)) {
          procs.push({ name, pid })
        }
      }
    }
    return procs
  } catch (e) {
    return []
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms))
}

async function tryRemove() {
  if (!fs.existsSync(distPath)) {
    console.log('clean: dist directory does not exist — nothing to do.')
    return 0
  }

  const maxAttempts = 6
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Node 14+ supports rmSync with recursive
      fs.rmSync(distPath, { recursive: true, force: true })
      console.log('clean: removed dist directory')
      return 0
    } catch (err) {
      const code = err && err.code ? err.code : ''
      console.warn(`clean: attempt ${attempt} failed: ${err.message}`)
      if (attempt < maxAttempts) {
        await sleep(300 * attempt)
        continue
      }

      // final failure — provide helpful diagnostics
      console.error('\nclean: failed to remove dist after several attempts.')
      if (code === 'EBUSY' || code === 'EPERM') {
        console.error('It looks like a process is holding files under the dist directory.')
        const procs = listLockingProcesses()
        if (procs.length) {
          console.error('Possible processes to check (name / PID):')
          procs.forEach((p) => console.error(`  ${p.name} / ${p.pid}`))
        } else {
          console.error('No obvious app-builder/electron/node processes found via tasklist.')
        }
        console.error(
          'Please close the application, any running Electron or builder processes, and try again.'
        )
      } else {
        console.error('Error code:', code)
      }
      return 2
    }
  }
}

tryRemove()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('Unexpected error during clean:', e)
    process.exit(3)
  })
