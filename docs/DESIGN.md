# browser-layer — design

Status: draft for review · 31 Oct 2026 · replaces the earlier draft (MCP, compiler and replay are out of scope)

## 1. What it is

A complete web browser for agents that lives in the terminal. It does everything a browser does —
loads pages, runs their JavaScript, keeps logins, fills forms, opens pop-ups, uploads and downloads —
and gives the agent **text: what is on the page and what can be done**, never pixels.

The agent is the intelligence. It decides, remembers and optimizes (for example, reading `net` and
calling an API with `curl` next time). This tool is the browser, not a second agent.

### Principles

1. **Standards over cases.** Every rule comes from a spec the browser implements (WAI-ARIA, HTML-AAM,
   Accessible Name Computation, the HTML form submission algorithm, CSSOM, HAR) or is a named policy
   value in one file. No code exists because one site behaved a certain way.
2. **Know before triggering.** What the page will reveal (hover menus, collapsed sections, popups) is
   read from its structure first. Events are fired only for content that does not exist yet.
3. **No pixels, minimum rendering work.** The agent never gets pixels. Decoration (images, fonts,
   media, animation) is not loaded, unless the agent allows it for a site (`allow images`) whose content is
   only pictures (a scanned book, a map, a video) or that will not work without it. Painting is removed when we own the engine (§8).
4. **Fast because of less, not because of tricks.** Fewer bytes, fewer steps, deltas instead of
   full re-reads.

### Out of scope

MCP or other agent protocols (the agent has a terminal), learning and replay inside the tool,
vision (`screenshot` saves a picture for a person or a judge; the agent reads text), cloud or
multi-user hosting, anti-bot evasion. The browser says it is automated; a site that refuses it (HTTP
403 or 429) or puts a CAPTCHA in front of the page is reported as `blocked:` with the ways out: the
site's normal way in (its home page or search, another page, a retry after a wait), since a block
often covers one page and not the site, and then a person clearing it in the `show` window, after
which the session carries on with what they cleared.

## 1a. How a website reaches an agent

Websites are built for eyes and a mouse; a visual page is a poor fit for an agent, and so is its raw DOM.
The proven model for using the whole web without seeing it is how blind users browse with a screen
reader: they never take in a page at once; they ask "what regions are here?", jump to one, list its
headings and fields, walk a list item by item, and act. It rests on standards every site already ships
(ARIA landmarks, headings, lists, tables, form controls), and it is the backbone of the agent's view:

| Move | What the agent gets | Command |
|---|---|---|
| **Map** | The page as regions, each with its fields (and values), options, actions, headings, collections (record count and first item, or a table's columns) and links; named when few, counted when many. Opening a page answers with the map. | `tab`, `go`, `map` |
| **Zoom** | One region, collection or control in full text. | `read <ref>` |
| **Whole page** | Everything, paged. Read again, only what changed since the last read (`--full`: all of it). | `read` |
| **Act** | Fill, pick, click by ref; the answer is what changed (§4.4). | `type`, `pick`, `click`, `press` |
| **Data** | A list or table as records (TSV): sorted as numbers, limited, column-picked (§4.5). | `get <ref>` |

The agent decides how deep to go. The tool never decides for it what matters; it makes every level cheap
to reach.

**Each thing is shown once.** Everything an answer gives stays in the agent's context and is paid for on
every later step, so nothing is given twice. Reading a page again answers with what changed. A region the
agent was already shown in this tab, exactly as it is now (a site's menus and footer on its next page),
is one line in the map that answers a page load and in `read`: `[16] navigation — shown before,
unchanged`. Its ref still works (refs stay with the element, §3), and `read <ref>`, `read --full` and
`map` show it whole.

**One call per decision.** Every call is a turn of the agent's model, and the turns, not the browser,
take most of a task's time. So an answer carries what the next decision needs: an action that opens a
dialog answers with what it holds when short (`open.dialogChars`), an action says what did not take (a field holding other text,
an Enter that changed nothing, what covers a control and the buttons that answer it), a ref the page
re-rendered acts on the same element without a second look, and a 429 is waited out and loaded again.
What the agent already knows it does in one call: `steps` runs several commands in order, actions
answering in one line, reads and the last step in full, stopping at the first error, dialog or block with
the page as it is then.

## 2. Evidence this design rests on

From `bench/RESULTS.md` (five live sites, 31 Oct 2026):

- The engine's accessibility tree builds in **35–87 ms** and already marks rows and list items.
- Cutting decoration keeps the page **identical** and saves **13–36%** of bytes (Amazon loads 2.7× faster).
- Cutting all CSS **breaks pages** (Google Flights lost 42 controls; GitHub surfaced 65 hidden ones).
  CSS that carries meaning stays.
- Painting costs **70–220 ms** of CPU per load: worth removing at scale, not a blocker today.

## 3. Architecture

```
 agent (any LLM with a terminal)
   │  browser-layer <command>          text out, --json for programs
 ┌─┴───────────────────────────────────────────────────────────┐
 │ CLI            parse args, print. No logic.                   │
 ├─────────────────────────────────────────────────────────────┤
 │ DAEMON         sessions · tabs · ordering · policy · storage  │
 ├──────────────────┬──────────────────┬───────────────────────┤
 │ READER           │ ACTIONS          │ EVENTS & NETWORK       │
 │ AX tree + layout │ actionability,   │ dialogs, popups,       │
 │ → Node tree,     │ trusted input,   │ downloads, HAR log     │
 │ reveal map       │ settle contract  │                        │
 ├──────────────────┴──────────────────┴───────────────────────┤
 │ ENGINE   chromium (headless now, own no-paint build later)    │
 │          http (plain fetch for static pages, same commands)   │
 └─────────────────────────────────────────────────────────────┘
 RENDERER (text for the agent, JSON for programs) reads Node trees only.
```

Each layer depends only on the layers below. The CLI never talks to an engine.

## 4. The reader

### 4.1 Sources

Each fact comes from the browser source that is authoritative for it:

- **What is rendered:** `DOMSnapshot` — the DOM in document order, which nodes have a layout box, the
  rendered text of each text node (and of `::before` / `::after` / `::marker`), computed `display`,
  `visibility`, `opacity`, and attributes.
- **What things are:** the accessibility tree (CDP `Accessibility`) — roles, names (Accessible Name
  Computation), values and states, as the browser maps ARIA and HTML. We never reimplement those specs.
- **Identity:** the browser's `backendNodeId`. The agent sees small numbers (`[12]`); the daemon maps
  each to a node id per tab and numbers them from one counter shared by every tab, so a ref from another
  tab misses. Within a tab a ref names the element as a user sees it, not one node: when the page
  re-renders it or the next page has it again (same role, name and place, the only one so on both
  readings), it keeps its number, so `click 31` on "Next" works page after page. An element that is not
  unique gets a new number, so an old ref misses rather than hits something else. Nothing is written
  into the page.

The accessibility tree alone is not enough: it omits the text of `aria-hidden` content, and sites put
visible facts there (Google Flights' times, airports and prices).

### 4.2 Rules

1. Text is shown when its node has a layout box and no ancestor is `visibility: hidden` or
   `opacity: 0`.
2. A control (ARIA widget role) gets a ref when it has a layout box. Its text children are its name
   and are not repeated, unless they contain other controls.
3. `aria-hidden="true"` (WAI-ARIA): the subtree's text is shown, its controls get no ref.
   `inert` (HTML): the subtree is not shown. Both read from the attribute, as the specs define them.
4. Lines follow CSS: an element whose `display` is not inline-level starts a new line. Elements with a
   row role (`row`, `listitem`, `option`, `menuitem*`, `treeitem`) are one line, with ` · ` between
   their blocks. Headings print with their level (`## Title`).
5. Images are not shown; their alt text is the name of the control they sit in. Their address (the
   image's current source, HTML) is kept for records (§4.5).
6. A control's name gets `render.nameChars` when everything it says is on screen (letters and digits
   of the name contained in its visible text); otherwise it is a label only assistive tech hears and
   gets `render.labelChars`.
7. While a dialog the accessibility tree marks `modal` is open, the view is that dialog (WAI-ARIA:
   content outside a modal is not available).
8. Frames: same-process frames come in the same DOM snapshot as more documents, each with its own
   accessibility tree; a cross-origin frame in its own process is read through its own engine session.
   Both are grafted under their `iframe`. Refs carry their frame; pointer input lands at the frame's
   offset in the page.
9. Canvas: text drawn with `fillText` / `strokeText` on a 2D canvas is recorded with its position by a
   hook that runs before the page's scripts; `clearRect` forgets what it paints over. It reads as lines
   under the canvas, top to bottom, parts left to right. WebGL and OffscreenCanvas text (Figma) is not.

10. An element a script made clickable (click, mousedown, mouseup, pointerdown or pointerup listeners,
    or the same inline attributes), with no role and no controls inside, gets a ref as `clickable`,
    named by its text. Listeners on the document or body (event delegation, as React does) mark nothing.

Known gaps: a popup
that hides the rest of the page with `aria-hidden` without declaring itself modal makes the whole page
change (its refs disappear), so the action answers with the full view.

### 4.3 The reveal map (know before triggering)

For each control, what it will open, from the page's own declarations:

| Source | Standard | In the view |
|---|---|---|
| `aria-controls`, `aria-owns`, `popovertarget` pointing at an element not on screen | WAI-ARIA, HTML | `reveals: Laptops · Phones …`: that element's items (links, buttons, options, ARIA items), up to `render.mapFew` |
| `<summary>` of a closed `<details>` | HTML | `reveals:` the details' content |
| `mouseenter` / `mouseover` / `pointerenter` / `pointerover` listeners, or the same inline attributes | DOM events (a hook that runs before the page's scripts records `addEventListener` calls) | `reacts to hover`: `hover <ref>` will change something |

Not covered: CSS `:hover` rules (cross-origin stylesheets cannot be read from the page); frameworks that
put one hover listener on the document root (React) mark nothing; elements that react to hover but are
not controls get no ref.

### 4.3a Exploring what menus hold

Web apps build most menus only when opened, so no page can declare their items in advance. `explore`
discovers them the way a screen-reader user walks an unfamiliar app's menus:

- **Triggers** are controls that declare they open something (WAI-ARIA `aria-haspopup`, or
  `aria-expanded="false"`): buttons, menu items, links, tabs; not comboboxes (value lists) and not
  disabled ones. Nothing else is ever clicked, so exploring runs no command.
- Each trigger is clicked; the controls that appeared are its items (containers are not items); a
  trigger among them is opened too, up to `explore.depth`; Escape closes what was opened. Exploring
  stops if a click opens a dialog or leaves the page, and after `explore.max` opens.
- `menu "A > B > C"` runs a path by names: each step is the best name match (exact, prefix, contains),
  and after the first step, among equals, the newest control, which is in the menu just opened.
- The map says how many triggers are closed, and shows a canvas with drawn text as
  `[ref] canvas: N lines — first line`.

The same rules apply on every site; there is no per-site knowledge.

### 4.4 Answers carry only what changed

The agent already holds the page, so an action answers with the lines that changed since the last view
of the same context (the page, or a modal dialog by name): `- old line` / `+ new line`, plus why settling
stopped. When the changed lines are longer than the page itself, the page was replaced: the answer is
the shorter of its whole text (a small page) and its map (a large one). A map shows a collection by its
shape, which new records (the next page of a table) leave as it was, so such an answer is those
records, as `get` gives them, plus any other new lines; more than one page of them gets the map,
naming where they are (`new records in [12] table`). A new document
(`Page.frameNavigated` on the main frame) gets the map. pushState and hash changes are the same
document: refs and the view stay valid. A dialog, a pop-up and finished downloads are reported first.
Changed lines longer than one page with a long list among them (a menu of every language) give that
list as one line, as the map does: its size and first items; `find` or `read <ref>` goes in.

### 4.5 Records

`get <ref>` turns a collection into records:

- **Tables** (`table`, `grid`, `treegrid`) follow the HTML table model: a column is a cell position; the
  first row of column headers names the columns.
- **Lists** have no column model. The reader marks a row's fields (blocks, controls, cells, generated
  content such as a bullet or a rank), each with its element path from the row (tags and classes). Rows
  built from one template share a path for the same field, so a field's path is its column, and an
  optional part (a badge) gets its own column instead of shifting the others. Columns whose every value
  is punctuation only are dropped. Columns are `c1…cN`; no names are invented.
- **Addresses on request:** `get --urls` gives each link's full URL and each picture's address (its
  current source; inline `data:` pictures have none), each once per record, since stores link a card's
  picture, title and price to one page. Without it, and in reading and the map, both are left out: a
  store's tracked links are hundreds of characters each.
- **Sorting** uses the standard collator with numeric ordering, after removing digit-group separators
  and turning 12-hour times into 24-hour ones. Empty values sort last.

- **Unmarked collections** (data-region detection): when at least `data.minRepeats` children of a
  container with no semantic role share a signature (tag and the classes more than one of them has) and
  each has at least `data.minParts` block-level parts (looking through single-box wrappers), the largest
  such group is a collection of records. A card has a title, a price, a rating; a run of paragraphs
  repeats but has no parts. Never inside a collection the page marked up itself. Detected records are
  addressable (map, `get`) and do not change how the page reads.
- **Template, not identity:** a class only one sibling or one row has (an item id) is left out of
  signatures and field paths.

- **Canvases** (`get` on a canvas ref): text drawn on one line is a row; the positions where text
  starts, gathered over the canvas, are its columns.

Known gaps: a field styled differently per row (a "good" vs "average" class) splits into two columns. On
a canvas, centred or right-aligned text starts elsewhere than left-aligned text in the same column, and a
wrapped cell is several rows: Google Sheets' grid comes out split and spread. A canvas has no cells to
read, so for such apps their own export (found with `explore`, run with `menu`) is the clean path.

## 5. Actions

An action's target is a ref, or a control's accessible name: an exact match wins over a prefix, a
prefix over a contained match (case-insensitive). Several equally good matches are an error that lists
them with refs, since guessing would act on the wrong control.

### 5.1 Actionability

Before pointer input, the target is waited for (up to `actions.timeoutMs`) until it has a box, is
enabled, has stopped moving, and is the element at its own center (hit test against layout, through
shadow roots and frames). Failure names the last reason: `it has no box on the page`, `it is disabled`,
`it is still moving`, `covered by <div> "Cookie wall"`.

### 5.2 Input

Trusted input through the engine (CDP `Input.*`); hit testing uses layout, not pixels. `type` replaces
a field's content as typing over a selection does. Input that opens `alert`/`confirm`/`prompt` ends the
action; the dialog waits for `dialog accept [text]` or `dialog dismiss`.

### 5.3 Settle contract

Settled when the site's own requests the command caused have finished and the shown text
(`innerText`, and text drawn on canvases) has not changed for `settle.quietMs`, when a dialog is waiting,
or at `settle.deadlineMs`. Every answer says which (`idle in 412 ms`, `deadline 5000 ms`). The agent reads
text, so text is what settle waits on: ads, timers and animations change the DOM all the time without
changing a word. Another site's requests (ads, analytics, widgets; a site is its registrable domain) do not
hold a page, except their fetch/XHR calls where content may come from them: those an action on a loaded
page starts within `settle.thirdPartyMs` (a search box served by a search API), and those a page that just
arrived makes in its first `settle.arrivalMs`, each for that long at most (results from another site's API;
ad scripts keep making more, so each is bounded). Measured on news, travel and retail home pages: BBC 3.2 s → 2.7 s,
CNN from the 5 s deadline to 4.4 s, Zillow 2.9 s → 2.1 s, Stack Overflow 1.5 s → 1.9 s. A page with plenty of text but hardly any shown
(results revealed after load) gets `settle.revealMs` to show it. A document that has not arrived in
`load.domMs` is read as far as it got, and the answer says so. The page's standing connections are not the command's doing: requests open
when it began, and requests that reopen one of their channels (same origin and path, as a long-poll
reconnects), do not hold it. Measured on Google Sheets, whose DOM is still but whose `bind` channel is
always open: actions settle in 0.4–1.4 s instead of the 5 s deadline.

A page can draw after the network and DOM went quiet (a timer, client-side rendering). Settle does not wait
for that: the map of a page with nothing on it says `no content yet: the page may still be loading; read
again`, at no cost to any page that has content, and the agent's next read shows what landed.

## 6. Browser coverage

| Capability | Commands |
|---|---|
| Navigation | `tab <url>` (a page already open in the session switches to its tab), `go <url>`, `back`, `forward`, `reload`, `tabs` (by last use), `use`, `close` |
| Reading | `map`, `read [ref] [--page N]`, `find <text>`, `get <ref>` (records), `wait [--gone] <text>` |
| Menus | `explore [ref]`, `menu "A > B > C"` |
| Pointer | `click`, `dblclick`, `rightclick`, `hover`, `drag <ref> <onto ref>` (pointer drags and HTML drag and drop) |
| Keyboard | `type <ref> <text> [--enter] [--keys]` (replace as typing over a selection; `--keys` sends one key event per character), `press <key or combo>` |
| Form | `check`, `uncheck` (repeatable), `pick <ref> <option>` (a `<select>`, or an ARIA combobox or listbox opened and its option clicked), `upload <ref> <file…>`, `submit <ref>` (`requestSubmit`) |
| Scroll | `scroll [ref] [down \| up \| top \| bottom]`; lazily loaded rows come back as changes |
| Batching | `steps '<cmd>; <cmd>; …'` runs several commands in one call (§1a) |
| Dialogs | `alert` / `confirm` / `prompt` / `beforeunload` wait for `dialog accept [text] \| dismiss` |
| Windows | Pop-ups and `target=_blank` open as tabs in the same session and become current |
| Downloads | Saved under `<home>/downloads`, reported by the action that caused them |
| Frames | Read and act inside frames by ref, cross-origin included |
| Storage | `cookies [domain]` (names, never values), `cookies clear [domain]`, `storage local\|session [clear]`, `eval <js>` |
| Network | `net [--all]`, `net show <#>` (headers with credentials redacted, bodies), `net save <#> <file>` (the whole response body) |
| Permissions | `allow <permission>[,…] [lat,lon]` per site; everything else denied. `allow images` lets the site load images, fonts and media |
| Profiles and sign-in | `--profile <name>` is a separate browser; `login <url>` opens a normal Chrome window on the agent's profile (no automation attached) for the person to sign in, with the same mock keychain as the agent's browser so the session decrypts |
| Watching | `show` makes the current browser a visible window; `hide`, a closed window or any restart makes it headless again |

## 7. Engines

| Engine | Use | Notes |
|---|---|---|
| `chromium` | Default | Installed Chrome, headless. Playwright for lifecycle and actionability, raw CDP for the accessibility tree, DOMSnapshot and network. Images, fonts and media never requested; `prefers-reduced-motion` on and animations/transitions disabled. |
| `http` | Static pages, forms | parse5 (the HTML parsing algorithm, scripting off so `<noscript>` shows); the same Node tree and renderer as live tabs, with HTML-AAM roles and the accessible-name rules HTML alone can answer; a table that holds a table is layout, as browsers treat it. Forms follow the HTML form submission algorithm: owners (`form="id"`), disabled controls and fieldsets (first legend exempt), the default button as submitter with its `formaction`/`formmethod`/`formenctype`, `dirname`, multi-selects, entries in tree order, CRLF newlines, all three encodings. A page with little text and scripts says it is built by JavaScript and names `tab`. Cookies are shared with the browser through the jar (synced both ways); reading Chrome's own encrypted store was decided against. |

## 8. Owning the engine (later)

When many tabs run at once, the 70–220 ms of paint per load becomes a real cost. Then:
`chrome-headless-shell` first (Chromium's own stripped build), then our own build of it with paint,
raster and compositing removed after layout. It replaces the `chromium` engine behind the same
adapter; nothing above changes. Decision point: measured CPU per tab at the parallelism we need.

## 9. Policy (`src/policy.ts`, documented, tested)

Keys are added when the phase that uses them lands.

| Key | Default | Meaning |
|---|---|---|
| `settle.quietMs` | 400 | How long the shown text must stay the same |
| `settle.deadlineMs` | 5000 | Max wait after an action |
| `settle.revealMs` | 2500 | Wait for text a page holds but does not show yet |
| `settle.thirdPartyMs` | 1000 | Another site's fetch/XHR started this soon after an action on a loaded page holds settle |
| `settle.arrivalMs` | 2000 | On a page that just arrived, another site's fetch/XHR started in this window holds settle, each for this long at most |
| `open.dialogChars` | 6000 | A dialog an action opened answers whole up to this size (regions already shown, one line each), else with its map |
| `render.pageChars` | 15000 | Text page size |
| `render.maxChars` | 400000 | Ceiling on one snapshot |
| `render.nameChars` | 120 | Cap for names that are on screen, and link paths |
| `render.labelChars` | 40 | Cap for labels only assistive tech hears |
| `render.mapFew` | 8 | In the map, controls are named up to this many per kind, counted above |
| `actions.timeoutMs` | 5000 | Wait for a control to be ready before pointer input |
| `command.timeoutMs` | 75000 | A command still running after this fails, so a page that stopped answering cannot hold the others (under the CLI's 90 s wait) |
| `read.timeoutMs` | 20000 | The same for a command that only reads the page (read, map, find, get, screenshot, net…): reading takes seconds, so a stuck page is told sooner |
| `wait.timeoutMs` | 15000 | How long `wait` looks for its text |
| `explore.depth` | 2 | Levels of submenus `explore` opens |
| `explore.max` | 40 | Most menus one `explore` opens |
| `explore.waitMs` | 1500 | Settle deadline after opening or closing a menu while exploring |
| `data.rows` | 20 | Lines `find` returns (`get` with no `--limit` returns the records that fit `render.pageChars`) |
| `data.minRepeats` | 3 | Siblings sharing a signature before they count as records |
| `data.minParts` | 2 | Block-level parts each of those siblings needs |
| (data) `src/trackers.ts` | hosts and path segments | With beacons and 204 responses, hidden from `net` unless `--all` |
| (rule) permissions | denied | Granted per site by `allow` |
| `sessions.max` | 8 | Parallel sessions |
| `load.timeoutMs` | 30000 | Navigation timeout (until the response begins) |
| `load.domMs` | 10000 | Wait for the document; after it, the page is read as far as it got |
| `load.retryMs` | 8000 | Longest wait before loading a page again after a 429 |
| `viewport.width` / `.height` | 1280 / 900 | Layout size; decides responsive variants |
| `blocked.controls` | 30 | A CAPTCHA frame on a page with fewer controls than this is a human check in front of the page; on a fuller page it guards one form |
| `network.keep` | 300 | Requests kept per tab |
| `network.bodyChars` | 4000 | Body cap in `net show` (`net save` writes the whole body) |
| `network.keepBytes` | 5000000 | API answers (fetch, XHR) up to this size are kept when they arrive, since the browser drops them once the page moves on |
| `daemon.idleMs` | 1800000 | Idle shutdown |

## 10. Runtime and storage

- Daemon per user, started on demand, single instance (lock + liveness), owner-only socket on a short
  path, idle shutdown, `stop` returns after the engine exits.
- `~/.browser-layer/<profile>/`: browser profile, downloads, HAR logs (bounded, `Cookie` /
  `Authorization` / `Set-Cookie` redacted before disk), daemon log.
- The `http` engine reads and writes cookies through the browser profile; no separate jar file.

## 11. Quality

- Spec conformance tests: accessible names, HTML form submission, ARIA reveal patterns.
- Recorded corpus (HAR of real pages, seeded `Math.random`) replayed offline, so measurements are deterministic.
- Live checks against real sites on demand (`npm run live`), never blocking the build.
- Budgets per commit: read p95 under 150 ms on the corpus; no regression in `bench/` numbers.
- A behavior change lands with a failing test first and before/after numbers.
