// The background process that keeps live tabs alive between CLI calls.
// It owns one headless Chrome, a persistent profile, and a socket the CLI talks to.
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type Page, type Request, type Route } from 'playwright-core'
import { isTracker } from './trackers.js'
import { findBrowser } from './browser.js'
import { home, loadJar, saveJar, type Cookie } from './session.js'
import { COLLECTIONS, LANDMARKS, humanCheck, isTrigger, newRefs, readTree, withRefs, type Node, type Refs } from './reader.js'
import { diffLines, findRef, itemsLine, paginate, renderMap, renderText } from './render.js'
import { call, drag, fill, heldBy, isChecked, isFileInput, pick, pointer, setFiles, submit, wheel, type Pointer, type Target } from './act.js'
import { query, records, toTsv, type Query } from './data.js'
import { pidPath, ping, socketPath, VERSION } from './client.js'
import { loadPolicy, type Policy } from './policy.js'

// Decoration the agent never needs; DESIGN §1 principle 3. Never requested.
const DECORATION = new Set(['image', 'font', 'media'])

// BROWSER_LAYER_ATTACH is the debugging address of a person's own Chrome. Attached, the daemon works only in tabs it
// opened: it never closes the browser or the person's tabs, copies none of its cookies to disk, and changes no
// setting that reaches their other tabs.
const ATTACH = process.env.BROWSER_LAYER_ATTACH
// Sites the agent let load decoration (`allow images`), by the origin of the page they are on.
const pictured = new Set<string>()
const siteOf = (r: Request) => { try { return new URL(r.frame().page().url()).origin } catch { return '' } }
// The tallest picture Chrome captures (its GPU texture limit); a taller whole-page screenshot crashes the tab.
const SHOT_MAX_PX = 16384
// The most text runs remembered per canvas, and how close (px) runs must be vertically to share a line.
const CANVAS_RUNS = 5000
const CANVAS_LINE_PX = 4

// Runs in every document before the page's own scripts. It records, without changing the page: a
// signature of the text the page shows (for settle), elements given hover listeners (the reader marks
// them "reacts to hover"), and text drawn on 2D canvases with its position, forgetting text a clearRect
// paints over.
const PAGE_HOOKS = `(() => {
  // What the agent will read is the shown text, so settle waits on it, not on every DOM change: ads,
  // timers and animations change the DOM all the time without changing a word.
  // innerText leaves out shadow trees, so the ones the page creates are kept and their text counted too.
  window.__alDraws = 0
  let roots = []
  const attach = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (...args) { const r = attach.apply(this, args); roots.push(r); return r }
  window.__alText = () => {
    if (roots.length > 1000) roots = roots.filter(r => r.host.isConnected)
    const t = (document.body ? document.body.innerText : '') + roots.map(r => (r.host.isConnected ? r.textContent : '')).join('')
    let h = t.length + window.__alDraws
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0
    return h
  }
  // Text is present but hardly any of it shows (results revealed after load, a page behind a loader).
  window.__alHidden = () => {
    const shown = document.body ? document.body.innerText.length : 0
    if (shown >= 500) return false
    let all = 0
    const w = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT)
    while (w.nextNode()) if (!/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(w.currentNode.parentNode.nodeName)) all += w.currentNode.data.trim().length
    return all > 2000 && all > 4 * shown
  }
  const HOVER = new Set(['mouseenter', 'mouseover', 'pointerenter', 'pointerover'])
  const CLICK = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'])
  window.__alHover = new Set()
  window.__alClick = new Set()
  const listen = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (this instanceof Element && this !== document.documentElement && this !== document.body) {
      if (HOVER.has(type)) window.__alHover.add(this)
      if (CLICK.has(type)) window.__alClick.add(this)
    }
    return listen.call(this, type, ...rest)
  }
  const C = globalThis.CanvasRenderingContext2D
  if (!C) return
  const runs = new WeakMap(), canvases = new Set()
  const at = (ctx, x, y) => { const m = ctx.getTransform(); return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] }
  for (const fn of ['fillText', 'strokeText']) {
    const draw = C.prototype[fn]
    C.prototype[fn] = function (text, x, y, ...rest) {
      try {
        let m = runs.get(this.canvas)
        if (!m) { m = new Map(); runs.set(this.canvas, m); canvases.add(this.canvas) }
        const [px, py] = at(this, x, y)
        m.set(Math.round(px) + ',' + Math.round(py), [String(text), px, py])
        if (m.size > ${CANVAS_RUNS}) m.delete(m.keys().next().value)
        window.__alDraws++
      } catch {}
      return draw.call(this, text, x, y, ...rest)
    }
  }
  const clear = C.prototype.clearRect
  C.prototype.clearRect = function (x, y, w, h) {
    try {
      const m = runs.get(this.canvas)
      const [x0, y0] = at(this, x, y), [x1, y1] = at(this, x + w, y + h)
      if (m) for (const [k, [, px, py]] of m) if (px >= Math.min(x0, x1) && px <= Math.max(x0, x1) && py >= Math.min(y0, y1) && py <= Math.max(y0, y1)) m.delete(k)
    } catch {}
    return clear.call(this, x, y, w, h)
  }
  window.__alCanvases = () => [...canvases].filter(c => c.isConnected && runs.get(c)?.size)
  window.__alCanvasRuns = c => [...runs.get(c).values()]
  // Runs within half a line of each other read as one line, left to right.
  window.__alCanvasLines = c => {
    const all = [...runs.get(c).values()].sort((a, b) => a[2] - b[2] || a[1] - b[1])
    const lines = []
    for (const [t, x, y] of all) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(y - last.y) < ${CANVAS_LINE_PX}) last.parts.push([x, t]); else lines.push({ y, parts: [[x, t]] })
    }
    return lines.map(l => l.parts.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' · '))
  }
})()`
// Animations and transitions finish at once, so pages settle without waiting on motion.
const MOTION_RATE = 1000

// Binary bodies (protobuf, gzip) would corrupt the terminal and anything piped after it.
function printable(body: string | null | undefined, max: number): string | undefined {
  if (!body) return undefined
  const bad = body.slice(0, 300).replace(/[\x20-\x7e\t\n\r\u00a0-\uffff]/g, '').length
  return bad > 2 ? `<binary, ${body.length} bytes>` : body.length > max ? `${body.slice(0, max)}… (${body.length - max} more chars)` : body
}

// Credentials never reach the agent's context: an LLM transcript is not the place for a session token.
const SECRET_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf-token|x-xsrf-token)$/i
const headerLines = (h: Record<string, string>) =>
  Object.entries(h).map(([k, v]) => `  ${k}: ${SECRET_HEADERS.test(k) ? '<redacted>' : v}`).join('\n')

// Requests that carry no data for the agent: beacons, 204 No Content, and the tracker list.
const noise = (r: Req) => r.kind === 'ping' || r.status === 204 || isTracker(r.url)

// body: an API answer (fetch, XHR), kept when it arrives: the browser drops it once the page moves on.
type Req = { id: number; method: string; url: string; status: number; type: string; kind: string; post?: string; request: Request; body?: Buffer }
// shown: the last full text the agent received per context (the page, or a modal dialog by name), so
// actions answer with what changed even when a dialog opens over the page and closes again.
// frames: cross-origin frames with their own engine session, and the iframe element that owns each.
// dialog: an alert/confirm/prompt waiting for the agent. opened: pop-ups since the last answer.
type Frame = { cdp: CDPSession; owner: { scope: string; id: number } }
type Tab = {
  id: number; session: string; page: Page; cdp: CDPSession; refs: Refs; doc: number; shown: Map<string, { doc: number; text: string }>
  // read: the whole page as the agent last read it, so reading it again answers with what changed.
  read?: { doc: number; text: string }
  // seen: each region's full text as last shown in a map (map) or in full (text), by ref, across the
  // tab's pages: a site's menus and footer are shown once, not on every page (render Seen).
  seen: { map: Map<number, string>; text: Map<number, string> }
  // used: when a command last acted on this tab; `tabs` lists by it.
  used: number
  pending: Map<Request, number>; standing: Set<string>; net: Req[]; netId: number; frames: Map<string, Frame>; dialog?: Dialog; opened: number[]
  downloads: { file: string; size: number; url: string }[]; saving: Promise<void>[]; status?: number; retryAfter?: string
  // The document the current command began on, and when a new one arrived during it: which of another
  // site's data calls count (caused).
  startDoc?: number; arrived?: number
}
export type Command = {
  cmd: string; session: string; urls?: boolean; out?: string; url?: string; ref?: string; text?: string; key?: string; id?: number; enter?: boolean; all?: boolean
  page?: number; files?: string[]; dir?: string; gone?: boolean; keys?: boolean; to?: string; full?: boolean; version?: string
  // steps: the commands to run, each with the text it was given as.
  steps?: Command[]; raw?: string
} & Query

// Commands that only read a page (use reads the tab it switches to), for the shorter time limit.
const READS = new Set(['read', 'map', 'find', 'get', 'screenshot', 'net', 'tabs', 'cookies', 'storage', 'use'])

// Tab ids are unique across the daemon; each session (one agent, one task) has its own current tab.
const tabs = new Map<number, Tab>()
const current = new Map<string, number>()
let nextId = 1
let ctx: BrowserContext
let browser: Browser | undefined
let policy: Policy

function toBrowser(c: Cookie) {
  return { name: c.name, value: c.value, domain: c.hostOnly ? c.domain : `.${c.domain}`, path: c.path, expires: c.expires ? c.expires / 1000 : -1, secure: !!c.secure }
}

// Before each command: whatever the fast path logged into since, the browser gets too.
async function pullCookies() {
  if (ATTACH) return
  const jar = loadJar().filter(c => !c.expires || c.expires > Date.now())
  if (jar.length) await ctx.addCookies(jar.map(toBrowser)).catch(() => {})
}

// After each command: the browser now holds the jar plus its own changes, so it is the whole truth.
async function syncCookies() {
  if (ATTACH) return
  const jar: Cookie[] = (await ctx.cookies()).map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain.replace(/^\./, ''),
    hostOnly: !c.domain.startsWith('.'),
    path: c.path,
    expires: c.expires > 0 ? c.expires * 1000 : undefined,
    secure: c.secure,
  }))
  saveJar(jar)
}

function track(tab: Tab) {
  const { page } = tab
  page.on('request', r => { if (r.resourceType() !== 'websocket') tab.pending.set(r, Date.now()) })
  page.on('requestfailed', r => { tab.pending.delete(r) })
  page.on('requestfinished', async r => {
    tab.pending.delete(r)
    const kind = r.resourceType()
    if (kind !== 'document' && kind !== 'xhr' && kind !== 'fetch' && kind !== 'ping') return
    const res = await r.response().catch(() => null)
    const body = kind === 'xhr' || kind === 'fetch' ? await res?.body().catch(() => undefined) : undefined
    tab.net.push({
      id: ++tab.netId,
      method: r.method(),
      url: r.url(),
      status: res?.status() ?? 0,
      type: (res?.headers()['content-type'] ?? '').split(';')[0],
      kind,
      post: printable(r.postData(), 300)?.replace(/\s+/g, ' '),
      request: r,
      body: body && body.length <= policy['network.keepBytes'] ? body : undefined,
    })
    if (tab.net.length > policy['network.keep']) tab.net.shift()
  })
  page.on('close', () => {
    tabs.delete(tab.id)
    if (current.get(tab.session) !== tab.id) return
    const next = [...tabs.values()].filter(t => t.session === tab.session).pop()
    if (next) current.set(tab.session, next.id)
    else current.delete(tab.session)
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The page's standing connections (a long-poll channel, a stream) are not the action's doing. Requests
// open when a command begins are standing, and so is a request that reopens one of their channels.
let commandStart = Date.now()
const channel = (url: string) => { const u = new URL(url); return `${u.origin}${u.pathname}` }
function beginCommand() {
  commandStart = Date.now()
  for (const t of tabs.values()) {
    t.standing = new Set([...t.pending.keys()].map(r => channel(r.url())))
    t.startDoc = t.doc
    t.arrived = undefined
  }
}
// A site is its registrable domain: news.example.co.uk and static.example.co.uk are one site. Two-letter
// country domains under a short label (co.uk, com.au) take three labels; an IP address is its own site.
const registrable = (url: string) => {
  try {
    const host = new URL(url).hostname
    if (/^[\d.]+$|:/.test(host)) return host
    const p = host.split('.')
    return p.slice(p.length > 2 && p[p.length - 2].length <= 3 && p[p.length - 1].length === 2 ? -3 : -2).join('.')
  } catch { return '' }
}
// Requests the current command caused that are still in flight and that the page's content waits on: the
// site's own. Another site's requests (ads, analytics, widgets) keep a page busy for seconds and change
// nothing the agent reads, so only its data calls (fetch, XHR) count, and only where content may come from
// them: on a loaded page, those an action starts right away (a search box served by a search API); on a
// page that just arrived, those its scripts make in its first settle.arrivalMs, each for that long at most,
// since ad scripts keep making more (results served by another site's API).
const caused = (tab: Tab) => {
  const site = registrable(tab.page.url())
  return [...tab.pending].filter(([r, at]) => {
    if (at < commandStart || tab.standing.has(channel(r.url())) || r.resourceType() === 'eventsource' || isTracker(r.url())) return false
    if (registrable(r.url()) === site) return true
    if (r.resourceType() !== 'xhr' && r.resourceType() !== 'fetch') return false
    if (tab.doc === tab.startDoc) return at - commandStart < policy['settle.thirdPartyMs']
    return tab.arrived !== undefined && at - tab.arrived < policy['settle.arrivalMs'] && Date.now() - at < policy['settle.arrivalMs']
  }).length
}

// Settled when the site's own requests are done and the shown text has not changed for settle.quietMs;
// or a dialog is waiting (the page is blocked until it is answered); or the deadline passes. A page with
// plenty of text but hardly any shown is given settle.revealMs to show it. A document that has not
// finished arriving in load.domMs is read as far as it got. Says which.
async function settle(tab: Tab, deadline = policy['settle.deadlineMs']): Promise<string> {
  const start = Date.now()
  const arrived = await tab.page.waitForLoadState('domcontentloaded', { timeout: policy['load.domMs'] }).then(() => true, () => false)
  if (!arrived) return `still loading after ${policy['load.domMs'] / 1000} s; this is what has arrived`
  if (tab.doc !== tab.startDoc) tab.arrived ??= Date.now()
  const end = Date.now() + deadline
  let last: unknown
  let hidden: boolean | undefined
  let quietSince = Date.now()
  while (Date.now() < end) {
    if (tab.dialog) return 'dialog'
    // A dialog opening mid-read blocks page scripts, so the read is bounded.
    const text = await Promise.race([tab.page.evaluate('window.__alText?.() ?? 0').catch(() => -2), sleep(500).then(() => -3)])
    if (text !== last || caused(tab) > 0) { last = text; hidden = undefined; quietSince = Date.now() }
    else if (Date.now() - quietSince >= policy['settle.quietMs']) {
      hidden ??= await Promise.race([tab.page.evaluate('window.__alHidden?.() ?? false').catch(() => false), sleep(500).then(() => false)]) === true
      if (!hidden || Date.now() - quietSince >= policy['settle.revealMs']) return `idle in ${Date.now() - start} ms`
    }
    await sleep(100)
  }
  return `deadline ${deadline} ms (the page kept changing)`
}

// How settling ended, for an answer that names it only when it was not the usual quiet page.
const unusual = (settled: string) => (settled.startsWith('idle') ? '' : settled)

// A 429 asks the client to come back later (RFC 6585): the page is loaded again once, after the wait the
// site names (Retry-After in seconds), at most load.retryMs. Returns a note for the answer, or ''.
async function arrive(tab: Tab): Promise<string> {
  if (tab.status !== 429) return ''
  const wait = Math.min(Number(tab.retryAfter) > 0 ? Number(tab.retryAfter) * 1000 : 2000, policy['load.retryMs'])
  await sleep(wait)
  await tab.page.reload({ waitUntil: 'commit', timeout: policy['load.timeoutMs'] }).catch(() => {})
  return `the site said too many requests (HTTP 429); loaded again after ${wait / 1000} s`
}

const caps = () => ({ nameChars: policy['render.nameChars'], labelChars: policy['render.labelChars'] })

// One read of the page: the tree and its full text.
async function snapshot(tab: Tab) {
  const tree = await readTree(tab.cdp, tab.refs, { minRepeats: policy['data.minRepeats'], minParts: policy['data.minParts'], revealItems: policy['render.mapFew'] }, (id, owner) => frameSession(tab, id, owner))
  const origin = new URL(tab.page.url()).origin
  return { tree, origin, text: renderText(tree, origin, caps()) }
}

// The full text of what the agent has been shown last, per context; later actions diff against it.
const remember = (tab: Tab, text: string) => tab.shown.set(contextOf(text), { doc: tab.doc, text })

const header = async (tab: Tab) => {
  const title = await tab.page.title()
  return `tab ${tab.id}  ${tab.page.url()}${title ? `  "${title}"` : ''}`
}

// A page that turned the agent away: the site refused this browser, or put a human check in front of it.
// The agent never solves or evades either (DESIGN §1: no anti-bot evasion), but a block often covers one
// page and not the site: the normal way in (home page, the site's own search, another page, a retry after
// a wait) is tried first, and a person can clear it in the window.
// A check provider's frame is a check only when a person can see it: reCAPTCHA's invisible helper frames
// (which ad scripts load on ordinary pages) are hidden or have no size, while a checkbox or a challenge is
// a box on the page.
const SHOWN_PX = 30
async function shownFrames(tab: Tab): Promise<string[]> {
  const shown = await Promise.all(tab.page.frames().filter(f => f !== tab.page.mainFrame()).map(async f => {
    const box = await f.frameElement().then(e => e.boundingBox()).catch(() => null)
    return box && box.width >= SHOWN_PX && box.height >= SHOWN_PX ? f.url() : undefined
  }))
  return shown.filter((u): u is string => u !== undefined)
}

async function blocked(tab: Tab, tree: Node): Promise<string> {
  const check = humanCheck(await shownFrames(tab), tree, policy['blocked.controls'])
  if (!check && tab.status !== 403 && tab.status !== 429) return ''
  const why = check ? 'a human check (CAPTCHA) is on this page' : `the site refused this browser (HTTP ${tab.status})`
  return `\nblocked: ${why}. Do not solve or evade the check. Try another normal way in first: the site's home page or its own search, a different page of the site, or this page again after a short wait. If it stays blocked, a person can clear it: browser-layer show, clear it in that window, then browser-layer hide\n`
}

// Opening a page answers with its map (DESIGN §1a); read and read <ref> go deeper. A map that answers a
// page load shows regions already shown, unchanged, in one line; one the agent asks for (map, use, a
// switch to an open tab) is whole, since that is when it wants every ref again.
async function mapView(tab: Tab, snap?: Awaited<ReturnType<typeof snapshot>>, settled = '', note = '', whole = false): Promise<string> {
  const { tree, origin, text } = snap ?? await snapshot(tab)
  remember(tab, text)
  const now = new Map<number, string>()
  const map = renderMap(tree, origin, caps(), policy['render.mapFew'], { before: whole ? new Map() : tab.seen.map, now })
  for (const [ref, whole] of now) tab.seen.map.set(ref, whole)
  if (!map.trim()) note = [note, 'no content yet: the page may still be loading; read again'].filter(Boolean).join('; ')
  return `${await header(tab)}${note ? `  — ${note}` : ''}${settled ? `  — settled: ${settled}` : ''}\n${await blocked(tab, tree)}\n${map}\n\n(read <ref> opens a region · read gives the whole page)`
}

// A dialog an action opened (a date picker, a list of suggestions) answers with what it holds when that is
// short, refs included, so the next step can act on it without reading it first; a long one, with its map.
async function openedView(tab: Tab, snap: Awaited<ReturnType<typeof snapshot>>, settled = ''): Promise<string> {
  const now = new Map<number, string>()
  const short = renderText(snap.tree, snap.origin, caps(), { before: tab.seen.text, now })
  if (short.length > policy['open.dialogChars']) return mapView(tab, snap, settled)
  remember(tab, snap.text)
  for (const [ref, whole] of now) { tab.seen.text.set(ref, whole); tab.seen.map.set(ref, whole) }
  tab.read = { doc: tab.doc, text: snap.text }
  return `${await header(tab)}  — it opened what is below${settled ? `, settled: ${settled}` : ''}\n\n${short}`
}

// The page's text, or one region's, as the agent reads it.
async function textOf(tab: Tab, ref?: number): Promise<string> {
  const snap = await snapshot(tab)
  if (ref === undefined) {
    remember(tab, snap.text)
    return snap.text
  }
  const node = findRef(snap.tree, ref)
  if (!node) throw new Error(`[${ref}] is not on the page — run: browser-layer map`)
  return renderText({ block: true, children: [node] }, snap.origin, caps())
}

// A result bigger than one answer belongs in a file the agent's own tools read (grep, jq, a script), not in
// its context: --out writes it whole, and the answer says how much and where.
const saved = (file: string, body: string, what: string) => {
  writeFileSync(file, `${body}\n`)
  return `saved ${file}: ${what}`
}

async function view(tab: Tab, page = 1, text?: string, ref?: number): Promise<string> {
  if (text === undefined) text = await textOf(tab, ref)
  const truncated = text.length > policy['render.maxChars']
  if (truncated) text = text.slice(0, text.lastIndexOf('\n', policy['render.maxChars']))
  const pages = paginate(text, policy['render.pageChars'])
  if (page < 1 || page > pages.length) throw new Error(`page ${page} does not exist; this view has ${pages.length}`)
  const head = `${await header(tab)}${pages.length > 1 ? `  (page ${page} of ${pages.length})` : ''}`
  const more = page < pages.length ? `\n… more below: browser-layer read${ref === undefined ? '' : ` ${ref}`} --page ${page + 1}, or --out <file> for all ${pages.length} pages` : ''
  const cut = truncated && page === pages.length ? '\n… (view ceiling reached; the page is larger than this)' : ''
  return `${head}\n\n${pages[page - 1]}${more}${cut}`
}

// Reading the same page again answers with what changed since the agent last read it: the rest is already
// in its context. Nothing changed is one line; a page that mostly changed, or a new one, reads whole. Only
// a read that fit one answer is remembered: of a longer page the agent has seen just the first part.
async function reread(tab: Tab, full: boolean): Promise<string> {
  const snap = await snapshot(tab)
  remember(tab, snap.text)
  const text = snap.text
  const before = tab.read?.doc === tab.doc && !full ? tab.read.text : undefined
  tab.read = text.length <= policy['render.pageChars'] ? { doc: tab.doc, text } : undefined
  if (before === text) return `${await header(tab)}  — no change since your last read (read --full shows it again)`
  if (before !== undefined) {
    const { removed, added } = diffLines(before.split('\n'), text.split('\n'))
    const lines = [...removed.map(l => `- ${l}`), ...added.map(l => `+ ${l}`)].join('\n')
    if (lines.length < text.length / 2) return `${await header(tab)}  — ${removed.length} line${removed.length === 1 ? '' : 's'} gone, ${added.length} new since your last read (read --full shows it all)\n\n${lines}`
  }
  // Regions already shown in full, unchanged, are one line each, when the rest fits one answer: a page
  // that needs --page N reads whole, so its pages stay the same between calls.
  const now = new Map<number, string>()
  const short = renderText(snap.tree, snap.origin, caps(), { before: full ? new Map() : tab.seen.text, now })
  if (short.length > policy['render.pageChars']) return view(tab, 1, text)
  for (const [ref, whole] of now) { tab.seen.text.set(ref, whole); tab.seen.map.set(ref, whole) }
  return view(tab, 1, short)
}

function need(session: string): Tab {
  const tab = tabs.get(current.get(session) ?? 0)
  if (!tab) throw new Error(`no live tab in session "${session}" — run: browser-layer tab <url>`)
  tab.used = Date.now()
  return tab
}

function own(session: string, id: number): Tab {
  const tab = tabs.get(id)
  if (!tab) throw new Error(`no tab ${id}`)
  if (tab.session !== session) throw new Error(`tab ${id} belongs to session "${tab.session}", not "${session}"`)
  tab.used = Date.now()
  return tab
}

const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago` }
const pageOf = (url: string) => url.split('#')[0]

// After an action the agent already holds the page, so it gets the lines that changed: the complete
// answer to what the action did. A new document is answered with its map, as opening one is.
const contextOf = (text: string) => (/^\[\d+\] dialog/.test(text) ? text.slice(0, text.indexOf('\n') >>> 0) : 'page')

// The outermost collections holding any of the new lines, and the lines each one renders as.
function changedCollections(snap: Awaited<ReturnType<typeof snapshot>>, added: string[]) {
  const fresh = new Set(added)
  const lines = (n: Node) => renderText({ block: true, children: [n] }, snap.origin, caps()).split('\n')
  const moved = (n: Node): Node[] => (n.ref && COLLECTIONS.has(n.role ?? '') && lines(n).some(l => fresh.has(l)) ? [n] : (n.children ?? []).flatMap(moved))
  return { found: moved(snap.tree), lines }
}

async function changes(tab: Tab, settled = ''): Promise<string> {
  const snap = await snapshot(tab)
  const before = tab.shown.get(contextOf(snap.text))
  if (!before || before.doc !== tab.doc) return contextOf(snap.text) === 'page' ? mapView(tab, snap, settled) : openedView(tab, snap, settled)
  const { removed, added } = diffLines(before.text.split('\n'), snap.text.split('\n'))
  const size = [...removed, ...added].reduce((n, l) => n + l.length + 3, 0)
  // Changed lines longer than the page itself: the page was replaced. Like a new view, it is answered
  // with the shorter of its whole text (a small page) and its map (a large one).
  if (size > snap.text.length) {
    if (snap.text.length > renderMap(snap.tree, snap.origin, caps(), policy['render.mapFew']).length) {
      // New records (the next page of a table) leave a map as it was, so what changed is answered as those
      // records, plus any other new lines. Too many to fit one page: the map, naming where they are. A page
      // that changed around its lists too (an app re-rendering as a menu opens) is answered with its map:
      // what opened is listed there with its refs, and regions shown before, unchanged, are one line each.
      const changed = changedCollections(snap, added)
      const found = changed.found.filter(n => records(n, snap.origin, caps()).rows.length)
      const inside = new Set(found.flatMap(changed.lines))
      const outside = added.filter(l => !inside.has(l))
      if (outside.length > policy['render.mapFew']) return mapView(tab, snap, settled)
      const where = found.map(n => `[${n.ref}] ${n.role}`).join(', ')
      // The action opened something (a list of options, a menu, a dialog): that is the answer, and lists
      // that changed around it are named, not given as records.
      if (outside.some(l => / expanded\b/.test(l) || /^\[\d+\] (listbox|menu|dialog|alertdialog|grid|tree)\b/.test(l))) {
        remember(tab, snap.text)
        return `${await header(tab)}  — it opened what is below${where ? `; ${where} changed too (read <ref> shows it)` : ''}${settled ? `, settled: ${settled}` : ''}\n\n${outside.map(l => `+ ${l}`).join('\n')}`
      }
      const body = [...outside.map(l => `+ ${l}`), ...found.map(n => recordsView(n, snap.origin, {}))].join('\n\n')
      if (!found.length || body.length > policy['render.pageChars']) return mapView(tab, snap, settled, where && `new records in ${where} (browser-layer get <ref> reads them)`)
      remember(tab, snap.text)
      return `${await header(tab)}  — new records in ${where}${settled ? `, settled: ${settled}` : ''}\n\n${body}`
    }
    remember(tab, snap.text)
    return `${await header(tab)}  — the whole page changed${settled ? `, settled: ${settled}` : ''}\n\n${snap.text}`
  }
  remember(tab, snap.text)
  // More new lines than one page: each long list among them is one line, and find or read <ref> goes in.
  let shown = added
  let note = ''
  if (size > policy['render.pageChars']) {
    const { found, lines } = changedCollections(snap, added)
    const summary = new Map<string, string>()
    for (const n of found) {
      const line = itemsLine(n, snap.origin, caps(), policy['render.mapFew'])
      if (line) for (const l of lines(n)) summary.set(l, line)
    }
    const seen = new Set<string>()
    shown = added.flatMap(l => {
      const line = summary.get(l)
      return !line ? [l] : seen.has(line) ? [] : (seen.add(line), [line])
    })
    if (seen.size) note = '; a long list is one line: find <text> or read <ref> goes in'
  }
  const head = `tab ${tab.id}  ${tab.page.url()}  — ${removed.length + added.length ? `${removed.length} lines gone, ${added.length} new` : 'no visible change'}${settled ? `, settled: ${settled}` : ''} (full page: browser-layer read${note})`
  return [head, '', ...removed.map(l => `- ${l}`), ...shown.map(l => `+ ${l}`)].join('\n').trimEnd()
}

// A collection as records (TSV): sorted, limited and column-picked as asked, and never more than one page
// in an answer (the column line included); --out writes them all.
function recordsView(node: Node, origin: string, q: Query & { out?: string }): string {
  const all = records(node, origin, { ...caps(), urls: q.urls })
  const out = query(all, q)
  if (q.out) return saved(q.out, toTsv(out), `${out.rows.length} records, ${out.columns.length} columns (TSV)`)
  const asked = out.rows.length
  let size = toTsv({ ...out, rows: [] }).length
  const fits = out.rows.findIndex(r => (size += r.join('\t').length + 1) > policy['render.pageChars'])
  if (fits >= 0) out.rows = out.rows.slice(0, fits)
  const head = `[${node.ref}] ${node.role}: ${all.rows.length} records, ${all.columns.length} columns`
  if (!out.rows.length && asked) return `${head} — too wide for one answer: --cols picks columns, read ${node.ref} reads it as text, --out <file> writes all`
  const what = [q.sort ? `sorted by ${q.sort}${q.desc ? ' descending' : ''}` : '', out.rows.length < all.rows.length ? `first ${out.rows.length}` : ''].filter(Boolean).join(', ')
  const rest = out.rows.length < asked || (q.limit === undefined && out.rows.length < all.rows.length) ? `\n… ${all.rows.length - out.rows.length} more records: --limit, --cols, or --out <file> for all` : ''
  return `${head}${what ? ` (${what})` : ''}\n\n${toTsv(out)}${rest}`
}

// The engine session for a cross-origin frame. Playwright gives such a frame its own session; the frame
// id from its frame tree says which frame the reader asked for.
async function frameSession(tab: Tab, frameId: string, owner: Frame['owner']) {
  const known = tab.frames.get(frameId)
  if (known) return (known.owner = owner), { cdp: known.cdp, scope: frameId }
  for (const f of tab.page.frames()) {
    if (f === tab.page.mainFrame()) continue
    const cdp = await ctx.newCDPSession(f).catch(() => undefined)
    if (!cdp) continue
    const { frameTree } = await cdp.send('Page.getFrameTree')
    if (frameTree.frame.id !== frameId) { await cdp.detach().catch(() => {}); continue }
    await cdp.send('Accessibility.enable')
    tab.frames.set(frameId, { cdp, owner })
    return { cdp, scope: frameId }
  }
  return undefined
}

// A frame's top-left in page coordinates: its iframe's content box, plus that frame's own offset.
async function offsetOf(tab: Tab, scope: string): Promise<[number, number]> {
  const frame = tab.frames.get(scope)
  if (!frame) return [0, 0]
  const cdp = frame.owner.scope ? tab.frames.get(frame.owner.scope)!.cdp : tab.cdp
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: frame.owner.id })
  const [x, y] = await offsetOf(tab, frame.owner.scope)
  return [model.content[0] + x, model.content[1] + y]
}

function targetOf(tab: Tab, ref?: string): Target {
  if (!ref || !/^\d+$/.test(ref)) throw new Error(`expected a ref number like 12, got "${ref ?? ''}"`)
  const at = tab.refs.byRef.get(Number(ref))
  if (!at) throw new Error(`[${ref}] is not on the page — run: browser-layer read`)
  const cdp = at.scope ? tab.frames.get(at.scope)?.cdp : tab.cdp
  if (!cdp) throw new Error(`[${ref}] is in a frame that is gone — run: browser-layer read`)
  return { cdp, page: tab.cdp, id: at.id, offset: () => offsetOf(tab, at.scope) }
}

// The engine's ways of saying the element left the page: apps re-render, replacing what was read.
const GONE = /No node with given id|No node found|Could not find node|detached from document/i

// A ref the page re-rendered, or that a new page has again, is the same element by its identity (reader
// Refs): the page is read once more and the action goes to it, instead of failing for the agent to look
// again. Only a ref the page no longer has fails, with the same advice.
async function act(tab: Tab, ref: string | undefined, fn: (t: Target) => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(targetOf(tab, ref))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const gone = GONE.test(msg) || /is not on the page —/.test(msg)
      if (gone && attempt === 0 && /^\d+$/.test(ref ?? '')) { await snapshot(tab); continue }
      if (/is not on the page —|is in a frame that is gone|expected a ref number/.test(msg)) throw err
      if (GONE.test(msg)) throw new Error(`[${ref}] is not on the page any more (it changed) — run: browser-layer map`)
      // A number is a ref, so "15" meant as a day or a page number acts on ref 15; when that one cannot be
      // reached, the controls named with that number (a day "March 15th", a page "15") are listed instead.
      const number = new RegExp(`(^|[^\\d.,])${ref}(st|nd|rd|th)?($|[^\\d.,])`)
      const shown = /^\d+$/.test(ref ?? '') ? withRefs((await snapshot(tab)).tree).filter(n => String(n.ref) !== ref && number.test(n.name ?? '')) : []
      const meant = shown.length ? `; controls named with ${ref}: ${shown.slice(0, policy['render.mapFew']).map(n => `[${n.ref}] ${n.role} "${n.name}"`).join(' · ')}` : ''
      throw new Error(`cannot act on [${ref}]: ${msg}${/its controls: /.test(msg) ? ' (click one by name, then this again)' : ''}${meant}`)
    }
  }
}

function withUrl(url: string) {
  return /^[a-z]+:\/\//i.test(url) || url.startsWith('about:') ? url : `https://${url}`
}

// Every page the agent can use, whether it opened it or the site did (a pop-up), is set up here.
// One ref counter for every tab: a ref names one element in the whole browser (reader Refs).
const refCounter = { next: 1 }

// Decoration is not loaded unless a site was allowed to show it.
const skipDecoration = (r: Route) => (DECORATION.has(r.request().resourceType()) && !pictured.has(siteOf(r.request())) ? r.abort() : r.continue())

async function setupTab(session: string, page: Page): Promise<Tab> {
  // Attached, these reach this tab only; a launched browser has them for all its tabs (see main).
  if (ATTACH) {
    await page.route('**/*', skipDecoration)
    await page.addInitScript(PAGE_HOOKS)
  }
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Accessibility.enable')
  await cdp.send('Animation.enable')
  await cdp.send('Animation.setPlaybackRate', { playbackRate: MOTION_RATE })
  const tab: Tab = { id: nextId++, session, page, cdp, refs: newRefs(refCounter), used: Date.now(), doc: 0, shown: new Map(), seen: { map: new Map(), text: new Map() }, pending: new Map(), standing: new Set(), net: [], netId: 0, frames: new Map(), opened: [], downloads: [], saving: [] }
  // A new document can reuse node ids, so old refs are dropped; numbering continues, never reused.
  // Only a new document invalidates node ids. pushState and hash changes (navigatedWithinDocument)
  // keep the same nodes, so refs and the agent's view of the page stay valid.
  await cdp.send('Page.enable')
  cdp.on('Page.frameNavigated', ({ frame }) => {
    if (frame.parentId) return
    tab.doc++
    tab.refs.byNode.clear()
    tab.refs.byRef.clear()
    for (const f of tab.frames.values()) void f.cdp.detach().catch(() => {})
    tab.frames.clear()
  })
  // The status the page itself came with; a refusal (403, 429) is told apart from a page that merely says no.
  page.on('response', r => {
    if (!r.request().isNavigationRequest() || r.frame() !== page.mainFrame()) return
    tab.status = r.status()
    tab.retryAfter = r.headers()['retry-after']
  })
  // Dialogs wait for the agent: an unanswered confirm() is a decision, not something to auto-dismiss.
  page.on('dialog', d => { tab.dialog = d })
  page.on('download', d => {
    tab.saving.push((async () => {
      const dir = join(home(), 'downloads')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${tab.id}-${Date.now()}-${d.suggestedFilename()}`)
      await d.saveAs(file)
      tab.downloads.push({ file, size: statSync(file).size, url: d.url() })
    })().catch(() => {}))
  })
  tabs.set(tab.id, tab)
  track(tab)
  current.set(session, tab.id)
  return tab
}

// Navigations return once the response begins; settle then waits for the document (load.domMs at most).
const COMMIT = () => ({ waitUntil: 'commit' as const, timeout: policy['load.timeoutMs'] })

async function newTab(session: string, url: string): Promise<Tab> {
  const tab = await setupTab(session, await ctx.newPage())
  await tab.page.goto(withUrl(url), COMMIT())
  return tab
}

// tab <url>: a page already open in this session is switched to, as a browser's "switch to tab" does (no
// second copy to load and keep track of); any other opens in a new tab, which becomes current.
async function openTab(session: string, url: string): Promise<string> {
  const open = [...tabs.values()].find(t => t.session === session && pageOf(t.page.url()) === pageOf(new URL(withUrl(url)).href))
  if (open) {
    open.used = Date.now()
    current.set(session, open.id)
    return mapView(open, undefined, '', 'already open here, so this is that tab (reload loads it again)', true)
  }
  const tab = await newTab(session, url)
  const note = await arrive(tab)
  return mapView(tab, undefined, unusual(await settle(tab)), note)
}

// What an action did: a dialog waiting, a pop-up that opened (it becomes current, answered with its
// map), downloads that finished, then the changed lines.
async function answer(tab: Tab): Promise<string> {
  const settled = await settle(tab)
  if (tab.dialog) {
    const d = tab.dialog
    return `tab ${tab.id}  a ${d.type()} dialog is open: "${d.message()}"${d.type() === 'prompt' ? ` (default "${d.defaultValue()}")` : ''}\nanswer: browser-layer dialog accept [text] | browser-layer dialog dismiss`
  }
  await Promise.race([Promise.all(tab.saving), sleep(policy['load.timeoutMs'])])
  tab.saving = []
  const notes = tab.downloads.splice(0).map(d => `downloaded ${d.file} (${d.size} bytes) from ${d.url}`)
  const popup = tabs.get(tab.opened.splice(0).pop() ?? 0)
  if (popup) {
    await settle(popup)
    return [...notes, `opened tab ${popup.id} (a pop-up of tab ${tab.id}); it is now current`, '', await mapView(popup)].join('\n')
  }
  const body = await changes(tab, settled)
  return notes.length ? `${notes.join('\n')}\n${body}` : body
}

// Input that opens alert/confirm/prompt does not return until the dialog is closed, so the action ends
// when a dialog opens; the agent answers it with the next command.
async function untilDialog(tab: Tab, work: Promise<unknown>) {
  let opened = () => {}
  const dialog = new Promise<void>(r => { opened = r; tab.page.once('dialog', opened) })
  work.catch(() => {})
  try { await Promise.race([work, dialog]) } finally { tab.page.off('dialog', opened) }
}

const pointerAt = (tab: Tab, ref: string | undefined, how: Pointer) => untilDialog(tab, act(tab, ref, t => pointer(t, policy['actions.timeoutMs'], how)))

// explore (DESIGN §4.6): what the page's declared menus and pop-ups hold. Only declared triggers are
// clicked, what appeared is read, and Escape closes it again; plain actions are never clicked.
type Explored = { name: string; items: { name: string; sub?: Explored }[] }
// What a menu holds is its controls, not containers (the menu itself, a list, a region, a canvas).
const isItem = (n: Node) => !COLLECTIONS.has(n.role ?? '') && !LANDMARKS.has(n.role ?? '') && n.role !== 'dialog' && n.role !== 'canvas'
const refsNow = async (tab: Tab) => new Set(withRefs((await snapshot(tab)).tree).map(n => n.ref))

async function openRead(tab: Tab, trigger: Node, depth: number, budget: { opens: number }): Promise<Explored> {
  const before = await refsNow(tab)
  const doc = tab.doc
  budget.opens--
  await pointerAt(tab, String(trigger.ref), {})
  await settle(tab, policy['explore.waitMs'])
  if (tab.doc !== doc || tab.dialog) throw new Error(`opening "${trigger.name}" ${tab.dialog ? 'opened a dialog' : 'left the page'}; explore stopped there`)
  const items = withRefs((await snapshot(tab)).tree).filter(n => !before.has(n.ref) && isItem(n))
  const out: Explored = { name: trigger.name || trigger.role!, items: [] }
  for (const item of items) {
    const sub = depth > 1 && budget.opens > 0 && isTrigger(item) && (await refsNow(tab)).has(item.ref)
      ? await openRead(tab, item, depth - 1, budget) : undefined
    out.items.push({ name: item.name || item.role!, sub })
  }
  // Escape is the standard way to close a menu or pop-up; pressed until what this opened is gone.
  for (let k = 0; k < 3; k++) {
    await tab.page.keyboard.press('Escape')
    await settle(tab, policy['explore.waitMs'])
    const now = await refsNow(tab)
    if (!items.some(i => now.has(i.ref))) break
  }
  return out
}

// A control can be named instead of numbered: the best match by accessible name (exact, then prefix, then
// contained). Several equally good matches are an error that lists them; guessing would act on the wrong one.
// A number is a ref while it is one in this tab; otherwise it may be a control's whole name (a year, a size,
// a page number), never part of one.
const fit = (name: string | undefined, want: string) => {
  const n = (name ?? '').toLowerCase()
  return n === want ? 0 : n.startsWith(want) ? 1 : n.includes(want) ? 2 : 3
}
const ACTIONS = new Set(['click', 'dblclick', 'rightclick', 'hover', 'type', 'pick', 'upload', 'check', 'uncheck', 'submit', 'drag'])

async function refNamed(tab: Tab, target: string | undefined): Promise<string | undefined> {
  if (!target || tab.refs.byRef.has(Number(target))) return target
  const want = target.trim().toLowerCase()
  const number = /^\d+$/.test(want)
  const hits = withRefs((await snapshot(tab)).tree).filter(n => isItem(n) && fit(n.name, want) < (number ? 1 : 3))
  if (number && !hits.length) return target
  const best = hits.filter(n => fit(n.name, want) === Math.min(...hits.map(h => fit(h.name, want))))
  if (best.length === 1) return String(best[0].ref)
  if (!best.length) throw new Error(`nothing is named "${target}" — run: browser-layer map`)
  throw new Error(`${best.length} controls are named "${target}"; use a ref: ${best.slice(0, policy['render.mapFew']).map(n => `[${n.ref}] ${n.role} "${n.name}"`).join(' · ')}`)
}

async function run(c: Command): Promise<string> {
  beginCommand()
  if (ACTIONS.has(c.cmd)) {
    const tab = need(c.session)
    c.ref = await refNamed(tab, c.ref)
    c.to = await refNamed(tab, c.to)
  }
  switch (c.cmd) {
    case 'tab':
      return openTab(c.session, c.url ?? 'about:blank')
    case 'go': {
      const tab = need(c.session)
      // A page can ask before it is left (beforeunload): that dialog waits for the agent like any other.
      await untilDialog(tab, tab.page.goto(withUrl(c.url!), COMMIT()))
      if (tab.dialog) return answer(tab)
      const note = await arrive(tab)
      return mapView(tab, undefined, unusual(await settle(tab)), note)
    }
    case 'back':
    case 'forward':
    case 'reload': {
      const tab = need(c.session)
      await untilDialog(tab, c.cmd === 'back' ? tab.page.goBack(COMMIT()) : c.cmd === 'forward' ? tab.page.goForward(COMMIT()) : tab.page.reload(COMMIT()))
      if (tab.dialog) return answer(tab)
      const note = await arrive(tab)
      return mapView(tab, undefined, unusual(await settle(tab)), note)
    }
    case 'steps': {
      // Several commands in one call, run in order as if sent one by one. A read answers in full, an action
      // in its first line, the last step in full: what the agent planned ahead needs no answer of its own.
      // The first error, dialog or block stops the rest, and the answer ends with the page as it is then.
      const list = c.steps ?? []
      const lines: string[] = []
      for (const [k, s] of list.entries()) {
        s.session = c.session
        const at = `${k + 1}. ${s.raw ?? s.cmd}`
        let text: string
        try {
          text = await limited(s)
        } catch (err) {
          lines.push(`${at}  → error: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
          const tab = tabs.get(current.get(c.session) ?? 0)
          lines.push(`stopped at step ${k + 1} of ${list.length}${tab ? '; the page now:' : ''}`)
          if (tab) lines.push('', await changes(tab))
          return lines.join('\n')
        }
        const stop = / dialog is open: |\nblocked: /.test(text) && k < list.length - 1
        lines.push(k === list.length - 1 || stop || READS.has(s.cmd) || s.cmd === 'eval' ? `${at}\n${text}` : `${at}  → ${text.split('\n')[0]}`)
        if (stop) return [...lines, `stopped at step ${k + 1} of ${list.length}: answer it first`].join('\n')
      }
      return lines.join('\n')
    }
    case 'tabs': {
      // The session's activity map: its tabs, most recently used first.
      const mine = [...tabs.values()].filter(t => t.session === c.session).sort((a, b) => b.used - a.used)
      if (!mine.length) return `no live tabs in session "${c.session}"`
      return (await Promise.all(mine.map(async t =>
        `${t.id === current.get(c.session) ? '*' : ' '} ${t.id}  ${t.page.url()}  "${await t.page.title().catch(() => '')}"  used ${ago(t.used)}`))).join('\n')
    }
    case 'use': {
      current.set(c.session, own(c.session, c.id!).id)
      return mapView(need(c.session), undefined, '', '', true)
    }
    case 'map':
      return mapView(need(c.session), undefined, '', '', true)
    case 'get': {
      const tab = need(c.session)
      const { tree, origin } = await snapshot(tab)
      const node = findRef(tree, Number(c.ref))
      if (!node) throw new Error(`[${c.ref}] is not on the page — run: browser-layer map`)
      if (!records(node, origin, caps()).rows.length) throw new Error(`[${c.ref}] has no rows; get works on the lists and tables the map shows`)
      return `${await header(tab)}  — ${recordsView(node, origin, c)}`
    }
    case 'read': {
      const ref = c.ref === undefined ? undefined : Number(c.ref)
      if (!c.out && (ref !== undefined || c.page)) return view(need(c.session), c.page ?? 1, undefined, ref)
      if (!c.out) return reread(need(c.session), !!c.full)
      const text = await textOf(need(c.session), ref)
      return saved(c.out, text, `${text.split('\n').length} lines, ${text.length} chars`)
    }
    case 'click':
    case 'dblclick':
    case 'rightclick':
    case 'hover': {
      const tab = need(c.session)
      await pointerAt(tab, c.ref, { clicks: c.cmd === 'dblclick' ? 2 : 1, button: c.cmd === 'rightclick' ? 'right' : 'left', move: c.cmd === 'hover' })
      return answer(tab)
    }
    case 'type': {
      const tab = need(c.session)
      // --keys sends one key event per character, for fields that listen to keys rather than input.
      let held: string | null = null
      await act(tab, c.ref, async t => {
        await fill(t, c.keys ? '' : c.text ?? '')
        if (c.keys) await tab.page.keyboard.type(c.text ?? '')
        held = await heldBy(t).catch(() => null)
      })
      // What did not take is said in the same answer, so the agent does not look again to find out: a
      // field that changed what was typed (a mask, a limit), and an Enter that did nothing on the page.
      const words = (s: string) => s.replace(/\s+/g, ' ').trim()
      const notes = held !== null && words(held) !== words(c.text ?? '') ? [`note: [${c.ref}] holds ${JSON.stringify(words(held).slice(0, policy['render.nameChars']))}, not what was typed`] : []
      if (!c.enter) return [await answer(tab), ...notes].join('\n')
      const before = { url: tab.page.url(), doc: tab.doc, text: await tab.page.evaluate('window.__alText?.()').catch(() => -1) }
      await untilDialog(tab, tab.page.keyboard.press('Enter'))
      const out = await answer(tab)
      if (!tab.dialog && tab.doc === before.doc && tab.page.url() === before.url && await tab.page.evaluate('window.__alText?.()').catch(() => -2) === before.text)
        notes.push('note: Enter changed nothing on the page; the form may need its own button (click it by name)')
      return [out, ...notes].join('\n')
    }
    case 'check':
    case 'uncheck': {
      const tab = need(c.session)
      const want = c.cmd === 'check'
      // Only a box in the other state is clicked, so check and uncheck can be repeated safely.
      if (await isChecked(targetOf(tab, c.ref)) !== want) await pointerAt(tab, c.ref, {})
      const out = await answer(tab)
      return (await isChecked(targetOf(tab, c.ref))) === want ? out : `${out}\nnote: [${c.ref}] is still ${want ? 'unchecked' : 'checked'}`
    }
    case 'submit': {
      const tab = need(c.session)
      await untilDialog(tab, act(tab, c.ref, submit))
      return answer(tab)
    }
    case 'drag': {
      const tab = need(c.session)
      const to = targetOf(tab, c.to)
      await untilDialog(tab, act(tab, c.ref, from => drag(from, to, policy['actions.timeoutMs'])))
      return answer(tab)
    }
    case 'find': {
      const tab = need(c.session)
      const want = (c.text ?? '').toLowerCase()
      if (!want) throw new Error('usage: browser-layer find <text>')
      const hits = (await snapshot(tab)).text.split('\n').filter(l => l.toLowerCase().includes(want))
      if (!hits.length) return `"${c.text}" is not on the page`
      if (c.out) return saved(c.out, hits.join('\n'), `${hits.length} lines with "${c.text}"`)
      const per = policy['data.rows']
      const page = c.page ?? 1
      const from = (page - 1) * per
      if (from >= hits.length) throw new Error(`page ${page} does not exist; the matches fill ${Math.ceil(hits.length / per)}`)
      const shown = hits.slice(from, from + per)
      const more = from + per < hits.length ? `\n… more: browser-layer find ${c.text} --page ${page + 1}, or --out <file> for all ${hits.length}` : ''
      return `${hits.length} lines with "${c.text}"${hits.length > per ? ` (${from + 1}–${from + shown.length})` : ''}\n\n${shown.join('\n')}${more}`
    }
    case 'cookies': {
      // Cookie values are credentials, so they are never shown; names, sites and expiry are.
      // Attached, the browser holds a person's every site: only the current page's is the agent's to see or clear.
      const site = ATTACH ? new URL(need(c.session).page.url()).hostname : c.url
      if (c.dir === 'clear') {
        await ctx.clearCookies(site ? { domain: site } : undefined)
        return `cleared cookies${site ? ` for ${site}` : ''}`
      }
      const list = (await ctx.cookies()).filter(k => !site || k.domain.replace(/^\./, '').endsWith(site))
      if (!list.length) return 'no cookies'
      return list.map(k => `${k.domain}  ${k.name}  ${k.path}  ${k.expires > 0 ? `until ${new Date(k.expires * 1000).toISOString().slice(0, 10)}` : 'session'}${k.httpOnly ? '  httpOnly' : ''}${k.secure ? '  secure' : ''}`).join('\n')
    }
    case 'storage': {
      const tab = need(c.session)
      if (c.dir !== 'local' && c.dir !== 'session') throw new Error('usage: browser-layer storage local|session [clear]')
      const area = `${c.dir}Storage`
      if (c.text === 'clear') {
        await tab.page.evaluate(`${area}.clear()`)
        return `cleared ${area} for ${new URL(tab.page.url()).origin}`
      }
      const entries = await tab.page.evaluate(`Object.entries(${area})`) as [string, string][]
      if (!entries.length) return `${area} is empty for ${new URL(tab.page.url()).origin}`
      return entries.map(([k, v]) => `${k} = ${v.length > policy['render.nameChars'] ? `${v.slice(0, policy['render.nameChars'] - 1)}…` : v}`).join('\n')
    }
    case 'pick': {
      const tab = need(c.session)
      try {
        await act(tab, c.ref, t => pick(t, c.text ?? ''))
        return answer(tab)
      } catch (err) {
        if (!/not a <select>/.test(String(err))) throw err
      }
      // A custom dropdown (an ARIA combobox or listbox): opened and its option clicked by name, as a person
      // picks one. One already open is not clicked shut. An option that is not there closes it again (Escape)
      // and lists what it offers.
      const listed = async () => {
        const tree = (await snapshot(tab)).tree
        return { open: findRef(tree, Number(c.ref))?.states?.includes('expanded'), options: withRefs(tree).filter(n => n.role === 'option' || n.role === 'menuitemradio' || n.role === 'menuitem') }
      }
      let { open, options } = await listed()
      if (!open || !options.length) {
        await pointerAt(tab, c.ref, {})
        await settle(tab, policy['explore.waitMs'])
        options = (await listed()).options
      }
      const want = (c.text ?? '').trim().toLowerCase()
      const best = options.filter(n => fit(n.name, want) < 3).sort((a, b) => fit(a.name, want) - fit(b.name, want))[0]
      if (!best) {
        await tab.page.keyboard.press('Escape')
        throw new Error(`no option "${c.text}"; options: ${options.slice(0, policy['render.mapFew']).map(o => o.name).join(' | ') || '(none appeared when it opened)'}`)
      }
      await pointerAt(tab, String(best.ref), {})
      return answer(tab)
    }
    case 'press': {
      const tab = need(c.session)
      await untilDialog(tab, tab.page.keyboard.press(c.key!))
      return answer(tab)
    }
    case 'upload': {
      const tab = need(c.session)
      const missing = (c.files ?? []).filter(f => !existsSync(f))
      if (!c.files?.length || missing.length) throw new Error(missing.length ? `no such file: ${missing.join(', ')}` : 'usage: browser-layer upload <ref> <file...>')
      // A file input takes the files directly; any other control is clicked and its file chooser answered.
      await act(tab, c.ref, async t => {
        if (await isFileInput(t)) return setFiles(t, c.files!)
        const chooser = tab.page.waitForEvent('filechooser', { timeout: policy['actions.timeoutMs'] })
        await pointer(t, policy['actions.timeoutMs'])
        await (await chooser).setFiles(c.files!)
      })
      return answer(tab)
    }
    case 'scroll': {
      const tab = need(c.session)
      const dir = c.dir ?? 'down'
      const vp = tab.page.viewportSize() ?? { width: policy['viewport.width'], height: policy['viewport.height'] }
      const t = c.ref ? targetOf(tab, c.ref) : undefined
      if (dir === 'down' || dir === 'up') await wheel(t, tab.cdp, (dir === 'down' ? 1 : -1) * vp.height * 0.8, [vp.width, vp.height], policy['actions.timeoutMs'])
      else if (dir === 'top' || dir === 'bottom') {
        const to = `function () { const e = this === window ? document.scrollingElement : this; e.scrollTo(0, ${dir === 'top' ? 0 : 'e.scrollHeight'}) }`
        if (t) await call(t, to)
        else await tab.page.evaluate(`(${to}).call(window)`)
      } else throw new Error(`scroll takes down, up, top or bottom, not "${dir}"`)
      return answer(tab)
    }
    case 'wait': {
      const tab = need(c.session)
      if (!c.text) throw new Error('usage: browser-layer wait [--gone] <text>')
      const end = Date.now() + policy['wait.timeoutMs']
      while (((await snapshot(tab)).text.includes(c.text)) === !!c.gone) {
        if (Date.now() > end) throw new Error(`"${c.text}" ${c.gone ? 'is still on the page' : 'did not appear'} after ${policy['wait.timeoutMs']} ms`)
        await sleep(250)
      }
      return answer(tab)
    }
    case 'dialog': {
      const tab = need(c.session)
      const d = tab.dialog
      if (!d) throw new Error('no dialog is open')
      tab.dialog = undefined
      if (c.dir === 'accept') await d.accept(c.text)
      else if (c.dir === 'dismiss') await d.dismiss()
      else throw new Error('usage: browser-layer dialog accept [text] | dismiss')
      return answer(tab)
    }
    case 'explore': {
      const tab = need(c.session)
      const { tree } = await snapshot(tab)
      const scope = c.ref ? findRef(tree, Number(c.ref)) : tree
      if (!scope) throw new Error(`[${c.ref}] is not on the page — run: browser-layer map`)
      const triggers = (isTrigger(scope) ? [scope] : withRefs(scope).filter(isTrigger))
      if (!triggers.length) return 'nothing here declares a menu or pop-up (aria-haspopup / aria-expanded)'
      const budget = { opens: policy['explore.max'] }
      const lines: string[] = []
      const print = (e: Explored, path: string) => {
        lines.push(`${path} ▸ ${e.items.map(i => (i.sub ? `${i.name} ▸` : i.name)).join(' · ') || '(nothing appeared)'}`)
        for (const i of e.items) if (i.sub) print(i.sub, `${path} > ${i.name}`)
      }
      for (const t of triggers) {
        if (budget.opens <= 0) { lines.push(`… stopped after ${policy['explore.max']} opens (explore <ref> looks at one)`); break }
        const e = await openRead(tab, t, policy['explore.depth'], budget)
        print(e, `[${t.ref}] ${e.name}`)
      }
      return `${await header(tab)}  — ${triggers.length} declared menus and pop-ups, each opened, read and closed\n\n${lines.join('\n')}\n\n(menu "A > B > C" runs one by name)`
    }
    case 'menu': {
      // A path of names: each step is clicked, then looked for among what the previous step opened.
      const tab = need(c.session)
      const steps = (c.text ?? '').split('>').map(s => s.trim().toLowerCase()).filter(Boolean)
      if (!steps.length) throw new Error('usage: browser-layer menu "File > Download > CSV"')
      for (const [k, step] of steps.entries()) {
        // Best name match first; among equals, the newest control (the menu just opened) after step one.
        const hits = withRefs((await snapshot(tab)).tree)
          .filter(n => isItem(n) && !n.states?.includes('disabled') && fit(n.name, step) < 3)
          .sort((a, b) => fit(a.name, step) - fit(b.name, step) || (k ? b.ref! - a.ref! : a.ref! - b.ref!))
        if (!hits.length) throw new Error(`nothing named "${step}"${k ? ` after "${steps.slice(0, k).join(' > ')}"` : ''} — explore lists what menus hold`)
        await pointerAt(tab, String(hits[0].ref), {})
        if (k < steps.length - 1) await settle(tab, policy['explore.waitMs'])
      }
      return answer(tab)
    }
    case 'allow': {
      // Permissions are denied unless the agent grants them, per site: `allow geolocation 19.07,72.87`.
      const tab = need(c.session)
      const perms = (c.text ?? '').split(',').filter(Boolean)
      if (!perms.length) throw new Error('usage: browser-layer allow <permission>[,permission] [latitude,longitude]')
      const origin = new URL(tab.page.url()).origin
      // `images` is not a browser permission: it lets the site's pages load their decoration (DECORATION),
      // for content that is only pictures (a scanned book, a map, a video) or a page that will not work without.
      if (perms.includes('images')) pictured.add(origin)
      const granted = perms.filter(p => p !== 'images')
      if (ATTACH && (granted.length || c.dir)) throw new Error("allow cannot change a person's own browser; only allow images")
      if (granted.length) await ctx.grantPermissions(granted, { origin })
      if (c.dir) {
        const [latitude, longitude] = c.dir.split(',').map(Number)
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error(`expected latitude,longitude, got "${c.dir}"`)
        await ctx.setGeolocation({ latitude, longitude })
      }
      return `allowed ${perms.join(', ')} for ${origin}${c.dir ? ` at ${c.dir}` : ''}${perms.includes('images') ? ' (reload to load them)' : ''}`
    }
    case 'screenshot': {
      // A picture for a person (or a judge): the agent reads the page as text. Images and fonts are
      // never loaded (DECORATION), so it shows the page without them. A ref pictures just its box, in
      // page coordinates so a region taller than the window comes out whole.
      const tab = need(c.session)
      let clip: { x: number; y: number; width: number; height: number } | undefined
      if (c.ref !== undefined) await act(tab, c.ref, async t => {
        const { model } = await t.cdp.send('DOM.getBoxModel', { backendNodeId: t.id })
        const [left, top, right, , , bottom] = model.border
        if (right <= left || bottom <= top) throw new Error('it has no box on the page (hidden or not rendered)')
        const [ox, oy] = await t.offset()
        const [sx, sy] = (await tab.page.evaluate('[scrollX, scrollY]')) as [number, number]
        clip = { x: left + ox + sx, y: top + oy + sy, width: right - left, height: bottom - top }
      })
      const height = c.full && !clip ? (await tab.page.evaluate('document.documentElement.scrollHeight')) as number : 0
      if (height > SHOT_MAX_PX) clip = { x: 0, y: 0, width: policy['viewport.width'], height: SHOT_MAX_PX }
      await tab.page.screenshot({ path: c.files![0], fullPage: !!c.full || !!clip, clip })
      return `saved ${c.files![0]}${height > SHOT_MAX_PX ? ` (the first ${SHOT_MAX_PX} px of ${height})` : ''}`
    }
    case 'eval': {
      const tab = need(c.session)
      const { result, exceptionDetails } = await tab.cdp.send('Runtime.evaluate', { expression: c.text ?? '', awaitPromise: true, returnByValue: true, replMode: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text)
      return result.value === undefined ? String(result.description ?? 'undefined') : JSON.stringify(result.value)
    }
    case 'net': {
      const tab = need(c.session)
      if (c.id !== undefined) {
        // One request in full: what an agent needs to call the same API itself.
        const r = tab.net.find(n => n.id === c.id)
        if (!r) throw new Error(`no request #${c.id} — run: browser-layer net`)
        const res = await r.request.response().catch(() => null)
        const body = r.body ?? await res?.body().catch(() => undefined)
        // The whole answer goes to a file, where the agent's own tools (jq, a script) read it.
        if (c.files) {
          if (!body) throw new Error(`#${r.id} has no body the browser still holds`)
          writeFileSync(c.files[0], body)
          return `saved ${c.files[0]} (${body.length} bytes, ${r.type || 'unknown type'})`
        }
        const text = body?.toString('utf8')
        const shown = text && printable(text, policy['network.bodyChars'])!
        return [`#${r.id} ${r.method} ${r.url}`, 'request headers:', headerLines(await r.request.allHeaders()),
          ...(r.request.postData() ? ['request body:', printable(r.request.postData(), policy['network.bodyChars'])!] : []),
          `response: ${r.status} ${r.type}`, headerLines((await res?.allHeaders()) ?? {}),
          ...(shown ? ['response body:', shown.replace(/ more chars\)$/, ` more chars: browser-layer net save ${r.id} <file> writes it all)`)]
            : r.kind === 'document' ? [] : ['response body: no longer held by the browser']),
        ].join('\n')
      }
      const list = c.all ? tab.net : tab.net.filter(r => (r.kind !== 'document' || r.method !== 'GET') && !noise(r))
      if (!list.length) return 'no requests yet'
      return list.slice(-40).map(r => {
        const u = new URL(r.url)
        const where = u.origin === new URL(tab.page.url()).origin ? `${u.pathname}${u.search}` : `${u.host}${u.pathname}${u.search}`
        return `#${String(r.id).padEnd(4)} ${r.method.padEnd(6)} ${String(r.status).padEnd(4)} ${where.slice(0, 120)}  ${r.type}${r.post ? `\n      body: ${r.post}` : ''}`
      }).join('\n') + '\n(net show <#> for headers and bodies)'
    }
    case 'close': {
      const tab = c.id ? own(c.session, c.id) : need(c.session)
      await tab.page.close()
      const now = current.get(c.session)
      return now ? `closed tab ${tab.id}; now on tab ${now}` : `closed tab ${tab.id}; no live tabs left in session "${c.session}"`
    }
    case 'state':
      return JSON.stringify([...tabs.values()].map(t => ({ session: t.session, url: t.page.url(), current: current.get(t.session) === t.id })))
    case 'ping':
      return 'ok'
    default:
      throw new Error(`unknown command ${c.cmd}`)
  }
}

// A page whose renderer stopped answering (a script that never returns) would hold every later command
// behind it; the command fails instead, and other tabs carry on. Reading the page takes seconds at most, so
// a read gives up sooner than a command that loads a page. Each of a call's steps has its own limit.
function limited(c: Command): Promise<string> {
  const limit = policy[READS.has(c.cmd) ? 'read.timeoutMs' : 'command.timeoutMs']
  return Promise.race([run(c), new Promise<never>((_, fail) => setTimeout(() => fail(new Error(
    `the page did not answer in ${limit / 1000} s; it may be stuck: browser-layer close it and open it again`)), limit))])
}

// A Unix socket is a file left behind on exit; a Windows named pipe goes away with its server.
const dropSocket = () => { if (process.platform !== 'win32') rmSync(socketPath(), { force: true }) }

// Attached, only the tabs the daemon opened close, and the person's Chrome keeps running.
async function release() {
  if (!browser) return ctx.close().catch(() => {})
  await Promise.all([...tabs.values()].map(t => t.page.close().catch(() => {})))
  await browser.close().catch(() => {})
}

async function main() {
  // A second daemon would steal the socket and orphan the first one's tabs.
  if (await ping()) {
    console.log('another daemon already answers on the socket; exiting')
    process.exit(0)
  }
  policy = loadPolicy()
  if (ATTACH) {
    // Chrome asks the person to click Allow on every new connection, and a connection that gives up while the popup is
    // open would only raise another: there is no deadline, and a daemon that is turned down exits.
    console.log('connecting; Chrome may be asking the person to allow remote debugging')
    browser = await chromium.connectOverCDP(ATTACH, { timeout: 0 }).catch(err => {
      console.error(`cannot attach to ${ATTACH}: ${err.message.split('\n')[0]}`)
      return process.exit(1)
    })
    ctx = browser.contexts()[0]
    rmSync(pidPath(), { force: true }) // connected: the pid file's job, telling the CLI a daemon is still waiting for Allow, is over
  } else {
    const found = await findBrowser()
    if ('error' in found) {
      console.error(found.error)
      process.exit(1)
    }
    ctx = await chromium.launchPersistentContext(join(home(), 'profile'), {
      executablePath: found.path,
      // Headless always, except a browser `browser-layer show` started for a person to watch. Nothing is
      // remembered: the next browser after this one is headless again.
      headless: process.env.BROWSER_LAYER_VISIBLE !== '1',
      viewport: { width: policy['viewport.width'], height: policy['viewport.height'] },
      reducedMotion: 'reduce',
    })
    await ctx.route('**/*', skipDecoration)
    await ctx.addInitScript(PAGE_HOOKS)
    for (const p of ctx.pages()) await p.close()
  }
  // A page a site opens (window.open, target=_blank, an OAuth pop-up) joins its opener's session.
  ctx.on('page', async page => {
    const opener = await page.opener()
    const parent = [...tabs.values()].find(t => t.page === opener)
    if (!parent) return
    const tab = await setupTab(parent.session, page)
    parent.opened.push(tab.id)
  })

  let queue = Promise.resolve()
  let idle: NodeJS.Timeout
  // `stop` answers only after Chrome has exited, so a caller can safely delete the profile next.
  let stopping = false
  const shutdown = async (reply?: (text: string) => void) => {
    stopping = true
    server.close()
    await release()
    dropSocket()
    if (reply) reply('stopped')
    else process.exit(0)
  }
  // Attached, the one connection (and the one popup it cost the person) stays until Chrome goes or `stop`.
  const touch = () => { clearTimeout(idle); if (!ATTACH) idle = setTimeout(() => void shutdown(), policy['daemon.idleMs']) }
  // The browser went away on its own (a person closed the visible window, Chrome crashed): a daemon
  // without a browser can only fail, so it exits and the next command starts a fresh one.
  ctx.on('close', () => {
    if (stopping) return
    dropSocket()
    process.exit(0)
  })

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      touch()
      const c = JSON.parse(body || '{}') as Command
      if (c.cmd === 'stop') {
        void shutdown(text => res.end(JSON.stringify({ ok: true, text }), () => process.exit(0)))
        return
      }
      // The CLI was updated under a running daemon: this one's code is old, so it exits and the CLI starts
      // its own. (A ping carries no version.)
      if (c.version && c.version !== VERSION) {
        void shutdown(() => res.end(JSON.stringify({ ok: false, stale: true }), () => process.exit(0)))
        return
      }
      // One command at a time: two agents clicking into the same tab at once would race.
      queue = queue.then(async () => {
        try {
          c.session ||= 'default'
          await pullCookies()
          const text = await (c.cmd === 'steps' ? run(c) : limited(c))
          await syncCookies().catch(() => {})
          res.end(JSON.stringify({ ok: true, text }))
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }))
        }
      })
    })
  })
  dropSocket()
  server.on('error', async err => {
    console.error(`cannot listen on ${socketPath()}: ${err.message}`)
    await release()
    process.exit(1)
  })
  server.listen(socketPath(), () => {
    // A named pipe (Windows) has no file mode; its default ACL lets only this user, SYSTEM and
    // administrators write to it, so no other account can send it commands.
    if (process.platform !== 'win32') chmodSync(socketPath(), 0o600)
    touch()
    console.log(`browser-layer daemon on ${socketPath()}`)
  })
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
