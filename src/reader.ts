import type { CDPSession } from 'playwright-core'

// What the page shows, as a tree. Rendering decides lines; the reader only reports facts.
export type Node = {
  ref?: number
  role?: string
  name?: string
  // Everything the name says is on screen; otherwise it is a label only assistive tech hears.
  nameShown?: boolean
  // What the control opens that is not on screen yet: items of the element it controls (aria-controls,
  // aria-owns, popovertarget) or the content of a closed <details>, known before it is triggered.
  reveals?: string[]
  // aria-haspopup as the browser computes it (menu, listbox, dialog, true): the control opens something.
  popup?: string
  value?: string
  states?: string[]
  url?: string
  level?: number
  text?: string
  block?: boolean
  row?: boolean
  // A field inside a row (a block, a control, a cell, generated content): its element path from the row
  // (tags and classes). Rows built from one template share a path for the same field, which is how
  // records line up into columns.
  key?: string
  // A table cell (HTML table model); header marks a column header cell.
  cell?: boolean
  header?: boolean
  // One of several siblings with the same element signature and parts: a record in a collection the page
  // did not mark up as a list (§4.5). Records are addressable; they do not change how the page reads.
  record?: boolean
  // On a canvas: each piece of drawn text with its position, for reading the canvas as records.
  drawn?: [string, number, number][]
  children?: Node[]
}

// Refs are small numbers the agent types. Each maps to the browser's own node id within a frame scope
// ('' for the page and its same-process frames, the frame id for a frame with its own engine session).
// Numbers come from one counter shared by every tab, so a ref from another tab can only miss. Within a
// tab an element keeps its ref while it stays the same element to a user: re-rendered, or on the next
// page, an element with the same role, name and place, the only one so on both readings, gets its old
// number back (byIdentity). Anything else gets a new number, so an old ref misses rather than hits
// something else.
export type Refs = { byNode: Map<string, number>; byRef: Map<number, { scope: string; id: number }>; byIdentity: Map<string, number>; counter: { next: number } }
export const newRefs = (counter = { next: 1 }): Refs => ({ byNode: new Map(), byRef: new Map(), byIdentity: new Map(), counter })

// ARIA widget roles: the things a user operates. Everything else is content.
const WIDGETS = new Set(['button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'])
// Roles that are one item on screen (a result, a table row): their content reads as one line.
const ROWS = new Set(['row', 'listitem', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem'])
// ARIA landmarks: the regions a page is made of, as screen-reader users jump between them.
export const LANDMARKS = new Set(['banner', 'navigation', 'main', 'search', 'complementary', 'contentinfo', 'region', 'form'])
// Landmarks that divide a page itself, never found inside one of its records.
const PAGE_PARTS = new Set(['banner', 'main', 'contentinfo', 'navigation', 'complementary'])
// Containers whose items are a collection: a list of results, a table of rows, a set of tabs.
export const COLLECTIONS = new Set(['list', 'table', 'grid', 'treegrid', 'tree', 'menu', 'menubar', 'tablist', 'radiogroup'])
const CELLS = new Set(['cell', 'gridcell', 'columnheader', 'rowheader'])
export const TABLES = new Set(['table', 'grid', 'treegrid'])
// Whitespace with any invisible format characters (Unicode Cf: zero-width joiners, soft hyphens) around it
// reads as one space: emails pad their preview text with rows of them. One alone inside a word (an emoji
// sequence, a joiner in a script that needs it) has no whitespace and stays.
export const SPACE = /[\s\p{Cf}]*\s[\s\p{Cf}]*/gu
// Separates the segments of a field path (Node.key).
export const SEGMENT = '\u001e'

// Every node with a ref, in page order.
export const withRefs = (n: Node): Node[] => [...(n.ref ? [n] : []), ...(n.children ?? []).flatMap(withRefs)]

// The pictures among nodes, however deep: what a link or a row shows besides its text.
export const picturesIn = (nodes: Node[]): Node[] => nodes.flatMap(c => (c.role === 'image' ? [c] : picturesIn(c.children ?? [])))

// Frames of the common CAPTCHA providers (DESIGN §1).
const CHECKS = /^https:\/\/(www\.google\.com\/recaptcha|www\.recaptcha\.net|[\w.]*hcaptcha\.com|challenges\.cloudflare\.com)\//
// A human check stands in front of the page when its frame is on a page with almost nothing else to act
// on (a challenge page). On a page full of controls it guards one form (sign-up, contact), and the page
// itself is readable.
// An invisible check (size=invisible: a badge, no challenge) only scores the visitor; it stops no one.
export const humanCheck = (frameUrls: string[], tree: Node, fewest: number) =>
  frameUrls.some(u => CHECKS.test(u) && !/[?&]size=invisible\b/.test(u)) && withRefs(tree).length < fewest
// WAI-ARIA: a control that declares it opens something (aria-haspopup, or aria-expanded=false) and is
// enabled. Comboboxes open value lists (fonts, sizes), not commands, so they are left out.
const OPENERS = new Set(['button', 'menuitem', 'link', 'tab'])
export const isTrigger = (n: Node) => OPENERS.has(n.role ?? '') && !n.states?.includes('disabled') && (!!n.popup || !!n.states?.includes('collapsed'))

// The rows of a collection and the cells of a row, not descending into nested collections.
export const rowsOf = (n: Node): Node[] => (n.row || n.record ? [n] : (n.children ?? []).flatMap(c => (COLLECTIONS.has(c.role ?? '') ? [] : rowsOf(c))))
export const cellsOf = (n: Node): Node[] => (n.cell ? [n] : (n.children ?? []).flatMap(c => (COLLECTIONS.has(c.role ?? '') ? [] : cellsOf(c))))
// HTML table model: a row whose cells are all column headers names the columns.
export const isHeaderRow = (row: Node) => { const cells = cellsOf(row); return cells.length > 0 && cells.every(c => c.header) }
// CSS outer display types that stay in the line; every other display value starts a new block.
const INLINE_DISPLAY = /^(inline|contents|ruby)/
const BOOLEAN_STATES = ['focused', 'disabled', 'selected', 'required', 'readonly', 'busy', 'modal']
// Inside a hidden popup, the parts that are its items.
const ITEM_TAGS = new Set(['A', 'BUTTON', 'OPTION'])
const ITEM_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'link', 'button', 'treeitem'])
const HOVER_ATTRS = ['onmouseenter', 'onmouseover', 'onpointerenter', 'onpointerover']
const CLICK_ATTRS = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup']

// Elements a page-side hook collected (see daemon.ts), as backend node ids, each with a value the hook
// computes for it. The hook runs before the page's own scripts in every document.
async function hooked(cdp: CDPSession, list: string, value: string, cap: number): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>()
  const { result } = await cdp.send('Runtime.evaluate', { expression: `(${list})`, returnByValue: false }).catch(() => ({ result: undefined as any }))
  if (!result?.objectId) return out
  const { result: props } = await cdp.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true })
  await Promise.all(props.filter(p => /^\d+$/.test(p.name) && p.value?.objectId).slice(0, cap).map(async p => {
    const { node } = await cdp.send('DOM.describeNode', { objectId: p.value!.objectId! }).catch(() => ({ node: undefined as any }))
    if (!node) return
    const r = await cdp.send('Runtime.callFunctionOn', { objectId: p.value!.objectId!, functionDeclaration: value, returnByValue: true }).catch(() => undefined)
    out.set(node.backendNodeId, r?.result.value)
  }))
  return out
}

type AXNode = { ignored: boolean; role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown }; properties?: { name: string; value: { value?: unknown } }[]; backendDOMNodeId?: number }

function statesOf(ax: AXNode): { states: string[]; url?: string; level?: number; popup?: string } {
  const states: string[] = []
  let url: string | undefined
  let level: number | undefined
  let popup: string | undefined
  for (const { name, value: { value } } of ax.properties ?? []) {
    if (name === 'checked') states.push(value === 'mixed' ? 'mixed' : value === 'true' ? 'checked' : 'unchecked')
    else if (name === 'expanded') states.push(value ? 'expanded' : 'collapsed')
    else if (name === 'pressed' && value === 'true') states.push('pressed')
    else if (name === 'invalid' && value !== 'false') states.push('invalid')
    else if (BOOLEAN_STATES.includes(name) && value === true) states.push(name)
    else if (name === 'url') url = String(value)
    else if (name === 'level') level = Number(value)
    else if (name === 'hasPopup' && value !== 'false') popup = String(value)
  }
  return { states, url, level, popup }
}

export type Limits = { minRepeats: number; minParts: number; revealItems: number }
// The engine session for a frame that runs in its own process (a cross-origin iframe), given its id and
// the iframe element that owns it; undefined when the frame cannot be reached.
export type FrameSession = (frameId: string, owner: { scope: string; id: number }) => Promise<{ cdp: CDPSession; scope: string } | undefined>

type Snapshot = Awaited<ReturnType<CDPSession['send']>> & { documents: any[]; strings: string[] }

export async function readTree(cdp: CDPSession, refs: Refs, limits: Limits, frameSession?: FrameSession, scope = ''): Promise<Node> {
  const [{ nodes: ax }, snap] = await Promise.all([
    cdp.send('Accessibility.getFullAXTree') as Promise<{ nodes: AXNode[] }>,
    cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: ['display', 'visibility', 'opacity'] }) as Promise<Snapshot>,
  ])
  const str = (i: number | undefined) => (i === undefined || i < 0 ? '' : snap.strings[i])
  // Same-process frames come in the same snapshot as more documents, each with its own accessibility tree.
  const frameAx = await Promise.all(snap.documents.slice(1).map(d =>
    (cdp.send('Accessibility.getFullAXTree', { frameId: str(d.frameId) }) as Promise<{ nodes: AXNode[] }>).then(r => r.nodes, () => [])))
  const axOf = new Map([ax, ...frameAx].flat().filter(n => n.backendDOMNodeId).map(n => [n.backendDOMNodeId!, n]))

  const docs = snap.documents.map(doc => {
    const { parentIndex = [], nodeType = [], nodeName = [], nodeValue = [], backendNodeId = [], attributes = [] } = doc.nodes as Record<string, any[]>
    const kids: number[][] = nodeType.map(() => [])
    parentIndex.forEach((p: number, i: number) => { if (p >= 0) kids[p].push(i) })
    const rare = doc.nodes.contentDocumentIndex ?? { index: [], value: [] }
    // The address each picture chose (HTML: an img's current source, after srcset), resolved.
    const sources = doc.nodes.currentSourceURL ?? { index: [], value: [] }
    return {
      doc, nodeType, nodeName, nodeValue, backendNodeId, kids,
      sourceOf: new Map<number, string>(sources.index.map((n: number, k: number) => [n, str(sources.value[k])])),
      layoutOf: new Map<number, number>(doc.layout.nodeIndex.map((n: number, l: number) => [n, l])),
      contentDoc: new Map<number, number>(rare.index.map((n: number, k: number) => [n, rare.value[k]])),
      attr: (i: number, name: string) => {
        const a = attributes[i] ?? []
        for (let k = 0; k < a.length; k += 2) if (str(a[k]) === name) return str(a[k + 1])
        return undefined
      },
    }
  })
  type Doc = (typeof docs)[number]
  const byId = docs.map(d => {
    const m = new Map<string, number>()
    for (let i = 0; i < d.nodeType.length; i++) { const id = d.attr(i, 'id'); if (id) m.set(id, i) }
    return m
  })
  // Text of a subtree whether rendered or not: hidden popups have no layout to read text from.
  const domText = (d: Doc, i: number): string => (d.nodeType[i] === 3 ? str(d.nodeValue[i]) : d.kids[i].map(c => domText(d, c)).join(' '))
  // Page-side hooks: elements listening for hover, and text drawn on canvases (lines, top to bottom).
  const [hovered, clicked, drawn] = await Promise.all([
    hooked(cdp, 'window.__alHover ? [...window.__alHover].filter(e => e.isConnected) : []', 'function () { return true }', 300),
    hooked(cdp, 'window.__alClick ? [...window.__alClick].filter(e => e.isConnected) : []', 'function () { return true }', 500),
    hooked(cdp, 'window.__alCanvases ? window.__alCanvases() : []', 'function () { return { lines: window.__alCanvasLines(this), runs: window.__alCanvasRuns(this) } }', 50),
  ])

  // What a control reveals that is not on screen: the items of a hidden element it controls, or the
  // content of the closed <details> its <summary> opens.
  function revealsOf(d: Doc, i: number, k: number): string[] | undefined {
    const di = docs.indexOf(d)
    const targets = ['aria-controls', 'aria-owns', 'popovertarget'].flatMap(a => (d.attr(i, a) ?? '').split(/\s+/)).map(id => byId[di].get(id)).filter((t): t is number => t !== undefined)
    const parent = d.doc.nodes.parentIndex[i]
    if (str(d.nodeName[i]) === 'SUMMARY' && str(d.nodeName[parent]) === 'DETAILS' && d.attr(parent, 'open') === undefined) {
      const rest = squash(d.kids[parent].filter(c => c !== i).map(c => domText(d, c)).join(' '))
      return rest ? [rest.length > k * 15 ? `${rest.slice(0, k * 15 - 1)}…` : rest] : undefined
    }
    const items: string[] = []
    const collect = (j: number) => {
      const tag = str(d.nodeName[j])
      if (ITEM_TAGS.has(tag) || ITEM_ROLES.has(d.attr(j, 'role') ?? '')) {
        const label = squash(domText(d, j)) || d.attr(j, 'aria-label')
        if (label && !items.includes(label)) items.push(label)
        return
      }
      d.kids[j].forEach(collect)
    }
    for (const t of targets) if (!d.layoutOf.has(t)) collect(t)
    return items.length ? (items.length > k ? [...items.slice(0, k), `… ${items.length - k} more`] : items) : undefined
  }

  // Frames in their own process (cross-origin iframes): read through their own session, grafted in later.
  const remote = new Map<number, Node[]>()
  if (frameSession) {
    for (const d of docs) {
      for (let i = 0; i < d.nodeType.length; i++) {
        if (!/^(IFRAME|FRAME)$/.test(str(d.nodeName[i])) || d.contentDoc.has(i) || !d.layoutOf.has(i)) continue
        const { node } = await cdp.send('DOM.describeNode', { backendNodeId: d.backendNodeId[i] }).catch(() => ({ node: undefined as any }))
        const frame = node?.frameId && await frameSession(node.frameId, { scope, id: d.backendNodeId[i] })
        if (frame) remote.set(d.backendNodeId[i], (await readTree(frame.cdp, refs, limits, frameSession, frame.scope)).children ?? [])
      }
    }
  }

  // identity: role, name and place of the element; seen holds this reading's, 0 when not unique.
  const taken = new Set<number>(), seen = new Map<string, number>(), moved = new Map<string, number>()
  const refFor = (id: number, identity?: string) => {
    const node = `${scope}:${id}`, same = identity && refs.byIdentity.get(identity)
    let ref = refs.byNode.get(node)
    if (!ref && same && !taken.has(same)) {
      const old = refs.byRef.get(same)
      if (old) refs.byNode.delete(`${old.scope}:${old.id}`)
      ref = same
      moved.set(identity, same)
    }
    if (!ref) ref = refs.counter.next++
    refs.byNode.set(node, ref); refs.byRef.set(ref, { scope, id }); taken.add(ref)
    if (identity) seen.set(identity, seen.has(identity) ? 0 : ref)
    return ref
  }
  const hasRef = (nodes: Node[]): boolean => nodes.some(n => n.ref || (n.children && hasRef(n.children)))
  const textOf = (nodes: Node[]): string => nodes.map(n => n.text ?? textOf(n.children ?? [])).join('')
  const squash = (s: string) => s.replace(SPACE, ' ').trim()
  // Content, not formatting: "Airport Mumbai (BOM)" is on screen as "Airport MumbaiBOM 15 km away".
  const content = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

  // muted: inside aria-hidden (text shows, controls get no ref). unseen: visibility hidden or opacity 0.
  // path: this node's place inside the nearest row, for lining records up. marked: inside a collection
  // the page marked up itself, where its own rows win over detected ones.
  function walk(d: Doc, i: number, muted: boolean, unseen: boolean, path = '', marked = false): Node[] {
    const { doc, nodeType, nodeName, backendNodeId, kids, attr } = d
    const l = d.layoutOf.get(i)
    if (nodeType[i] === 3) {
      if (l === undefined || unseen) return []
      const text = str(doc.layout.text[l]) || str(d.nodeValue[i])
      return text ? [{ text }] : []
    }
    // HTML inert: the subtree cannot be used at all. WAI-ARIA aria-hidden: still on screen, so its
    // text stays, but it is not exposed as controls.
    if (attr(i, 'inert') !== undefined) return []
    const quiet = muted || attr(i, 'aria-hidden') === 'true'
    const a = axOf.get(backendNodeId[i])
    const [display, visibility, opacity] = l === undefined ? [] : doc.layout.styles[l].map(str)
    const hidden = l === undefined ? unseen : visibility === 'hidden' || visibility === 'collapse' || unseen || opacity === '0'
    // Chrome names <summary>'s role DisclosureTriangle; to a user it is a button.
    const raw = !quiet && a && !a.ignored ? String(a.role?.value ?? '') : ''
    const role = raw === 'DisclosureTriangle' ? 'button' : raw
    const cls = attr(i, 'class')?.trim()
    // Segments are split by a control character and classes by spaces: neither can occur in a class name.
    const key = ROWS.has(role) ? '' : `${path}${SEGMENT}${str(nodeName[i]).toLowerCase()}${cls ? ` ${cls.split(/\s+/).join(' ')}` : ''}`
    // Identity leaves classes out: pages put their own on <body> (page-Paris), and an element's change with
    // its state (active, open).
    const as = (r: string, name = '') => [scope, r, name, key.split(SEGMENT).map(t => t.split(' ')[0]).join(SEGMENT)].join(SEGMENT)
    const inner = marked || COLLECTIONS.has(role)
    // An iframe's content is its frame's document: in this snapshot, or read through its own session.
    const frame = d.contentDoc.get(i)
    const perKid = frame !== undefined ? [walk(docs[frame], 0, quiet, hidden, key, inner)]
      : remote.has(backendNodeId[i]) ? [remote.get(backendNodeId[i])!]
      : kids[i].map(c => walk(d, c, quiet, hidden, key, inner))
    const children = perKid.flat()
    const canvas = drawn.get(backendNodeId[i]) as { lines: string[]; runs: [string, number, number][] } | undefined
    // A canvas with drawn text is content the map points to; it gets a ref so the agent can read it.
    if (canvas?.lines?.length) return [{ ref: refFor(backendNodeId[i], as('canvas')), role: 'canvas', block: true, drawn: canvas.runs, children: canvas.lines.map(t => ({ block: true, children: [{ text: String(t) }] })) }]
    // Generated content (::before, ::after, ::marker) is a pseudo element carrying its own layout text,
    // and a field of its own: a bullet or a rank is not part of the text beside it.
    if (str(nodeName[i]).startsWith('::')) return l === undefined || hidden ? [] : [{ key, children: [{ text: str(doc.layout.text[l]) }] }]

    const block = l !== undefined && display !== undefined && !INLINE_DISPLAY.test(display)
    // A grid cell labelled apart from what it shows ("Choose Sunday, March 15th" on a "15") is one a user
    // picks, as a date picker's days are; a data grid's cells are named by their content and stay content.
    const label = role === 'gridcell' ? squash(String(a?.name?.value ?? '')) : ''
    const pickable = label !== '' && !content(textOf(children)).includes(content(label))
    if ((WIDGETS.has(role) || pickable) && l !== undefined && visibility !== 'hidden') {
      const { states, url, popup } = statesOf(a!)
      if (hovered.has(backendNodeId[i]) || HOVER_ATTRS.some(h => attr(i, h) !== undefined)) states.push('reacts to hover')
      const value = a!.value?.value
      const name = squash(String(a!.name?.value ?? ''))
      return [{
        ref: refFor(backendNodeId[i], as(role, name)), role, name, nameShown: content(textOf(children)).includes(content(name)), states, url, block, key,
        reveals: revealsOf(d, i, limits.revealItems), popup,
        value: value === undefined || value === '' ? undefined : String(value),
        children: hasRef(children) ? children : picturesIn(children).length ? picturesIn(children) : undefined,
      }]
    }
    if (role === 'heading') return [{ role, level: statesOf(a!).level, block: true, children }]
    // Landmarks get refs so the agent can zoom into a region.
    if (LANDMARKS.has(role)) {
      const name = squash(String(a!.name?.value ?? ''))
      return [{ ref: refFor(backendNodeId[i], as(role, name)), role, name, block: true, children }]
    }
    // Collections get refs so the agent can ask for their records.
    if (COLLECTIONS.has(role)) return [{ ref: refFor(backendNodeId[i], as(role)), role, block: true, children }]
    if (ROWS.has(role)) return [{ row: true, block: true, children }]
    if (CELLS.has(role)) return [{ cell: true, header: role === 'columnheader', block: true, key, children }]
    // An element made clickable by a script, with no role and no controls inside: the page never says it is
    // a button, but it acts as one. It gets a ref, named by its text.
    const plain = !role || role === 'generic' || role === 'none' || role === 'image' || role === 'StaticText'
    if (plain && !quiet && l !== undefined && !hidden && (clicked.has(backendNodeId[i]) || CLICK_ATTRS.some(h => attr(i, h) !== undefined)) && !hasRef(children)) {
      const name = squash(textOf(children)) || squash(attr(i, 'aria-label') ?? attr(i, 'title') ?? '')
      return [{ ref: refFor(backendNodeId[i], as('clickable', name)), role: 'clickable', name, nameShown: true, states: hovered.has(backendNodeId[i]) ? ['reacts to hover'] : [], block, key, children: [] }]
    }
    // A picture is not read out (rule 5), but its address is data that records carry. A data: URL is the
    // picture itself inline, not an address.
    const source = d.sourceOf.get(i)
    if (source && /^https?:/.test(source) && l !== undefined && !hidden) return [{ role: 'image', url: source, key }]
    if (!marked && (!role || role === 'generic' || role === 'none') && block && markRecords(d, i, perKid)) return [{ ref: refFor(backendNodeId[i], as('list')), role: 'list', block: true, key, children }]
    return block ? [{ block: true, key, children }] : children
  }

  // Data-region detection: at least minRepeats element children share a signature (tag and the classes
  // more than one of them has) and each has at least minParts block-level parts. A card has a title, a
  // price, a rating; a run of paragraphs repeats but has no parts, so it is not records. The largest
  // such group is marked.
  function markRecords(d: Doc, i: number, perKid: Node[][]): boolean {
    // Block-level parts of a node, looking through wrappers: a box whose only content is one box is that box.
    const parts = (n: Node, need: number): number => {
      const boxes: Node[] = []
      const collect = (m: Node) => { for (const c of m.children ?? []) if (c.block || c.ref) boxes.push(c); else collect(c) }
      collect(n)
      return boxes.length === 1 && !boxes[0].ref ? parts(boxes[0], need) : Math.min(boxes.length, need)
    }
    // A record is content: one that holds a part of the page's own layout (WAI-ARIA's page-level landmarks:
    // its banner, main area, footer, navigation, sidebar) is that layout, as a web app's shell repeats a
    // column per part. A form is not one of them: a product card holds its Add to cart form.
    const holdsRegion = (n: Node): boolean => (n.children ?? []).some(c => (c.ref && PAGE_PARTS.has(c.role ?? '')) || holdsRegion(c))
    // A class only one sibling has (item-3) is that sibling's identity, not its template.
    const classes = (c: number) => (d.attr(c, 'class') ?? '').split(/\s+/).filter(Boolean)
    const siblingsWith = new Map<string, number>()
    for (const c of d.kids[i]) for (const t of new Set(classes(c))) siblingsWith.set(t, (siblingsWith.get(t) ?? 0) + 1)
    const groups = new Map<string, Node[]>()
    d.kids[i].forEach((c, k) => {
      const [only, ...rest] = perKid[k] ?? []
      if (d.nodeType[c] !== 1 || rest.length || !only?.block || parts(only, limits.minParts) < limits.minParts || holdsRegion(only)) return
      const sig = [str(d.nodeName[c]), ...classes(c).filter(t => (siblingsWith.get(t) ?? 0) > 1)].join(' ')
      groups.set(sig, [...(groups.get(sig) ?? []), only])
    })
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0]
    if (!best || best.length < limits.minRepeats) return false
    for (const n of best) n.record = true
    return true
  }

  // WAI-ARIA: while a modal dialog is open, content outside it is not available. The view is the dialog.
  const modal = ax.find(n => !n.ignored && n.backendDOMNodeId && n.properties?.some(p => p.name === 'modal' && p.value.value === true))
  const at = modal ? docs[0].backendNodeId.indexOf(modal.backendDOMNodeId!) : -1
  const tree = at >= 0
    ? { block: true, children: [{ ref: refFor(modal!.backendDOMNodeId!), role: 'dialog', name: squash(String(modal!.name?.value ?? '')), block: true, children: walk(docs[0], at, false, false) }] }
    : { block: true, children: walk(docs[0], 0, false, false) }
  // An old number moved to an element that turned out not to be unique here goes back to a new number.
  const renumber = new Map<number, number>()
  for (const [identity, ref] of seen) {
    if (ref) { refs.byIdentity.set(identity, ref); continue }
    refs.byIdentity.delete(identity)
    const was = moved.get(identity)
    if (was) { const at = refs.byRef.get(was)!; refs.byRef.delete(was); const ref = refs.counter.next++; refs.byRef.set(ref, at); refs.byNode.set(`${at.scope}:${at.id}`, ref); renumber.set(was, ref) }
  }
  const fix = (n: Node) => { if (n.ref && renumber.has(n.ref)) n.ref = renumber.get(n.ref); n.children?.forEach(fix) }
  if (renumber.size) fix(tree)
  return tree
}
