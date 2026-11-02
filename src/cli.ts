#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Field, Verb } from './html.js'
import { home, lastPage, request, saveLastPage, type Response, type Saved } from './session.js'
import { paginate, renderText } from './render.js'
import { loadPolicy } from './policy.js'
import { live, VERSION } from './client.js'
import { findBrowser, PROFILE_FLAGS } from './browser.js'
import type { Command } from './daemon.js'

const HELP = `browser-layer — websites as text and verbs for agents. <ref> is a number from the map, or a control's name.

Plain HTTP, no browser:  open <url>|<ref> · verbs · do <verb> k=v ... · --json
Live tabs (headless browser, runs the page's JS):
  tab <url> [url...]           open tabs, several side by side (an open page is switched to)
  go <url> · back · forward · reload · tabs · use <id> · close [id] · stop
                               a page answers whole when short, else with its map
  steps '<cmd>; <cmd>; ...'    several commands in one call: actions answer in one line, reads and
                               the last step in full; the first error stops the rest
  map                          regions, fields, actions, lists and links, with refs
  read [ref] [--page N] [--full]   the page or one region; read again: what changed
  find <text> [--page N]       lines that contain it
  get <ref> [--sort col] [--desc] [--limit N] [--cols a,b] [--urls]   a list or table as records (TSV)
  --out <file>                 on open, read, find, get: the whole result to a file
  click · dblclick · rightclick · hover <ref>      check · uncheck <ref>      submit <ref>
  type <ref> <text> [--enter] [--keys]   pick <ref> <option>   press <key>   drag <ref> <onto ref>
  scroll [ref] [down|up|top|bottom]   upload <ref> <file...>   wait [--gone] <text>
  dialog accept [text] | dismiss   explore [ref] (open menus, list them)   menu "A > B > C"
  eval <js>                    run JavaScript in the page; the result as JSON
  net [--all] · net show <#> · net save <#> <file>   the page's requests and their bodies
  cookies [domain] · cookies clear [domain] · storage local|session [clear]
  allow <perm>[,perm] [lat,lon]   grant to the current site (images loads pictures, off by default)
  screenshot [ref] [file] [--full]   a PNG for a person
Pop-ups open as tabs and become current; downloads are saved and reported.

show / hide: watch the browser in a window. login <url>: a person signs in; the agent stays signed in.
--session <name> (BROWSER_LAYER_SESSION): an agent's own tabs, cookies shared. --profile <name>: a separate browser.
BROWSER_LAYER_BROWSER=<path> picks the browser.
install · browser · update · --version`

const LIVE = new Set(['tab', 'go', 'back', 'forward', 'reload', 'tabs', 'use', 'map', 'read', 'get', 'dblclick', 'rightclick', 'hover', 'upload', 'scroll', 'wait', 'dialog', 'eval', 'allow', 'explore', 'menu', 'check', 'uncheck', 'submit', 'drag', 'find', 'cookies', 'storage', 'click', 'type', 'pick', 'press', 'net', 'close', 'stop', 'screenshot'])

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

let session = process.env.BROWSER_LAYER_SESSION || 'default'

const short = (href: string, from: string) => {
  const u = new URL(href)
  return u.host === new URL(from).host ? `${u.pathname}${u.search}` : `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`
}

function fieldLine(f: Field): string {
  const name = `${f.name}${f.required ? '*' : ''}`
  const kind = f.multi ? `any of ${f.options!.join(', ')}` : f.options ? f.options.join(' | ') : f.type
  const extra = [
    f.label && f.label !== f.name ? `"${f.label}"` : '',
    f.multi ? (f.value ? `= ${f.value}` : '') : f.type === 'checkbox' ? (f.checked ? 'checked' : 'unchecked') : f.value && !f.options ? `= ${JSON.stringify(f.value)}` : '',
  ].filter(Boolean).join(' ')
  return `    ${name.padEnd(16)} ${kind}${extra ? `  ${extra}` : ''}`
}

// Hidden fields and the submitter are sent as the page set them; the agent sees what it can fill.
const verbView = (v: Verb, from: string) => [`  ${v.name} → ${v.method} ${short(v.action, from)}`, ...v.fields.filter(f => f.type !== 'hidden' && f.type !== 'submit').map(fieldLine)].join('\n')

// The most of a non-HTML body (JSON, text) an answer shows; --out writes all of it.
const BODY_CHARS = 8000

// A fetched page reads like a live one: the same tree and renderer, plus its forms as verbs. JSON is
// printed compact: indentation is for eyes, and for an agent only tokens. --out writes the whole result.
async function show(res: Response, json: boolean, out?: string) {
  if (!/html|xml/.test(res.type) && res.body.trimStart()[0] !== '<') {
    if (json) return console.log(JSON.stringify({ url: res.url, status: res.status, type: res.type, body: res.body }))
    if (out) { writeFileSync(out, res.body); return console.log(`saved ${out}: ${res.body.length} chars`) }
    const more = res.body.length > BODY_CHARS ? `\n… ${res.body.length - BODY_CHARS} more chars: --out <file> writes it all` : ''
    return console.log(`${res.url}  [${res.status}]  ${res.type}\n\n${res.body.slice(0, BODY_CHARS)}${more}`)
  }
  // The HTML parser is loaded here, not at startup: live-tab commands never need it.
  const { readHtml } = await import('./html.js')
  const page = readHtml(res.body, res.url, res.status)
  saveLastPage(session, { url: page.url, links: page.links, verbs: page.verbs })
  if (json) return console.log(JSON.stringify(page))
  const policy = loadPolicy()
  const text = renderText(page.tree, new URL(page.url).origin, { nameChars: policy['render.nameChars'], labelChars: policy['render.labelChars'] })
  if (out) { writeFileSync(out, `${text}\n`); return console.log(`saved ${out}: ${text.split('\n').length} lines, ${text.length} chars`) }
  const [first, ...more] = paginate(text, policy['render.pageChars'])
  const lines = [`${page.url}  [${page.status}]${page.title ? `  "${page.title}"` : ''}`, '', first]
  if (more.length) lines.push(`… ${more.join('\n').length} more chars: --out <file> writes it all`)
  if (page.verbs.length) lines.push('', 'verbs:', ...page.verbs.map(v => verbView(v, page.url)))
  // Little to read but scripts to run: the page is built in the browser, which the fast path never runs.
  if (text.length < policy['http.shellChars'] && page.scripts) lines.push('', `this page builds itself with JavaScript; browser-layer tab ${page.url} runs it`)
  console.log(lines.join('\n').trimEnd())
}

function needPage(): Saved {
  return lastPage(session) ?? fail('no page open yet — run: browser-layer open <url>')
}

// HTML form submission: the entry list in tree order (fields, dirname, the submitter), newlines as CRLF,
// then one of the three encodings. GET always sends it urlencoded in the action's query.
function encode(verb: Verb, args: Record<string, string>): { method: string; body: URLSearchParams | FormData | string; type?: string } {
  const known = new Set(verb.fields.map(f => f.name))
  const unknown = Object.keys(args).filter(k => !known.has(k))
  if (unknown.length) fail(`unknown field ${unknown.join(', ')}\n\n${verbView(verb, verb.action)}`)
  const entries: [string, string][] = []
  const missing: string[] = []
  for (const f of verb.fields) {
    const given = args[f.name]
    if (f.type === 'submit') { entries.push([f.name, f.value]); continue }
    if (f.multi) {
      const picked = (given ?? f.value).split(',').map(s => s.trim()).filter(Boolean)
      const bad = picked.filter(p => !f.options!.includes(p))
      if (bad.length) fail(`${f.name} takes any of: ${f.options!.join(', ')} (comma-separated), not ${bad.join(', ')}`)
      for (const p of picked) entries.push([f.name, p])
      continue
    }
    if (f.type === 'checkbox') {
      const on = given === undefined ? f.checked : !/^(false|off|no|0)$/i.test(given)
      if (on) entries.push([f.name, given && !/^(true|on|yes|1)$/i.test(given) ? given : f.value])
      continue
    }
    const value = given ?? f.value
    if (f.options && given !== undefined && !f.options.includes(given)) fail(`${f.name} must be one of: ${f.options.join(' | ')}`)
    if (f.required && !value) missing.push(f.name)
    if (f.type === 'radio' && !value) continue
    entries.push([f.name, value])
    if (f.dirname) entries.push([f.dirname, 'ltr'])
  }
  if (missing.length) fail(`missing required ${missing.join(', ')}\n\n${verbView(verb, verb.action)}`)
  const crlf = (t: string) => t.replace(/\r\n|\r|\n/g, '\r\n')
  const list = entries.map(([k, v]) => [crlf(k), crlf(v)] as [string, string])
  if (verb.method === 'GET' || verb.enctype === 'application/x-www-form-urlencoded') return { method: verb.method, body: new URLSearchParams(list), type: 'application/x-www-form-urlencoded' }
  if (verb.enctype === 'text/plain') return { method: 'POST', body: list.map(([k, v]) => `${k}=${v}\r\n`).join(''), type: 'text/plain' }
  const form = new FormData()
  for (const [k, v] of list) form.append(k, v)
  return { method: 'POST', body: form }
}

// Flags with no value, anywhere among a command's words.
const FLAGS = new Set(['--json', '--enter', '--all', '--desc', '--gone', '--keys', '--full', '--urls'])

// A command's words: flags that carry a value are taken out wherever they are, then the command, its target
// and the rest are what is left.
function parse(words: string[]) {
  const argv = [...words]
  const take = (flag: string) => {
    const at = argv.indexOf(flag)
    if (at < 0) return undefined
    const value = argv[at + 1] ?? fail(`usage: ${flag} <value>`)
    argv.splice(at, 2)
    return value
  }
  const count = (flag: string) => {
    const v = take(flag)
    if (v !== undefined && !/^[1-9]\d*$/.test(v)) fail(`usage: ${flag} <number from 1>`)
    return v === undefined ? undefined : Number(v)
  }
  const page = count('--page')
  const limit = count('--limit')
  const sort = take('--sort')
  const cols = take('--cols')?.split(',').map(c => c.trim())
  // The daemon runs elsewhere, so the file is resolved against the agent's working directory here.
  const out = take('--out')
  const file = out === undefined ? undefined : resolve(out)
  const session = take('--session')
  const profile = take('--profile')
  const has = (flag: string) => argv.includes(flag)
  const [cmd, target, ...rest] = argv.filter(a => !FLAGS.has(a))
  return { cmd, target, rest, page, limit, sort, cols, file, session, profile, has }
}

// steps: commands separated by ; or a new line, each read as words the way a shell reads them ('…' and
// "…" quote, \ escapes inside "…"). The text of each step is kept for its line in the answer.
function script(text: string): { raw: string; words: string[] }[] {
  const steps: { raw: string; words: string[] }[] = []
  let words: string[] = [], word: string | undefined, quote = '', raw = ''
  const end = () => { if (word !== undefined) words.push(word); word = undefined }
  const close = () => { end(); if (words.length) steps.push({ raw: raw.trim(), words }); words = []; raw = '' }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      raw += ch
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) word = (word ?? '') + text[++i], raw += text[i]
      else word = (word ?? '') + ch
    } else if (ch === ';' || ch === '\n') close()
    else {
      raw += ch
      if (ch === '"' || ch === "'") { quote = ch; word ??= '' }
      else if (/\s/.test(ch)) end()
      else word = (word ?? '') + ch
    }
  }
  if (quote) fail(`steps: a ${quote} is not closed`)
  close()
  return steps
}

type Parsed = ReturnType<typeof parse>

// A live-tab command from its parsed words.
function liveCommand({ cmd, target, rest, page, limit, sort, cols, file, has }: Parsed): Command {
  const c: Command = { cmd, session, page, limit, sort, cols, desc: has('--desc'), urls: has('--urls'), out: file, gone: has('--gone'), keys: has('--keys'), enter: has('--enter'), all: has('--all') }
  if (cmd === 'tab' || cmd === 'go') c.url = target ?? fail(`usage: browser-layer ${cmd} <url>`)
  if (cmd === 'tab' && rest.length) c.more = rest
  if (cmd === 'use' || (cmd === 'close' && target)) c.id = Number(target)
  if (cmd === 'net' && target) {
    if (!['show', 'save'].includes(target) || !/^#?\d+$/.test(rest[0] ?? '') || (target === 'save' && !rest[1])) fail('usage: browser-layer net [--all] | net show <#> | net save <#> <file>')
    c.id = Number(rest[0].replace('#', ''))
    if (target === 'save') c.files = [resolve(rest[1])]
  }
  if (['click', 'dblclick', 'rightclick', 'hover', 'type', 'pick', 'upload', 'check', 'uncheck', 'submit', 'drag'].includes(cmd)) c.ref = target ?? fail(`usage: browser-layer ${cmd} <ref>`)
  if (cmd === 'drag') c.to = rest[0] ?? fail('usage: browser-layer drag <ref> <onto ref>')
  if (cmd === 'find') c.text = [target, ...rest].filter(Boolean).join(' ')
  if (cmd === 'cookies') [c.dir, c.url] = target === 'clear' ? ['clear', rest[0]] : [undefined, target]
  if (cmd === 'storage') [c.dir, c.text] = [target, rest[0]]
  // The daemon runs elsewhere, so files are resolved against the agent's working directory here.
  if (cmd === 'upload') c.files = rest.map(f => resolve(f))
  if (cmd === 'screenshot') {
    const [ref, file] = target && /^\d+$/.test(target) ? [target, rest[0]] : [undefined, target]
    ;[c.ref, c.files, c.full] = [ref, [resolve(file ?? `screenshot-${Date.now()}.png`)], has('--full')]
  }
  if (cmd === 'scroll') [c.ref, c.dir] = target && /^\d+$/.test(target) ? [target, rest[0]] : [undefined, target]
  if (cmd === 'dialog') [c.dir, c.text] = [target, rest.length ? rest.join(' ') : undefined]
  if (cmd === 'wait' || cmd === 'eval') c.text = [target, ...rest].filter(Boolean).join(' ')
  if (cmd === 'allow') [c.text, c.dir] = [target, rest[0]]
  if (cmd === 'explore' && target) c.ref = /^\d+$/.test(target) ? target : fail('usage: browser-layer explore [ref]')
  if (cmd === 'menu') c.text = [target, ...rest].filter(Boolean).join(' ')
  if (cmd === 'read') c.full = has('--full')
  if (cmd === 'read' && target) c.ref = /^\d+$/.test(target) ? target : fail('usage: browser-layer read [ref] [--page N]')
  if (cmd === 'get') c.ref = target && /^\d+$/.test(target) ? target : fail('usage: browser-layer get <ref> [--sort col] [--desc] [--limit N] [--cols a,b] [--urls]')
  if (cmd === 'type' || cmd === 'pick') c.text = rest.join(' ')
  if (cmd === 'press') c.key = target ?? fail('usage: browser-layer press <key>')
  return c
}

async function main() {
  const parsed = parse(process.argv.slice(2))
  const { cmd, target, rest, file } = parsed
  session = parsed.session ?? session
  // A profile is a separate browser: its own Chrome profile, cookies and daemon, under <home>/profiles.
  if (parsed.profile !== undefined) {
    if (!/^[\w.-]+$/.test(parsed.profile)) fail('a profile name uses letters, digits, dot, dash or underscore')
    process.env.BROWSER_LAYER_HOME = join(home(), 'profiles', parsed.profile)
  }
  const json = parsed.has('--json')
  const argv = process.argv.slice(2)

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') return console.log(VERSION)

  if (cmd === 'update') {
    const res = await fetch('https://registry.npmjs.org/browser-layer/latest')
    if (!res.ok) fail(`could not reach npm (HTTP ${res.status}); run: npm install -g browser-layer@latest`)
    const latest = ((await res.json()) as { version: string }).version
    // Only a newer release installs: a build ahead of npm (a local checkout) must not be replaced by an older one.
    const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map(Number)
    const newer = parts(latest).map((n, i) => n - parts(VERSION)[i]).find(d => d !== 0)! > 0
    if (!newer) return console.log(`browser-layer ${VERSION} is up to date (npm has ${latest})`)
    // npm.cmd is a batch file on Windows, which spawn runs only through a shell.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const code = await new Promise<number | null>(done => spawn(npm, ['install', '-g', 'browser-layer@latest'], { stdio: 'inherit', shell: process.platform === 'win32' })
      .on('exit', done).on('error', () => done(1)))
    if (code) fail('the update failed; run: npm install -g browser-layer@latest')
    return console.log(`browser-layer ${VERSION} → ${latest}. A browser that was running restarts on the next command.`)
  }

  if (cmd === 'browser') {
    const browser = await findBrowser()
    return 'error' in browser ? fail(browser.error) : console.log(browser.path)
  }

  if (cmd === 'install') {
    // Playwright's own installer, for the Chromium build this playwright-core drives. --with-deps (Linux)
    // also installs the system libraries it needs, through the package manager, so it asks for sudo.
    // The installer is the package's bin, which its exports do not expose; package.json names it.
    const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json')
    const cli = join(dirname(pkg), (JSON.parse(readFileSync(pkg, 'utf8')) as { bin: Record<string, string> }).bin['playwright-core'])
    const code = await new Promise<number | null>(done => spawn(process.execPath, [cli, 'install', 'chromium', ...(argv.includes('--with-deps') ? ['--with-deps'] : [])], { stdio: 'inherit' }).on('exit', done))
    if (code) process.exit(code)
    return console.log(`Installed. The agent's browser: ${((await findBrowser()) as { path: string }).path}`)
  }

  if (cmd === 'show' || cmd === 'hide') {
    // Chrome cannot switch between headless and visible while running, so the browser restarts and every
    // open tab is reopened in its session (the current one last, so it stays current). Sign-ins live in
    // the profile and carry over; page state such as half-filled forms does not.
    const state = await live({ cmd: 'state', session })
    // Never restart blind: if the open tabs cannot be listed (say a daemon from an older build), stop here.
    if (!state.ok) fail(`could not list the open tabs (${state.error}); run browser-layer stop, then try again`)
    const open = JSON.parse(state.text!) as { session: string; url: string; current: boolean }[]
    await live({ cmd: 'stop', session })
    // Only the browser started now is visible; the daemon reads this from its environment at launch.
    process.env.BROWSER_LAYER_VISIBLE = cmd === 'show' ? '1' : ''
    const reopened: string[] = []
    for (const t of [...open.filter(t => !t.current), ...open.filter(t => t.current)]) {
      const r = await live({ cmd: 'tab', session: t.session, url: t.url })
      reopened.push(`  ${t.session}: ${(r.ok ? r.text! : `could not reopen ${t.url}: ${r.error}`).split('\n')[0]}`)
    }
    // Chrome shows a window only when it has a tab, so showing an empty browser opens a blank one.
    if (cmd === 'show' && !open.length) {
      await live({ cmd: 'tab', session, url: 'about:blank' })
      return console.log("The agent's browser is a visible window now, with a blank tab (no tabs were open). Next: browser-layer go <url>")
    }
    return console.log([`The agent's browser is ${cmd === 'show' ? 'a visible window' : 'headless'} now.${open.length ? ' Reopened:' : ''}`, ...reopened].join('\n'))
  }

  if (cmd === 'login') {
    // A plain Chrome window on the agent's own profile, with no automation attached: the person signs
    // in themselves (passwords, 2FA, passkeys stay with them) and the agent's browser keeps the session.
    const url = target ?? fail('usage: browser-layer login <url>')
    const browser = await findBrowser()
    if ('error' in browser) fail(browser.error)
    await live({ cmd: 'stop', session }) // one browser per profile directory at a time
    console.log('Sign in in the browser window that opens, then quit it (close every window of it).')
    await new Promise(done => spawn(browser.path, [`--user-data-dir=${join(home(), 'profile')}`, ...PROFILE_FLAGS, '--no-first-run', '--no-default-browser-check', /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`], { stdio: 'ignore' }).on('exit', done))
    // The jar mirrors the browser after every command; dropping it lets the new session win over stale cookies.
    rmSync(join(home(), 'cookies.json'), { force: true })
    return console.log("Saved. The agent's browser uses this session from the next command.")
  }

  if (cmd === 'steps') {
    const steps = script([target, ...rest].join(' ')).map(({ raw, words }) => {
      const p = parse(words)
      if (!LIVE.has(p.cmd) || p.cmd === 'stop' || p.session !== undefined || p.profile !== undefined) fail(`steps runs live-tab commands, without stop, --session or --profile: "${raw}"`)
      return { ...liveCommand(p), raw }
    })
    if (!steps.length) fail(`usage: browser-layer steps 'type 14 "Mumbai"; press Enter; read'`)
    const reply = await live({ cmd: 'steps', session, steps })
    if (!reply.ok) fail(`error: ${reply.error}`)
    console.log(reply.text)
    // A step that failed stops a shell chain after this call too.
    if (/\nstopped at step \d+ of \d+/.test(reply.text!)) process.exit(1)
    return
  }

  if (LIVE.has(cmd)) {
    const reply = await live(liveCommand(parsed))
    if (!reply.ok) fail(`error: ${reply.error}`)
    return console.log(reply.text)
  }

  if (cmd === 'open' && target) {
    let url = target
    if (/^\d+$/.test(target)) {
      url = needPage().links[Number(target)] ?? fail(`[${target}] is not a link on the last page`)
    } else if (!/^https?:\/\//i.test(target)) url = `https://${target}`
    return show(await request(url), json, file)
  }

  if (cmd === 'verbs') {
    const page = needPage()
    return console.log(json ? JSON.stringify(page.verbs) : page.verbs.map(v => verbView(v, page.url)).join('\n') || 'no verbs on this page')
  }

  if (cmd === 'do' && target) {
    const page = needPage()
    const verb = page.verbs.find(v => v.name === target || v.name === `${target}.submit`)
      ?? fail(`no verb "${target}" on ${page.url}\n\nverbs:\n${page.verbs.map(v => verbView(v, page.url)).join('\n') || '  (none)'}`)
    const args: Record<string, string> = {}
    for (const pair of rest) {
      const eq = pair.indexOf('=')
      if (eq < 1) fail(`expected key=value, got "${pair}"`)
      args[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    const { method, body, type } = encode(verb, args)
    if (method === 'GET') {
      const url = new URL(verb.action)
      url.search = body.toString()
      return show(await request(url.href), json, file)
    }
    const headers: Record<string, string> = type ? { 'content-type': type } : {}
    return show(await request(verb.action, { method, body: body instanceof FormData ? body : body.toString(), headers: { ...headers, referer: page.url, origin: new URL(page.url).origin } }), json, file)
  }

  if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
    console.error(`unknown command "${cmd}"\n`)
    console.error(HELP)
    process.exit(1)
  }
  console.log(HELP)
}

main().catch(err => fail(`error: ${err instanceof Error ? err.message : err}`))
