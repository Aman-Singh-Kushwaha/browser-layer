// Which browser the agent drives: the first Chromium-family browser found, the same one for the
// daemon and for `login`, so both read and write the same profile. BROWSER_LAYER_BROWSER overrides.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const env = (name: string) => process.env[name] ?? ''

// Installed browsers by platform, in order of preference: Chrome, then Edge, then Chromium.
function installed(): string[] {
  if (process.platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Chromium.app/Contents/MacOS/Chromium']
    return apps.flatMap(a => [join('/Applications', a), join(homedir(), 'Applications', a)])
  }
  if (process.platform === 'win32') {
    const roots = [env('PROGRAMFILES'), env('PROGRAMFILES(X86)'), env('LOCALAPPDATA')].filter(Boolean)
    return ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe'].flatMap(p => roots.map(r => join(r, p)))
  }
  // Linux and the BSDs: whatever is on PATH under the names distributions use.
  const names = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'chromium', 'chromium-browser']
  return names.flatMap(n => env('PATH').split(delimiter).filter(Boolean).map(d => join(d, n))).concat('/snap/bin/chromium')
}

/** The browser executable, or why there is none. */
export async function findBrowser(): Promise<{ path: string } | { error: string }> {
  const chosen = env('BROWSER_LAYER_BROWSER')
  if (chosen) return existsSync(chosen) ? { path: chosen } : { error: `BROWSER_LAYER_BROWSER is ${chosen}, which does not exist` }
  // Last: the Chromium that `browser-layer install` downloads. Playwright takes ~200 ms to load, so
  // only a machine without an installed browser pays for it.
  const path = installed().find(p => existsSync(p)) ?? (await import('playwright-core')).chromium.executablePath()
  return existsSync(path) ? { path } : { error: 'no Chrome, Edge or Chromium found — install one, run `browser-layer install` to download Chromium, or set BROWSER_LAYER_BROWSER to a browser executable' }
}

// The cookie store the agent's browser uses: Playwright launches Chromium with these on every platform,
// so a window `login` opens must too, or the session it saves cannot be decrypted and is dropped.
// Chromium will not start as root on Linux with its sandbox on (containers, root shells); Playwright
// turns it off for the agent's browser, and a window `login` opens as root needs the same.
export const PROFILE_FLAGS = ['--password-store=basic', '--use-mock-keychain', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]

/** The address of the Chrome a person has open with remote debugging switched on (chrome://inspect/#remote-debugging):
 * Chrome writes it to DevToolsActivePort in its profile directory. */
export function openChrome(): string | undefined {
  const dir = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
    : process.platform === 'win32' ? join(env('LOCALAPPDATA'), 'Google', 'Chrome', 'User Data') : join(homedir(), '.config', 'google-chrome')
  try {
    const [port, path] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')
    return `ws://127.0.0.1:${port}${path}`
  } catch {
    return undefined
  }
}

/** Show the person Chrome's page for switching remote debugging on. False where this cannot be done from here. */
export function openInspectPage(): boolean {
  if (process.platform !== 'darwin') return false
  const url = 'chrome://inspect/#remote-debugging'
  return spawnSync('osascript', ['-e', 'tell application "Google Chrome" to activate', '-e', `tell application "Google Chrome" to open location "${url}"`]).status === 0
}
