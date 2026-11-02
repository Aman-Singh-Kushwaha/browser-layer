import { cellsOf, COLLECTIONS, isHeaderRow, isTrigger, LANDMARKS, rowsOf, SPACE, withRefs, type Node } from './reader.js'

// Text for the agent: blocks start lines, rows read as one line with ' · ' between their parts,
// controls inline as [ref] role "name". All shortening happens here, never in the reader.
const SEP = '\u0001'

// urls (get --urls): links give their full address and pictures theirs; otherwise both are left out.
export type Caps = { nameChars: number; labelChars: number; urls?: boolean }
// The full text of each region the agent has already been shown (before), by ref; a region shown again
// exactly as it was answers in one line. now collects this answer's regions, for the caller to keep.
export type Seen = { before: Map<number, string>; now: Map<number, string> }
const unchanged = (n: Node, whole: string, seen: Seen) => {
  seen.now.set(n.ref!, whole)
  return seen.before.get(n.ref!) === whole
}

const isRegion = (n: Node) => n.ref !== undefined && (n.role === 'dialog' || LANDMARKS.has(n.role ?? ''))
const clipTo = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const regionLine = (n: Node, caps: Caps) =>
  `[${n.ref}] ${n.role}${n.name ? ` "${clipTo(n.name, caps.nameChars)}"` : ''}${n.role === 'dialog' ? ' — the page behind it is not available' : ''}`

export function control(n: Node, origin: string, caps: Caps): string {
  const clip = (s: string, max = caps.nameChars) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
  const bits = [n.value === undefined ? '' : `= ${JSON.stringify(clip(n.value))}`, ...(n.states ?? [])].filter(Boolean)
  let dest = ''
  // An address that does not parse goes nowhere, as in a browser; the link still shows.
  if (n.url && URL.canParse(n.url, origin)) {
    // The ref is how the agent acts; a link target is shown only when it adds something.
    const u = new URL(n.url, origin)
    if (caps.urls) dest = ` → ${u.href}`
    else if (u.origin !== origin) dest = ` → ${u.host}`
    else if (!n.name) dest = ` → ${clip(`${u.pathname}${u.search}`)}`
  }
  // A label only assistive tech hears usually repeats what the row shows; it gets less room.
  const name = n.name && clip(n.name, n.nameShown ? caps.nameChars : caps.labelChars)
  const reveals = n.reveals?.length ? `  reveals: ${n.reveals.map(r => clip(r, caps.labelChars)).join(' · ')}` : ''
  return ` [${n.ref}] ${n.role}${name ? ` "${name}"` : ''}${bits.length ? `  ${bits.join(' ')}` : ''}${reveals}${dest} `
}

// A collection of controls rather than records (a menu of every language), when it has more than `few`:
// one line with its size and first items, or undefined when it is short enough to show in full.
export function itemsLine(n: Node, origin: string, caps: Caps, few: number): string | undefined {
  const items: Node[] = []
  const walk = (c: Node) => (c.ref && !COLLECTIONS.has(c.role ?? '') ? items.push(c) : (c.children ?? []).forEach(walk))
  ;(n.children ?? []).forEach(walk)
  if (items.length <= few) return undefined
  return `[${n.ref}] ${n.role} of ${items.length}: ${items.slice(0, few).map(c => control(c, origin, caps).trim()).join(' · ')} …`
}

export function renderText(root: Node, origin: string, caps: Caps, seen?: Seen): string {
  const lines: string[] = []
  let line = ''
  // Parts of a row are joined by ' · ', except next to a part that is only punctuation or symbols
  // (a dash, a bullet), which reads as a space: "• 7:00 AM – 9:10 AM".
  const mark = /^[\p{P}\p{S}]+$/u
  const flush = () => {
    const parts = line.split(SEP).map(p => p.replace(SPACE, ' ').trim()).filter(Boolean)
    const t = parts.reduce((acc, p, i) => (i === 0 ? p : `${acc}${mark.test(p) || mark.test(parts[i - 1]) ? ' ' : ' · '}${p}`), '')
    if (t) lines.push(t)
    line = ''
  }
  const visit = (n: Node, inRow: boolean) => {
    if (n.text !== undefined) { line += n.text; return }
    if (n.role === 'image') { if (caps.urls) line += `${SEP}${n.url}${SEP}`; return }
    if (isRegion(n)) {
      flush()
      if (seen && unchanged(n, renderText({ block: true, children: [n] }, origin, caps), seen)) {
        lines.push(`${regionLine(n, caps)} — shown before, unchanged`)
        return
      }
      line = regionLine(n, caps)
      flush()
      for (const c of n.children ?? []) visit(c, false)
      flush()
      return
    }
    // A collection of records starts with its own line, so `get <ref>` is in reach from the text as from
    // the map; then it reads as its contents, as a canvas does.
    if (n.ref && COLLECTIONS.has(n.role ?? '') && !inRow) {
      const rows = rowsOf(n).filter(r => !isHeaderRow(r)).length
      if (rows >= 2) { flush(); lines.push(`[${n.ref}] ${n.role} of ${rows}`) }
    }
    if (n.ref && !COLLECTIONS.has(n.role ?? '') && n.role !== 'canvas') {
      if (n.block && !inRow) flush()
      line += control(n, origin, caps)
      for (const c of n.children ?? []) visit(c, inRow)
      if (n.block && !inRow) flush()
      return
    }
    if (inRow) {
      if (n.block) line += SEP
      for (const c of n.children ?? []) visit(c, true)
      if (n.block) line += SEP
      return
    }
    if (n.block) flush()
    if (n.role === 'heading') line += `${'#'.repeat(n.level ?? 1)} `
    for (const c of n.children ?? []) visit(c, !!n.row)
    if (n.block) flush()
  }
  visit(root, false)
  flush()
  return lines.join('\n')
}

// The subtree for a ref (a region, a control), for zooming in.
export function findRef(n: Node, ref: number): Node | undefined {
  if (n.ref === ref) return n
  for (const c of n.children ?? []) {
    const hit = findRef(c, ref)
    if (hit) return hit
  }
  return undefined
}

const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox'])

// The page as regions, the way screen-reader users survey it: per landmark its headings, collections
// (item count and the first item), fields, actions and links. Named when few, counted when many.
export function renderMap(root: Node, origin: string, caps: Caps, few: number, seen?: Seen): string {
  const out: string[] = []
  const summarize = (title: string, nodes: Node[], region?: Node) => {
    const headings: string[] = []
    const lists: string[] = []
    const fields: Node[] = []
    const actions: Node[] = []
    const options: Node[] = []
    const links: Node[] = []
    const nested: Node[] = []
    let text = 0
    const walk = (n: Node) => {
      if (n.text !== undefined) { text += n.text.trim().length; return }
      if (isRegion(n)) { nested.push(n); return }
      // A heading names a part of the page; one wrapped around a whole region (an app's banner) is markup
      // misuse, and the region is what the map shows.
      if (n.role === 'heading' && !withRefs(n).some(isRegion)) { headings.push(renderText({ block: true, children: n.children }, origin, caps)); return }
      if (COLLECTIONS.has(n.role ?? '')) {
        // A table's header row is its schema: counted out of the records, shown as the column names.
        const all = rowsOf(n)
        const header = all.find(isHeaderRow)
        const rows = all.filter(r => r !== header)
        if (rows.length) {
          const line = (r: Node) => clipTo(renderText({ block: true, children: [r] }, origin, caps).replace(/\n/g, ' · '), caps.nameChars)
          const sample = header ? `columns ${cellsOf(header).map(c => renderText({ block: true, children: c.children }, origin, caps)).join(' · ')}` : `${line(rows[0])}${rows.length > 1 ? ' …' : ''}`
          lists.push(`[${n.ref}] ${n.role} of ${rows.length}: ${sample}`)
          // Whatever else the container holds (a heading, pagination) still belongs in the map, and so
          // does a collection nested inside one of its rows.
          const nestedLists = (r: Node): void => (r.children ?? []).forEach(c => (COLLECTIONS.has(c.role ?? '') ? walk(c) : nestedLists(c)))
          for (const c of n.children ?? []) if (rowsOf(c).length) nestedLists(c); else walk(c)
          return
        }
        const line = itemsLine(n, origin, caps, few)
        if (line) { lists.push(line); return }
      }
      if (n.role === 'canvas') {
        const lines = n.children ?? []
        lists.push(`[${n.ref}] canvas: ${lines.length} lines — ${clipTo(renderText({ block: true, children: lines.slice(0, 1) }, origin, caps), caps.nameChars)}${lines.length > 1 ? ' …' : ''}`)
        return
      }
      if (n.ref && !COLLECTIONS.has(n.role ?? '')) (FIELDS.has(n.role ?? '') ? fields : n.role === 'option' ? options : n.role === 'link' ? links : actions).push(n)
      for (const c of n.children ?? []) walk(c)
    }
    nodes.forEach(walk)
    const named = (label: string, list: Node[]) => {
      if (!list.length) return
      out.push(list.length <= few
        ? `  ${label}: ${list.map(n => control(n, origin, caps).trim()).join(' · ')}`
        : `  ${label}: ${list.length}`)
    }
    const body = out.length
    named('fields', fields)
    named('options', options)
    named('actions', actions)
    if (headings.length) out.push(`  headings: ${headings.slice(0, few).join(' · ')}${headings.length > few ? ` … ${headings.length - few} more` : ''}`)
    lists.slice(0, few).forEach(l => out.push(`  ${l}`))
    if (lists.length > few) out.push(`  … ${lists.length - few} more collections`)
    named('links', links)
    if (text) out.push(`  text: ${text} chars`)
    if (out.length > body) out.splice(body, 0, title)
    if (region && seen && unchanged(region, renderText({ block: true, children: [region] }, origin, caps), seen) && out.length > body + 1) out.splice(body, Infinity, `${title} — shown before, unchanged`)
    nested.forEach(r => summarize(regionLine(r, caps), r.children ?? [], r))
  }
  summarize('page (outside any region)', root.children ?? [])
  const closed = withRefs(root).filter(isTrigger).length
  if (closed) out.push(`closed menus and pop-ups: ${closed} (browser-layer explore lists what they hold)`)
  return out.join('\n')
}

// Pages split on line boundaries so no control's line is cut in half.
export function paginate(text: string, pageChars: number): string[] {
  const pages: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > pageChars) { pages.push(cur); cur = '' }
    cur = cur ? `${cur}\n${line}` : line
  }
  pages.push(cur)
  return pages
}

// Lines removed and added between two views of the same page. Refs keep unchanged lines identical,
// so the common head and tail are skipped and the middle is compared as multisets.
export function diffLines(before: string[], after: string[]): { removed: string[]; added: string[] } {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  const was = before.slice(head, before.length - tail)
  const now = after.slice(head, after.length - tail)
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>())
  const take = (lines: string[], other: Map<string, number>) => lines.filter(l => {
    const n = other.get(l) ?? 0
    if (n) other.set(l, n - 1)
    return !n
  })
  return { removed: take(was, count(now)), added: take(now, count(was)) }
}
