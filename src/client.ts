// CLI side of the daemon: send one command over the socket, starting the daemon if it is not up.
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { home } from './session.js'
import { findBrowser } from './browser.js'
import type { Command } from './daemon.js'

// Windows has no Unix sockets; a named pipe, named after the home dir, plays the same part.
// Unix socket paths are capped near 104 bytes on macOS and silently truncated past that,
// so a deep home dir gets a short, stable path in the temp dir instead.
const homeId = () => createHash('sha256').update(home()).digest('hex').slice(0, 12)
export const socketPath = () => {
  if (process.platform === 'win32') return `\\\\.\\pipe\\browser-layer-${homeId()}`
  const p = join(home(), 'daemon.sock')
  if (Buffer.byteLength(p) < 100) return p
  return join(tmpdir(), `browser-layer-${homeId()}.sock`)
}
const lockPath = () => join(home(), 'daemon.lock')
const LOCK_STALE_MS = 30000
// Attached, a daemon may sit for a long time on Chrome's "Allow remote debugging?" popup, before it has a socket.
// Its pid file tells the next command to wait for it, not to start a second daemon and raise a second popup.
export const pidPath = () => join(home(), 'daemon.pid')
const ALLOW_WAIT_MS = 60000
const pending = (): number | undefined => {
  try {
    const pid = Number(readFileSync(pidPath(), 'utf8'))
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}

// The installed version: the CLI prints it, and a daemon started by another version (before an update)
// will not run this one's commands.
export const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version

type Reply = { ok: boolean; text?: string; error?: string; stale?: boolean }

function send(c: Partial<Command>, timeout = 90000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socketPath(), method: 'POST', path: '/', timeout }, res => {
      let body = ''
      res.on('data', d => (body += d))
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { reject(new Error(`bad reply from daemon: ${body.slice(0, 200)}`)) } })
    })
    req.on('timeout', () => req.destroy(new Error('daemon did not answer in time')))
    req.on('error', reject)
    req.end(JSON.stringify(c))
  })
}

export const ping = () => send({ cmd: 'ping' }, 2000).then(() => true, () => false)

// Only one CLI call gets to spawn; concurrent calls just wait for that daemon to answer.
function takeLock(): boolean {
  try {
    closeSync(openSync(lockPath(), 'wx'))
    return true
  } catch {
    try {
      if (Date.now() - statSync(lockPath()).mtimeMs < LOCK_STALE_MS) return false
      rmSync(lockPath(), { force: true })
      closeSync(openSync(lockPath(), 'wx'))
      return true
    } catch {
      return false
    }
  }
}

function startDaemon(): number | undefined {
  const self = fileURLToPath(import.meta.url)
  const entry = join(self, '..', `daemon${extname(self)}`)
  const log = openSync(join(home(), 'daemon.log'), 'a')
  // execArgv carries tsx's loader in dev and tests, and is empty for the built CLI.
  // windowsHide: a detached process on Windows would otherwise open a console window of its own.
  const child = spawn(process.execPath, [...process.execArgv, entry], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env })
  child.unref()
  return child.pid
}

export async function live(c: Command): Promise<Reply> {
  // Each of a call's steps has the daemon's own time limit, so the call waits for all of them.
  const wait = 90000 * Math.max(1, c.steps?.length ?? 1)
  try {
    const reply = await send({ ...c, version: VERSION }, wait)
    // A daemon from another version stopped instead of answering; this version's starts below.
    if (!reply.stale) return reply
    if (c.cmd === 'stop') return { ok: true, text: 'stopped' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ECONNRESET: the daemon was exiting (just after `stop`); like a missing one, start a fresh one.
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ECONNRESET') throw err
  }
  // Asking about or stopping a browser that is not running must not start one.
  if (c.cmd === 'stop' && process.env.BROWSER_LAYER_ATTACH && pending()) {
    process.kill(pending()!)
    rmSync(pidPath(), { force: true })
    return { ok: true, text: 'stopped' }
  }
  if (c.cmd === 'stop' || c.cmd === 'state') return { ok: true, text: c.cmd === 'stop' ? 'daemon was not running' : '[]' }
  // Without a browser the daemon could only exit; say why now instead of waiting for it.
  if (!process.env.BROWSER_LAYER_ATTACH) {
    const browser = await findBrowser()
    if ('error' in browser) return { ok: false, error: browser.error }
  }
  mkdirSync(home(), { recursive: true })
  const attached = !!process.env.BROWSER_LAYER_ATTACH
  const waiting = attached && pending() !== undefined
  const mine = !waiting && takeLock()
  if (mine) {
    const pid = startDaemon()
    if (attached && pid) writeFileSync(pidPath(), String(pid))
  }
  const started = Date.now()
  try {
    for (let i = 0; ; i++) {
      await new Promise(r => setTimeout(r, 150))
      if (await ping()) return send(c, wait)
      if (!attached) {
        if (i >= 149) break
        continue
      }
      // The person has to click Allow in Chrome: say so once, give up waiting after a minute, and keep the daemon
      // for the next command. A daemon that exited (Don't allow, Chrome closed) is no longer worth waiting for.
      if (!pending()) break
      if (i === 13) console.error('Chrome is asking "Allow remote debugging?": click Allow in Chrome.')
      if (Date.now() - started > ALLOW_WAIT_MS) throw new Error('Chrome is still waiting for you to click Allow on "Allow remote debugging?"; click it, then run the command again')
    }
  } finally {
    if (mine) rmSync(lockPath(), { force: true })
  }
  throw new Error(`daemon did not start — see ${join(home(), 'daemon.log')}`)
}
