// CLI side of the daemon: send one command over the socket, starting the daemon if it is not up.
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs'
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

function startDaemon() {
  const self = fileURLToPath(import.meta.url)
  const entry = join(self, '..', `daemon${extname(self)}`)
  const log = openSync(join(home(), 'daemon.log'), 'a')
  // execArgv carries tsx's loader in dev and tests, and is empty for the built CLI.
  // windowsHide: a detached process on Windows would otherwise open a console window of its own.
  spawn(process.execPath, [...process.execArgv, entry], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env }).unref()
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
  if (c.cmd === 'stop' || c.cmd === 'state') return { ok: true, text: c.cmd === 'stop' ? 'daemon was not running' : '[]' }
  // Without a browser the daemon could only exit; say why now instead of waiting for it.
  const browser = await findBrowser()
  if ('error' in browser) return { ok: false, error: browser.error }
  mkdirSync(home(), { recursive: true })
  const mine = takeLock()
  if (mine) startDaemon()
  try {
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 150))
      if (await ping()) return send(c, wait)
    }
  } finally {
    if (mine) rmSync(lockPath(), { force: true })
  }
  throw new Error(`daemon did not start — see ${join(home(), 'daemon.log')}`)
}
