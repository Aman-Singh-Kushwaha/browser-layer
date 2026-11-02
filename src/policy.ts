import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './session.js'

// Every behavior tunable lives here; DESIGN.md §9 says what each one means.
export const DEFAULTS = {
  'load.timeoutMs': 30000,
  'load.domMs': 10000,
  'load.retryMs': 8000,
  'viewport.width': 1280,
  'viewport.height': 900,
  'settle.quietMs': 400,
  'settle.deadlineMs': 5000,
  'settle.revealMs': 2500,
  'settle.thirdPartyMs': 1000,
  'settle.arrivalMs': 2000,
  'open.dialogChars': 6000,
  'actions.timeoutMs': 5000,
  'command.timeoutMs': 75000,
  'read.timeoutMs': 20000,
  'wait.timeoutMs': 15000,
  'explore.depth': 2,
  'http.shellChars': 200,
  'explore.max': 40,
  'explore.waitMs': 1500,
  'render.pageChars': 15000,
  'render.maxChars': 400000,
  'render.nameChars': 120,
  'render.labelChars': 40,
  'render.mapFew': 8,
  'data.rows': 20,
  'data.minRepeats': 3,
  'data.minParts': 2,
  'blocked.controls': 30,
  'network.keep': 300,
  'network.bodyChars': 4000,
  'network.keepBytes': 5_000_000,
  'daemon.idleMs': 30 * 60 * 1000,
}

export type Policy = typeof DEFAULTS

// Overrides come from <home>/policy.json. A wrong key or value is an error, never ignored.
export function loadPolicy(file = join(home(), 'policy.json')): Policy {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS }
    throw err
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch (err) { throw new Error(`policy ${file}: ${(err as Error).message}`) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`policy ${file}: expected an object of key: value`)
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) throw new Error(`policy ${file}: unknown key "${key}"`)
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`policy ${file}: "${key}" must be a positive number`)
  }
  return { ...DEFAULTS, ...(raw as Partial<Policy>) }
}
