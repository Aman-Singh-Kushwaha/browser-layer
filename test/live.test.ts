import { execFile, spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/policy.js'
import { findBrowser, PROFILE_FLAGS } from '../src/browser.js'

// A page that only exists after JS runs: autocomplete, then a fetch() send with no <form>.
const APP = `<!doctype html><title>Trip</title><body><div id="app"></div><script>
  const app = document.getElementById('app')
  app.innerHTML = '<h1>Plan a trip</h1><label for="city">City</label><input id="city"><ul id="sug" role="listbox"></ul>' +
    '<button id="send" disabled>Book</button><p id="out"></p><div style="display:none">hidden promo</div>'
  const city = document.getElementById('city'), sug = document.getElementById('sug'), send = document.getElementById('send')
  city.addEventListener('input', () => {
    sug.innerHTML = ''
    if (city.value.length < 2) return
    setTimeout(() => {
      for (const c of ['Delhi', 'Dehradun', 'Denver'].filter(c => c.toLowerCase().startsWith(city.value.toLowerCase()))) {
        const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = c
        li.onclick = () => { city.value = c; sug.innerHTML = ''; send.disabled = false }
        sug.appendChild(li)
      }
    }, 150)
  })
  send.onclick = async () => {
    const r = await fetch('/api/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ city: city.value }) })
    document.getElementById('out').textContent = (await r.json()).message
  }
</script></body>`

let base = ''
let booked = ''
let tooMany = 0
const server = createServer((req, res) => {
  if (req.url === '/login') {
    res.setHeader('set-cookie', 'fast=1; Path=/')
    res.setHeader('content-type', 'text/html')
    return res.end('<p>logged in</p>')
  }
  if (req.url === '/whoami') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>who</title><p>fast cookie: ${/fast=1/.test(req.headers.cookie ?? '') ? 'yes' : 'no'}</p>`)
  }
  if (req.url === '/view') {
    res.setHeader('content-type', 'text/html')
    // A result list: each item is one row on screen whatever blocks it is built from.
    return res.end(`<meta charset="utf-8"><title>view</title>
      <ul><li><div><span>7:00 AM</span><div>–</div><span>9:10 AM</span></div><div>IndiGo</div><div>₹6,895</div></li>
      <li><div><span>4:15 AM</span><div>–</div><span>6:25 AM</span></div><div>SpiceJet</div><div>₹7,118</div></li></ul>
      <h2>Stacked</h2><p>first line</p><p>second line</p>
      <div aria-hidden="true"><p>BOM – DEL</p><button>ghost</button></div>
      <div inert><p>behind the dialog</p></div>
      <a href="/vote?id=1"></a> <a href="/about">About us</a> <a href="https://example.org/x">Elsewhere</a>
      <a href="/airport" aria-label="Chhatrapati Shivaji Maharaj International Airport Mumbai (BOM)"><span>Chhatrapati Shivaji Maharaj International Airport Mumbai</span><span>BOM</span> 15 km away</a>
      <button aria-label="From 6895 Indian rupees. Nonstop flight with IndiGo. Leaves Chhatrapati Shivaji Maharaj International Airport Mumbai at 7:00 AM and arrives at 9:10 AM">Select</button>`)
  }
  if (req.url === '/regions') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<meta charset="utf-8"><title>regions</title>
      <nav aria-label="Main"><a href="/">Home</a> <a href="/about">About</a></nav>
      <search><input type="search" aria-label="Search flights"><button>Go</button></search>
      <main><h2>Results</h2><ul>${Array.from({ length: 12 }, (_, i) => `<li><div>Flight ${i}</div><div>₹${100 + i}</div></li>`).join('')}</ul></main>`)
  }
  if (req.url === '/data') {
    // A badge only some rows have, Indian digit grouping, 12-hour times across noon, and a real table.
    const flights = [['IndiGo', '₹9,500', '11:30 AM'], ['Air India', '₹12,300', '1:05 PM'], ['Vistara', '₹1,05,000', '9:15 AM'], ['Akasa', '₹980', '10:00 PM']]
    res.setHeader('content-type', 'text/html')
    return res.end(`<meta charset="utf-8"><title>data</title><main>
      <ul>${flights.map(([a, p, t], i) => `<li><div class="t">${t}</div>${i === 1 ? '<span class="badge">Best</span>' : ''}<div class="a">${a}</div><div class="p">${p}</div></li>`).join('')}</ul>
      <table><tr><th>Name</th><th>Size</th></tr><tr><td>a.txt</td><td>10 KB</td></tr><tr><td>b.txt</td><td>2 KB</td></tr></table></main>`)
  }
  if (req.url === '/cards') {
    // Cards with no list role, a per-item class, and a wrapper around their parts; beside them, a run of
    // paragraphs that repeats but has no parts.
    const items = [['Acer Aspire', '₹32,990'], ['HP 15', '₹55,989'], ['Lenovo IdeaPad', '₹1,05,000'], ['Dell 14', '₹41,500']]
    res.setHeader('content-type', 'text/html')
    return res.end(`<meta charset="utf-8"><title>cards</title><main>
      <div class="grid">${items.map(([n, p], i) => `<div class="card item-${i}"><div class="inner"><h3 class="title">${n}</h3><div class="price">${p}</div></div></div>`).join('')}</div>
      <div class="article">${Array.from({ length: 5 }, (_, i) => `<p class="para">Paragraph ${i} of plain text.</p>`).join('')}</div></main>`)
  }
  const page = (title: string, body: string) => { res.setHeader('content-type', 'text/html'); res.end(`<meta charset="utf-8"><title>${title}</title>${body}`) }
  const port = req.headers.host!.split(':')[1]
  // A paged table: Next replaces every row, which leaves the table's shape (and so the map) as it was.
  if (req.url === '/paged') return page('paged', `<main><table id="t"></table><button onclick="go(1)">Next</button><button>Delete</button><button>Delete all</button></main>
    <script>let p = 0; const go = d => { p += d; t.innerHTML = '<tr><th>Order</th><th>Status</th></tr>' + Array.from({ length: 30 }, (_, i) => '<tr><td>ORD-' + (p * 30 + i) + '</td><td>Paid</td></tr>').join('') }; go(0)</script>`)
  // A site that turns automated browsers away.
  // A page whose script never returns once its button is clicked: its renderer stops answering.
  if (req.url === '/freeze') return page('freeze', '<button onclick="for (;;) {}">Freeze</button>')
  // Product cards: the picture sits inside the product's link (one link hidden from assistive tech, as stores
  // do for a duplicate image link); one picture is inline data, not a URL.
  if (req.url === '/products') return page('products', `<ul>${[['Lamp', 500], ['Desk', 7200], ['Chair', 3100]].map(([name, price], i) =>
    `<li><a href="/p/${i + 1}"${i === 1 ? ' aria-hidden="true" tabindex="-1"' : ''}><img src="${i === 2 ? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' : `/img/${i + 1}.jpg`}" alt="${name}"></a><h3><a href="/p/${i + 1}">${name}</a></h3><a href="/p/${i + 1}#reviews">reviews</a><span>₹${price}</span></li>`).join('')}</ul>`)
  // An image that says on the page whether it loaded.
  if (req.url === '/pictured') return page('pictured', `<img src="/pixel.gif" onload="p.textContent = 'image loaded'" onerror="p.textContent = 'image missing'"><p id="p">waiting</p>`)
  if (req.url === '/pixel.gif') { res.setHeader('content-type', 'image/gif'); return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')) }
  // Taller than Chrome can capture in one picture.
  if (req.url === '/tall') return page('tall', '<div style="height: 30000px">top</div>')
  if (req.url === '/refused') { res.statusCode = 403; return page('403 Forbidden', '<h1>403 Forbidden</h1>') }
  // A filter menu of 900 choices, hidden until its button opens it (GitHub's language picker).
  if (req.url === '/longmenu') return page('longmenu', `<main><h1>Trending</h1>${'<p>A repository description long enough to make the page bigger than the menu it opens.</p>'.repeat(400)}<button aria-haspopup="menu" onclick="m.hidden = false">Language: Any</button>
    <div role="menu" id="m" hidden>${Array.from({ length: 900 }, (_, i) => `<div role="menuitemradio" aria-checked="false">Language ${i}</div>`).join('')}</div></main>`)
  if (req.url === '/frames') return page('frames', `<p>outer</p><iframe src="/inner-same"></iframe><iframe src="http://localhost:${port}/inner-cross"></iframe>`)
  if (req.url === '/inner-same') return page('same', `<button onclick="this.textContent='same clicked'">Same button</button>`)
  if (req.url === '/inner-cross') return page('cross', `<input aria-label="Card number"><button onclick="document.querySelector('p').textContent = 'paid ' + document.querySelector('input').value">Pay</button><p>unpaid</p>`)
  if (req.url === '/dialogs') return page('dialogs', `<p id="r">nothing yet</p>
    <button onclick="r.textContent = confirm('Delete it?') ? 'deleted' : 'kept'">Delete</button>
    <button onclick="r.textContent = 'hello ' + prompt('Your name?', 'x')">Name</button>`)
  if (req.url === '/popup') return page('popup', `<a href="/page/popped" target="_blank">open help</a>`)
  if (req.url === '/download') return page('download', `<a href="/file.txt">get file</a>`)
  if (req.url === '/file.txt') { res.setHeader('content-disposition', 'attachment; filename="file.txt"'); return res.end('hello file') }
  if (req.url === '/upload') return page('upload', `<input type="file" id="f" aria-label="Resume"><p id="o">no resume</p>
    <button onclick="g.click()">Attach</button><input type="file" id="g" style="display:none"><p id="o2">no attachment</p>
    <script>f.onchange = () => o.textContent = 'resume ' + f.files[0].name; g.onchange = () => o2.textContent = 'attached ' + g.files[0].name</script>`)
  if (req.url === '/scroll') return page('scroll', `${Array.from({ length: 20 }, (_, i) => `<p style="height:60px">row ${i}</p>`).join('')}<div id="end">end</div>
    <script>let n = 20; new IntersectionObserver(es => { if (!es[0].isIntersecting) return; for (let k = 0; k < 5; k++) { const p = document.createElement('p'); p.style.height = '60px'; p.textContent = 'row ' + n++; end.before(p) } }).observe(end)</script>`)
  if (req.url === '/hover') return page('hover', `<button onmouseenter="s.hidden = false">Products</button><ul id="s" hidden><li><a href="/x">Laptops</a></li></ul>`)
  if (req.url === '/ready') return page('ready', `<button id="b" disabled onclick="o.textContent = 'go clicked'">Go</button><p id="o">waiting</p>
    <button onclick="o.textContent = 'never'">Under the wall</button><div style="position:fixed;left:0;right:0;bottom:0;height:300px;background:#fff" aria-label="Cookie wall">wall</div>
    <script>setTimeout(() => b.disabled = false, 800); document.querySelector('[aria-label="Cookie wall"]').style.top = document.querySelectorAll('button')[1].getBoundingClientRect().top - 5 + 'px'</script>`)
  if (req.url === '/busy') return page('busy', `<button onclick="o.textContent = 'pressed'">Press</button><p id="o">idle</p><p id="t">0</p><script>setInterval(() => t.textContent = Date.now(), 50)</script>`)
  if (req.url === '/later') return page('later', `<p>loading</p><script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>ready now</p>'), 700)</script>`)
  if (req.url === '/api') return page('api', `<p id="o">loading</p><script>
    fetch('/api/items', { headers: { authorization: 'Bearer secret-token' } }).then(r => r.json()).then(j => o.textContent = j.items.join(', '))
    fetch('/collect?event=view'); navigator.sendBeacon('/beacon-in', 'x')</script>`)
  // One link and one form whose address is not a valid URL, among ordinary content.
  if (req.url === '/badlink') return page('badlink', '<p>Still readable.</p><a href="https://exa mple.com/">broken</a><a href="/about">About</a><form action="https://exa mple.com/go"><input name="q"></form>')
  // A page to read twice: a counter that changes one line, among lines that stay.
  if (req.url === '/counter') return page('counter', `<h1>Counter</h1>${'<p>A line that stays the same on every read of this page.</p>'.repeat(20)}<p id="c">count 0</p><button onclick="c.textContent = 'count ' + (+c.textContent.split(' ')[1] + 1)">Add</button>`)
  // A control the page replaces with a new element, as apps re-render a list.
  if (req.url === '/longrecords') return page('longrecords', `<ul>${Array.from({ length: 40 }, (_, i) => `<li><b>Item ${i}</b> <span>${'detail '.repeat(140)}</span></li>`).join('')}</ul>`)
  if (req.url === '/years') return page('years', `<p id="y">none</p>${[2022, 2023].map(n => `<button onclick="y.textContent = 'picked ${n}'">${n}</button>`).join('')}<button onclick="y.textContent = 'picked page'">Page 2023 of 2024</button>`)
  if (req.url === '/rerender') return page('rerender', `<p id="s">not yet</p><button id="t" onclick="s.textContent = 'hit'">Target</button><button onclick="t.replaceWith(t.cloneNode(true))">Swap</button>`)
  // Another site's request that never finishes (an ad server) beside the site's own data call.
  if (req.url === '/thirdparty') return page('thirdparty', `<p id="o">loading</p><script>fetch('http://localhost:${port}/hang').catch(() => {})
    fetch('/slow').then(r => r.text()).then(t => o.textContent = 'own data: ' + t)</script>`)
  if (req.url === '/hang') return
  // Too many requests once, then the page.
  if (req.url === '/busy-site') {
    if (!tooMany++) { res.statusCode = 429; res.setHeader('retry-after', '1'); return page('429', '<h1>Too Many Requests</h1>') }
    return page('busy-site', '<p>served after the wait</p>')
  }
  // Results already in the page but shown only after a moment, as some search pages do.
  if (req.url === '/shown-late') return page('shown-late', `<style>.off { display: none }</style><p>Search</p>
    <ol id="r" class="off">${Array.from({ length: 60 }, (_, i) => `<li>Result ${i}: a result long enough to count as content on this page</li>`).join('')}</ol>
    <script>setTimeout(() => r.classList.remove('off'), 900)</script>`)
  // A document whose end arrives late: what came first is still readable.
  if (req.url === '/slowdoc') { res.setHeader('content-type', 'text/html'); res.write('<title>slowdoc</title><p>first part</p>'); return void setTimeout(() => res.end('<p>last part</p>'), 4000) }
  // A banner over a control, with buttons that answer it.
  if (req.url === '/banner') return page('banner', `<button onclick="o.textContent = 'reached'">Behind</button><p id="o">not yet</p>
    <div id="b" style="position:fixed;inset:0;background:#fff"><p>We use cookies</p><button onclick="b.remove()">Reject all</button><button onclick="b.remove()">Accept all</button></div>`)
  // A field that rewrites what is typed, and one outside any form, where Enter does nothing.
  if (req.url === '/fields') return page('fields', `<input aria-label="Code" oninput="this.value = this.value.toUpperCase()"><input aria-label="Loose">`)
  // A custom dropdown: a combobox that opens a listbox of options.
  if (req.url === '/combo') return page('combo', `<div role="combobox" aria-haspopup="listbox" aria-expanded="false" tabindex="0" aria-label="Plan" id="c" onclick="l.hidden = false; c.setAttribute('aria-expanded', 'true')">Free</div>
    <div role="listbox" id="l" hidden>${['Free', 'Pro', 'Team'].map(p => `<div role="option" onclick="c.textContent = '${p}'; l.hidden = true; o.textContent = 'plan ${p}'">${p}</div>`).join('')}</div><p id="o">plan Free</p>`)
  const results = req.url?.match(/^\/results\/(\d)$/)
  if (results) return page(`results ${results[1]}`, `<header><a href="/">Home</a> <a href="/deals">Deals</a> <a href="/help">Help</a><p>Free delivery on every order</p></header><main><p>Page ${results[1]}</p>${'<button>Add to cart</button>'.repeat(+results[1])}</main><nav aria-label="Pagination"><a href="/results/${+results[1] + 1}">Next</a></nav>`)
  // A page laid out as three same-looking columns, each holding a region (a web app's shell): layout, not records.
  if (req.url === '/shell') return page('shell', ['<nav aria-label="Folders"><a href="/in">Inbox</a><a href="/sent">Sent</a></nav>',
    '<header><h2>Mail</h2><input aria-label="Search mail"></header>', '<main><h2>Hello</h2><p>The message.</p></main>']
    .map(r => `<div class="col"><p>part</p>${r}</div>`).join('') +
    // Cards that each hold a form (Add to cart) are still records.
    ['Lamp', 'Desk', 'Chair'].map(n => `<div class="card"><h3>${n}</h3><form aria-label="Add ${n}"><button>Add to cart</button></form></div>`).join(''))
  // An API answer longer than net show prints.
  if (req.url === '/catalog') return page('catalog', `<p id="o">loading</p><script>fetch('/api/catalog').then(r => r.json()).then(j => o.textContent = j.length + ' items')</script>`)
  if (req.url === '/api/catalog') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item ${i}` })))) }
  if (req.url === '/api/items') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ items: ['tea', 'coffee'] })) }
  if (req.url?.startsWith('/collect') || req.url === '/beacon-in') { res.statusCode = 204; return res.end() }
  if (req.url === '/where') return page('where', `<button onclick="navigator.geolocation.getCurrentPosition(p => o.textContent = 'at ' + p.coords.latitude, e => o.textContent = 'denied')">Locate</button><p id="o">unknown</p>`)
  if (req.url === '/signin') { res.setHeader('set-cookie', 'sid=signed-in; Path=/; Max-Age=3600'); return page('signin', '<p>signed in</p>') }
  if (req.url === '/who') return page('who', `<p>who: ${/sid=signed-in/.test(req.headers.cookie ?? '') ? 'signed in' : 'anonymous'}</p>`)
  if (req.url === '/reveal') return page('reveal', `
    <button aria-haspopup="menu" aria-expanded="false" aria-controls="m">Products</button>
    <ul id="m" role="menu" hidden><li role="menuitem">Laptops</li><li role="menuitem">Phones</li></ul>
    <details><summary>Shipping</summary><p>Ships in 2 days, free over ₹500</p></details>
    <button id="h">Deals</button><button onmouseenter="void 0">Inline hover</button><button>Plain</button>
    <script>h.addEventListener('mouseenter', () => {})</script>`)
  if (req.url === '/canvas') return page('canvas', `<canvas id="c" width="400" height="120"></canvas><script>
    const g = c.getContext('2d'); g.font = '14px sans-serif'
    g.fillText('stale', 10, 100); g.clearRect(0, 80, 400, 40)
    g.fillText('Name', 10, 20); g.fillText('Price', 200, 20); g.fillText('Tea', 10, 50); g.fillText('₹40', 200, 50)</script>`)
  if (req.url === '/menus') return page('menus', `
    <div role="menubar"><button aria-haspopup="menu" aria-expanded="false" data-m="file">File</button>
    <button aria-haspopup="menu" aria-expanded="false" data-m="edit">Edit</button></div>
    <button onclick="o.textContent = 'deleted'">Delete everything</button><p id="o">nothing done</p>
    <script>
      // Menus are built only when opened, as Google's are; Escape closes the newest one.
      const MENUS = { file: [['New'], ['Download', 'dl'], ['Print']], dl: [['CSV'], ['PDF']], edit: [['Undo'], ['Redo']] }
      const open = []
      function show(key, by) {
        by.setAttribute('aria-expanded', 'true')
        const m = document.createElement('div'); m.setAttribute('role', 'menu')
        for (const [name, sub] of MENUS[key]) {
          const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = name
          if (sub) { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); b.onclick = () => show(sub, b) }
          else b.onclick = () => { o.textContent = 'did ' + name; while (open.length) close() }
          m.append(b)
        }
        document.body.append(m); open.push([m, by])
      }
      function close() { const [m, by] = open.pop(); m.remove(); by.setAttribute('aria-expanded', 'false') }
      document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => show(b.dataset.m, b))
      addEventListener('keydown', e => { if (e.key === 'Escape' && open.length) close() })
    </script>`)
  if (req.url === '/form2') return page('form2', `<form onsubmit="event.preventDefault(); o.textContent = 'submitted ' + q.value">
    <input id="q" aria-label="Query"><input type="checkbox" aria-label="Agree">
    <div role="checkbox" aria-checked="false" tabindex="0" aria-label="Newsletter" style="width:16px;height:16px;border:1px solid" onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))"></div></form>
    <p id="o">nothing</p><input id="k" aria-label="Keys"><p>keydowns: <span id="kc">0</span></p>
    <script>k.addEventListener('keydown', () => kc.textContent = +kc.textContent + 1)</script>`)
  if (req.url === '/drag') return page('drag', `<div role="button" draggable="true" ondragstart="event.dataTransfer.setData('text', 'card A')">Card A</div>
    <section aria-label="Done" style="height:80px" ondragover="event.preventDefault()" ondrop="event.preventDefault(); r.textContent = 'dropped ' + event.dataTransfer.getData('text')">Done column</section>
    <div role="button" id="b2" onmousedown="window.held = true">Card B</div>
    <section aria-label="Later" style="height:80px" onmouseup="if (window.held) r.textContent = 'moved card B'">Later column</section><p id="r">nothing moved</p>`)
  if (req.url === '/store') return page('store', `<p>stored</p><script>localStorage.setItem('theme', 'dark'); sessionStorage.setItem('step', '2')</script>`)
  if (req.url === '/leave') return page('leave', `<input aria-label="Draft"><script>addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = '' })</script>`)
  if (req.url === '/poll') return void setTimeout(() => res.end('tick'), 1500)
  if (req.url === '/slow') return void setTimeout(() => res.end('slow data'), 800)
  if (req.url === '/channel') return page('channel', `<p id="o">ready</p>
    <button onclick="o.textContent = 'clicked'">Quick</button>
    <button onclick="fetch('/slow').then(r => r.text()).then(t => o.textContent = 'loaded ' + t)">Load</button>
    <script>(async function poll() { for (;;) await fetch('/poll').then(r => r.text()) })()</script>`)
  if (req.url === '/clicky') return page('clicky', `<div id="a">Open report</div><span onclick="o.textContent = 'inline'">Inline one</span>
    <div id="w"><button>Real button</button></div><div id="d">Delegated</div><p id="o">none</p>
    <script>a.addEventListener('click', () => o.textContent = 'report opened'); w.addEventListener('click', () => {})
      document.addEventListener('click', e => { if (e.target.id === 'd') o.textContent = 'delegated' })</script>`)
  if (req.url === '/parity') return page('parity', `<header><a href="/">Home</a><nav aria-label="Main"><a href="/a">About</a> <a href="/b">Blog</a></nav></header>
    <main><h1>Title</h1><p>Text with an <a href="/c">inline link</a>.</p>
    <form aria-label="Signup"><label for="e">Email</label><input id="e" type="email"><label><input type="checkbox" name="t"> Terms</label>
    <select aria-label="Plan"><option>Free</option><option>Pro</option></select><textarea aria-label="Note"></textarea><button>Join</button></form>
    <ul><li>One</li><li>Two</li></ul><table><tr><th>Name</th></tr><tr><td>A</td></tr></table></main><footer>© 2026</footer>`)
  if (req.url === '/mouse') return page('mouse', `<button ondblclick="o.textContent = 'double'" oncontextmenu="event.preventDefault(); o.textContent = 'context menu'">Target</button><p id="o">none</p>`)
  if (req.url === '/watch') {
    // Counts every DOM change that is not its own counter update.
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>watch</title><p>mutations: <span id="n">0</span></p><a href="/x">a link</a><input aria-label="field">
      <script>let n = 0; const out = document.getElementById('n')
      new MutationObserver(ms => { const mine = ms.filter(m => !out.contains(m.target)); if (mine.length) out.textContent = n += mine.length })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true })</script>`)
  }
  if (req.url === '/delta') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>delta</title>${Array.from({ length: 30 }, (_, i) => `<p>story ${i}</p>`).join('')}
      <button onclick="const p = document.createElement('p'); p.textContent = 'loaded more'; document.body.append(p)">More</button>
      <a href="/page/next">next page</a>`)
  }
  if (req.url === '/spa') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>spa</title>${Array.from({ length: 20 }, (_, i) => `<p>item ${i}</p>`).join('')}
      <button onclick="history.pushState({}, '', '/spa?step=2'); this.textContent = 'Step 2'">Next</button>`)
  }
  if (req.url === '/modal') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>modal</title><p>background text</p><button>behind</button>
      <dialog aria-label="Pick a city"><button>Delhi</button></dialog>
      <button onclick="document.querySelector('dialog').showModal()">Open</button>`)
  }
  if (req.url === '/long') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>long</title>${Array.from({ length: 600 }, (_, i) => `<p>line ${i} ${'x'.repeat(250)}</p>`).join('')}`)
  }
  if (req.url?.startsWith('/page/')) {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>${req.url.slice(6)}</title><p>page ${req.url.slice(6)}</p>`)
  }
  if (req.url === '/api/book') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      booked = JSON.parse(body).city
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ message: `Booked ${booked}, confirmation AL-7` }))
    })
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end(APP)
})

const home = mkdtempSync(join(tmpdir(), 'al-'))
// Short waits so the failure paths (covered, never quiet) are tested in seconds, not the defaults.
writeFileSync(join(home, 'policy.json'), JSON.stringify({ 'actions.timeoutMs': 1500, 'settle.deadlineMs': 2000, 'wait.timeoutMs': 3000, 'command.timeoutMs': 8000, 'load.domMs': 2000 }))
const upload = join(home, 'upload-test.txt')
writeFileSync(upload, 'resume')
// Deep enough that home/daemon.sock passes the ~104-byte Unix socket path limit.
const deepHome = join(home, 'deep', 'd'.repeat(110))

function runIn(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    // node --import tsx, not npx: npx is a .cmd script on Windows, which execFile cannot run.
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env: { ...process.env, BROWSER_LAYER_HOME: dir }, timeout: 120000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }))
  })
}

const run = (...args: string[]) => runIn(home, ...args)

// Kill every process whose command line contains `arg`: pkill where there is one, CIM on Windows.
const killByArgument = (arg: string) => new Promise(r => (process.platform === 'win32'
  ? execFile('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${arg.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], r)
  : execFile('pkill', ['-f', arg], r)))
// Opening answers with the page, or its map when long; these tests check page content, so they read it whole.
const openRead = async (url: string) => { await run('tab', url); return run('read', '--full') }

const ref = (out: string, what: RegExp) => {
  const m = out.match(new RegExp(`\\[(\\d+)\\] ${what.source}`))
  assert.ok(m, `no ref for ${what} in:\n${out}`)
  return m[1]
}

before(() => new Promise<void>(r => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  r()
})))
after(async () => {
  await run('stop')
  await runIn(deepHome, 'stop')
  // /hang never answers: its connection is closed here, or the server would wait on it forever.
  server.closeAllConnections()
  server.close()
  rmSync(home, { recursive: true, force: true })
})

test('plain fetch sees an empty shell', async () => {
  const { out } = await run('open', base)
  assert.doesNotMatch(out, /Plan a trip/)
})

test('a live tab runs the JS: type, pick a suggestion, click, read the result and the API under it', async () => {
  let r = await openRead(base)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Plan a trip/)
  assert.doesNotMatch(r.out, /hidden promo/)
  assert.match(r.out, /button "Book"\s+disabled/)

  r = await run('type', ref(r.out, /textbox "City"/), 'de')
  assert.match(r.out, /textbox "City"\s+= "de"\s+focused/)
  r = await run('click', ref(r.out, /option "Delhi"/))
  assert.match(r.out, /= "Delhi"/)
  r = await run('click', ref(r.out, /button "Book"/))
  assert.match(r.out, /Booked Delhi, confirmation AL-7/)
  assert.equal(booked, 'Delhi')

  r = await run('net')
  assert.match(r.out, /POST\s+200\s+\/api\/book\s+application\/json\s+body: \{"city":"Delhi"\}/)
})

test('a fast-path login survives live commands, and live tabs see it', async () => {
  await run('tab', `${base}/page/x`)
  await run('open', `${base}/login`)
  await run('read')
  let r = await run('open', `${base}/whoami`)
  assert.match(r.out, /fast cookie: yes/)
  r = await openRead(`${base}/whoami`)
  assert.match(r.out, /fast cookie: yes/)
})

test('sessions keep their own tabs and cannot touch each other', async () => {
  const a = await run('--session', 'a', 'tab', `${base}/page/alpha`)
  await run('--session', 'b', 'tab', `${base}/page/beta`)
  const aId = a.out.match(/^tab (\d+)/)![1]
  assert.match(a.out, /page alpha/)
  assert.match((await run('--session', 'b', 'read', '--full')).out, /page beta/)
  assert.doesNotMatch((await run('--session', 'b', 'tabs')).out, /alpha/)
  const r = await run('--session', 'b', 'use', aId)
  assert.equal(r.code, 1)
  assert.match(r.out, /belongs to session "a"/)
})

test('two commands from cold start one daemon, and both tabs live in it', async () => {
  await run('stop')
  const [one, two] = await Promise.all([run('--session', 'c', 'tab', `${base}/page/one`), run('--session', 'c', 'tab', `${base}/page/two`)])
  assert.equal(one.code, 0, one.out)
  assert.equal(two.code, 0, two.out)
  const tabs = (await run('--session', 'c', 'tabs')).out
  assert.match(tabs, /page\/one/)
  assert.match(tabs, /page\/two/)
})

test('the live view: one line per row, aria-hidden text without refs, hidden labels clipped, links only when useful', async () => {
  const { code, out } = await openRead(`${base}/view`)
  assert.equal(code, 0, out)
  assert.match(out, /^• 7:00 AM – 9:10 AM · IndiGo · ₹6,895$/m)
  assert.match(out, /^• 4:15 AM – 6:25 AM · SpiceJet · ₹7,118$/m)
  assert.match(out, /^## Stacked$\n^first line$\n^second line$/m)
  assert.match(out, /^BOM – DEL$\n^ghost$/m)
  assert.doesNotMatch(out, /button "ghost"|behind the dialog/)
  assert.match(out, /link → \/vote\?id=1/)
  assert.match(out, /link "About us"(?! →)/)
  assert.match(out, /link "Elsewhere" → example\.org/)
  // Its name is on screen inside longer text, only formatted differently: a visible name, never cut.
  assert.match(out, /link "Chhatrapati Shivaji Maharaj International Airport Mumbai \(BOM\)"/)
  const label = out.match(/button "(From 6895[^"]*)"/)
  // Its visible text is "Select"; the long name is a hidden label, so it gets the shorter cap.
  assert.ok(label && label[1].length === DEFAULTS['render.labelChars'] && label[1].endsWith('…'), out)
})

test('a page shows as a map of regions; read <ref> opens one region', async () => {
  await run('tab', `${base}/regions`)
  const map = await run('map')
  assert.match(map.out, /^\[\d+\] navigation "Main"\n  links: \[\d+\] link "Home" · \[\d+\] link "About"$/m)
  assert.match(map.out, /^\[\d+\] search\n  fields: \[\d+\] searchbox "Search flights"\n  actions: \[\d+\] button "Go"$/m)
  assert.match(map.out, /^\[\d+\] main\n  headings: Results\n  \[\d+\] list of 12: • Flight 0 · ₹100 …$/m)
  assert.doesNotMatch(map.out, /Flight 5/)
  const zoom = await run('read', ref(map.out, /main/))
  assert.match(zoom.out, /Flight 5 · ₹105/)
  assert.doesNotMatch(zoom.out, /About/)
})

test('get turns a list or table into records that line up, sort as numbers, and limit', async () => {
  await run('tab', `${base}/data`)
  const map = await run('map')
  const list = ref(map.out, /list of 4/)
  const table = ref(map.out, /table of 2: columns Name · Size/)
  const all = await run('get', list)
  assert.match(all.out, /\[\d+\] list: 4 records, 4 columns/)
  assert.match(all.out, /^c1\tc2\tc3\tc4$/m)
  // The badge gets its own column; it does not push airline or price out of theirs.
  assert.match(all.out, /^11:30 AM\tIndiGo\t₹9,500\t$/m)
  assert.match(all.out, /^1:05 PM\tAir India\t₹12,300\tBest$/m)
  const cheap = await run('get', list, '--sort', 'c3', '--limit', '2', '--cols', 'c2,c3')
  assert.match(cheap.out, /sorted by c3, first 2/)
  assert.match(cheap.out, /^c2\tc3\nAkasa\t₹980\nIndiGo\t₹9,500$/m)
  const dear = await run('get', list, '--sort', 'c3', '--desc', '--limit', '1', '--cols', 'c3')
  assert.match(dear.out, /^c3\n₹1,05,000$/m)
  const late = await run('get', list, '--sort', 'c1', '--desc', '--limit', '1', '--cols', 'c1')
  assert.match(late.out, /^c1\n10:00 PM$/m)
  const files = await run('get', table, '--sort', 'Size', '--cols', 'Name')
  assert.match(files.out, /^c1 Name\nb\.txt\na\.txt$/m)
  const bad = await run('get', list, '--sort', 'price')
  assert.equal(bad.code, 1)
  assert.match(bad.out, /no column "price"; columns are c1, c2, c3, c4/)
})

test('controls can be named instead of numbered; new records under an unchanged map are named', async () => {
  await run('tab', `${base}/paged`)
  const all = await run('get', ref((await run('map')).out, /table of 30/))
  assert.match(all.out, /30 records, 2 columns\n/)
  assert.match(all.out, /ORD-29\tPaid$/m)
  const next = await run('click', 'next')
  assert.match(next.out, /new records in \[\d+\] table, settled: idle in \d+ ms\n\n\+ \[\d+\] button "Next" focused.*\n\n\[\d+\] table: 30 records, 2 columns\n\nc1 Order\tc2 Status\nORD-30\tPaid$/m)
  assert.doesNotMatch(next.out, /ORD-29/)
  const vague = await run('click', 'del')
  assert.equal(vague.code, 1)
  assert.match(vague.out, /2 controls are named "del"; use a ref: \[\d+\] button "Delete" · \[\d+\] button "Delete all"/)
  assert.match((await run('click', 'nothing here')).out, /nothing is named "nothing here"/)
})

test('a long list an action reveals is one line; find and read go in', async () => {
  await run('tab', `${base}/longmenu`)
  const open = await run('click', 'Language: Any')
  assert.ok(open.out.length < 2000, open.out.slice(0, 300))
  assert.match(open.out, /\+ \[(\d+)\] menu of 900: \[\d+\] menuitemradio "Language 0" {2}unchecked · .* …$/m)
  assert.match(open.out, /a long list is one line: find <text> or read <ref> goes in/)
  assert.match((await run('find', 'Language 899')).out, /\[\d+\] menuitemradio "Language 899"/)
  assert.match((await run('read', open.out.match(/\[(\d+)\] menu of 900/)![1])).out, /"Language 100"/)
  // The map shows it the same way.
  assert.match((await run('map')).out, /\[\d+\] menu of 900: \[\d+\] menuitemradio "Language 0"/)
})

test('a page that refuses the browser says so, and how a person can clear it', async () => {
  assert.match((await run('tab', `${base}/refused`)).out, /\nblocked: the site refused this browser \(HTTP 403\)\. Do not solve or evade the check\. Try another normal way in first: .*If it stays blocked, a person can clear it: browser-layer show/)
  assert.doesNotMatch((await run('go', `${base}/longmenu`)).out, /blocked:/)
})

test('a daemon from another version (the CLI was updated) stops, and the next command starts a fresh one', async () => {
  await run('tab', `${base}/longmenu`)
  process.env.BROWSER_LAYER_HOME = home
  const { socketPath } = await import('../src/client.js')
  const reply = await new Promise<string>((done, fail) => request({ socketPath: socketPath(), method: 'POST', path: '/' }, res => {
    let body = ''
    res.on('data', d => (body += d)).on('end', () => done(body))
  }).on('error', fail).end(JSON.stringify({ cmd: 'tabs', session: 'default', version: '0.0.0' })))
  assert.deepEqual(JSON.parse(reply), { ok: false, stale: true })
  assert.match((await run('tabs')).out, /no live tabs/)
  assert.match((await run('tab', `${base}/longmenu`)).out, /"longmenu"/)
})

test('a page that stops answering does not stop the browser: the command says so, other tabs still work', async () => {
  await run('tab', `${base}/freeze`)
  const frozen = await run('click', 'Freeze')
  assert.match(frozen.out, /did not answer in 8 s/)
  assert.match((await run('tab', `${base.replace('127.0.0.1', 'localhost')}/longmenu`)).out, /"longmenu"/)
})

test('get --urls gives each record its links and pictures, each address once; plain get and reading leave them out', async () => {
  const list = (await run('tab', `${base}/products`)).out.match(/\[(\d+)\] list of 3/)![1]
  assert.doesNotMatch((await run('get', list)).out, /\/p\/1|\/img\//)
  const rows = (await run('get', list, '--urls')).out.split('\n').filter(l => /Lamp|Desk|Chair/.test(l))
  assert.match(rows[0], new RegExp(`→ ${base}/p/1\t.*${base}/img/1\.jpg`))
  assert.equal(rows[0].split(`${base}/p/1`).length, 2)
  assert.match(rows[1], new RegExp(`${base}/img/2\.jpg`))
  const file = join(mkdtempSync(join(tmpdir(), 'out-')), 'products.tsv')
  assert.match((await run('get', list, '--urls', '--out', file)).out, /saved .*products\.tsv: 3 records, \d+ columns/)
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 4)
  assert.doesNotMatch(rows[2], /data:|\/img\//)
  assert.doesNotMatch((await run('read')).out, /img\/1\.jpg|\/p\/1/)
})

test('images are not loaded until the agent allows them for a site', async () => {
  assert.match((await run('tab', `${base}/pictured`)).out, /image missing/)
  assert.match((await run('allow', 'images')).out, /allowed images for http:\/\/127\.0\.0\.1:\d+ \(reload to load them\)/)
  assert.match((await run('reload')).out, /image loaded/)
})

test('a whole-page screenshot taller than Chrome can capture stops at the limit and says so', async () => {
  await run('tab', `${base}/tall`)
  const file = join(mkdtempSync(join(tmpdir(), 'shot-')), 'tall.png')
  assert.match((await run('screenshot', file, '--full')).out, /saved .*tall\.png \(the first 16384 px of 30\d{3}\)/)
  assert.equal(readFileSync(file).readUInt32BE(20), 16384)
})

test('screenshot saves a PNG of the tab: the visible part, the whole page, or one region', async () => {
  const map = await run('tab', `${base}/longmenu`)
  const dir = mkdtempSync(join(tmpdir(), 'shot-'))
  const size = (file: string) => { const png = readFileSync(join(dir, file)); return [png.readUInt32BE(16), png.readUInt32BE(20)] }
  const shot = await run('screenshot', join(dir, 'a.png'))
  assert.equal(shot.out.trim(), `saved ${join(dir, 'a.png')}`)
  assert.equal(readFileSync(join(dir, 'a.png')).subarray(1, 4).toString(), 'PNG')
  assert.deepEqual(size('a.png'), [DEFAULTS['viewport.width'], DEFAULTS['viewport.height']])
  assert.equal((await run('screenshot', join(dir, 'b.png'), '--full')).code, 0)
  assert.ok(size('b.png')[1] > DEFAULTS['viewport.height'])
  // The button sits below 400 paragraphs, out of view: its picture is just its box.
  assert.equal((await run('screenshot', ref(map.out, /button "Language: Any"/), join(dir, 'c.png'))).code, 0)
  const [w, h] = size('c.png')
  assert.ok(w < 300 && h < 60, `${w}x${h}`)
  assert.match((await run('screenshot', '99999', join(dir, 'd.png'))).out, /\[99999\] is not on the page/)
  rmSync(dir, { recursive: true, force: true })
})

test('repeated cards without list markup are records; repeated paragraphs are not', async () => {
  await run('tab', `${base}/cards`)
  const map = await run('map')
  assert.match(map.out, /\[\d+\] list of 4: /)
  assert.doesNotMatch(map.out, /list of 5/)
  const cheap = await run('get', ref(map.out, /list of 4/), '--sort', 'c2', '--limit', '2')
  assert.match(cheap.out, /^c1\tc2\nAcer Aspire\t₹32,990\nDell 14\t₹41,500$/m)
  // The page reads as before: a detected collection does not turn cards into single lines.
  assert.match((await run('read', '--full')).out, /^### Acer Aspire\n₹32,990$/m)
})

test('reading never changes the page', async () => {
  await run('tab', `${base}/watch`)
  await run('read')
  const r = await run('read', '--full')
  assert.match(r.out, /mutations: 0/)
  assert.match(r.out, /\[\d+\] link "a link"/)
})

test('actions answer with what changed; a new page answers with its map', async () => {
  const full = await openRead(`${base}/delta`)
  assert.match(full.out, /story 5/)
  const more = await run('click', ref(full.out, /button "More"/))
  assert.match(more.out, /lines gone, \d+ new, settled: idle in \d+ ms \(full page: browser-layer read\)/)
  assert.match(more.out, /^\+ loaded more$/m)
  assert.doesNotMatch(more.out, /story 5/)
  assert.match((await run('read', '--full')).out, /story 5[\s\S]*loaded more/)
  const next = await run('click', ref(full.out, /link "next page"/))
  assert.match(next.out, /^tab \d+ .*\/page\/next/)
  assert.match(next.out, /— the whole page/)
})

test('a pushState URL change keeps refs and answers with changes', async () => {
  const page = await run('tab', `${base}/spa`)
  const next = ref(page.out, /button "Next"/)
  const step = await run('click', next)
  assert.match(step.out, /\/spa\?step=2 .*lines gone/)
  assert.match(step.out, new RegExp(`^\\+ \\[${next}\\] button "Step 2"`, 'm'))
})

test('an open modal dialog is the whole view', async () => {
  const page = await openRead(`${base}/modal`)
  assert.match(page.out, /background text/)
  const open = await run('click', ref(page.out, /button "Open"/))
  assert.match(open.out, /dialog "Pick a city" — the page behind it is not available/)
  assert.match(open.out, /button "Delhi"/)
  assert.doesNotMatch(open.out, /background text|button "behind"/)
})

test('long views come in pages and every page is reachable', async () => {
  const first = await openRead(`${base}/long`)
  assert.match(first.out, /\(page 1 of (\d+)\)/)
  const total = Number(first.out.match(/\(page 1 of (\d+)\)/)![1])
  assert.ok(total >= 2)
  assert.match(first.out, /more below: browser-layer read --page 2/)
  const last = await run('read', '--page', String(total))
  assert.match(last.out, /line 599 /)
  assert.doesNotMatch(last.out, /more below/)
  const past = await run('read', '--page', String(total + 1))
  assert.equal(past.code, 1)
  assert.match(past.out, /does not exist/)
})

test('a home dir deeper than the socket path limit still starts the daemon', async () => {
  mkdirSync(deepHome, { recursive: true })
  assert.equal((await runIn(deepHome, 'tab', `${base}/page/deep`)).code, 0)
  const r = await runIn(deepHome, 'read', '--full')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /page deep/)
})

test('reads and acts inside same-origin and cross-origin iframes', async () => {
  const all = await run('tab', `${base}/frames`)
  assert.match(all.out, /button "Same button"/)
  assert.match(all.out, /textbox "Card number"/)
  await run('type', ref(all.out, /textbox "Card number"/), '4242')
  const paid = await run('click', ref(all.out, /button "Pay"/))
  assert.match(paid.out, /paid 4242/)
  const same = await run('click', ref(all.out, /button "Same button"/))
  assert.match(same.out, /button "same clicked"/)
})

test('actions wait for a control to be ready, and say what blocks one', async () => {
  const page = await openRead(`${base}/ready`)
  const go = await run('click', ref(page.out, /button "Go"/))
  assert.match(go.out, /go clicked/)
  const wall = await run('click', ref(page.out, /button "Under the wall"/))
  assert.equal(wall.code, 1)
  assert.match(wall.out, /cannot act on \[\d+\]: covered by <div> "Cookie wall"/)
})

test('settle says why it stopped: idle, or the deadline on a page that never goes quiet', async () => {
  const page = await openRead(`${base}/busy`)
  const r = await run('click', ref(page.out, /button "Press"/))
  assert.match(r.out, /settled: deadline 2000 ms/)
  const quiet = await openRead(`${base}/mouse`)
  assert.match((await run('dblclick', ref(quiet.out, /button "Target"/))).out, /settled: idle in \d+ ms[\s\S]*double/)
  assert.match((await run('rightclick', ref(quiet.out, /button "Target"/))).out, /context menu/)
})

test('confirm and prompt wait for the agent, then the page continues', async () => {
  const page = await openRead(`${base}/dialogs`)
  const asked = await run('click', ref(page.out, /button "Delete"/))
  assert.match(asked.out, /a confirm dialog is open: "Delete it\?"/)
  assert.match((await run('dialog', 'accept')).out, /^deleted$/m)
  await run('click', ref(page.out, /button "Name"/))
  assert.match((await run('dialog', 'accept', 'Naman')).out, /hello Naman/)
  assert.match((await run('dialog', 'dismiss')).out, /no dialog is open/)
})

test('a pop-up opens as a tab in the same session and becomes current', async () => {
  const page = await openRead(`${base}/popup`)
  const r = await run('click', ref(page.out, /link "open help"/))
  assert.match(r.out, /opened tab \d+ \(a pop-up of tab \d+\); it is now current/)
  assert.match(r.out, /\/page\/popped/)
  assert.match(r.out, /page popped/)
})

test('downloads are saved and reported; uploads go through inputs and file choosers', async () => {
  const dl = await run('click', ref((await openRead(`${base}/download`)).out, /link "get file"/))
  const saved = dl.out.match(/downloaded (\S+) \(10 bytes\)/)
  assert.ok(saved, dl.out)
  assert.equal(readFileSync(saved[1], 'utf8'), 'hello file')
  const page = await openRead(`${base}/upload`)
  assert.equal((await run('upload', ref(page.out, /button "Resume"/), upload)).code, 0)
  assert.equal((await run('upload', ref(page.out, /button "Attach"/), upload)).code, 0)
  assert.match((await run('read')).out, /resume upload-test\.txt[\s\S]*attached upload-test\.txt/)
})

test('scroll brings in lazily loaded rows; hover reveals a menu; wait and eval', async () => {
  await run('tab', `${base}/scroll`)
  assert.match((await run('scroll', 'bottom')).out, /^\+ row 2[0-4]$/m)
  const menu = await openRead(`${base}/hover`)
  assert.match((await run('hover', ref(menu.out, /button "Products"/))).out, /link "Laptops"/)
  await run('tab', `${base}/later`)
  assert.match((await run('wait', 'ready now')).out, /ready now|no visible change/)
  assert.match((await run('eval', 'document.title')).out, /^"later"$/m)
  await run('go', `${base}/page/a`)
  await run('go', `${base}/page/b`)
  assert.match((await run('back')).out, /\/page\/a/)
  assert.match((await run('forward')).out, /\/page\/b/)
})

test('net lists the API the page used, hides trackers, and shows one request with secrets redacted', async () => {
  await openRead(`${base}/api`)
  const list = (await run('net')).out
  const item = list.match(/^#(\d+) +GET +200 +\/api\/items +application\/json$/m)
  assert.ok(item, list)
  assert.doesNotMatch(list, /collect|beacon-in/)
  assert.match((await run('net', '--all')).out, /\/collect\?event=view/)
  const one = (await run('net', 'show', item[1])).out
  assert.match(one, /authorization: <redacted>/)
  assert.doesNotMatch(one, /secret-token/)
  assert.match(one, /response body:\n\{"items":\["tea","coffee"\]\}/)
})

test('a result bigger than one answer goes whole to a file with --out; find pages through its matches', async () => {
  await run('tab', `${base}/longmenu`)
  const dir = mkdtempSync(join(tmpdir(), 'out-'))
  const read = await run('read')
  assert.match(read.out, /… more below: browser-layer read --page 2, or --out <file> for all \d+ pages/)
  // Of a page longer than one answer the agent saw only the first part, so reading it again is never a diff.
  assert.match((await run('read')).out, /\(page 1 of \d+\)/)
  assert.match((await run('read', '--out', join(dir, 'page.txt'))).out, /^saved .*page\.txt: 4\d\d lines, \d+ chars$/m)
  assert.equal(readFileSync(join(dir, 'page.txt'), 'utf8').split('\n').filter(l => l.includes('A repository description')).length, 400)
  const find = (await run('find', 'repository description', '--page', '2')).out
  assert.match(find, /^400 lines with "repository description" \(21–40\)/)
  assert.match(find, /… more: browser-layer find repository description --page 3, or --out <file> for all 400/)
  assert.match((await run('find', 'repository description', '--out', join(dir, 'hits.txt'))).out, /saved .*hits\.txt: 400 lines/)
  assert.equal(readFileSync(join(dir, 'hits.txt'), 'utf8').trim().split('\n').length, 400)
})

test('reading a page again answers with what changed since the last read; --full gives it all', async () => {
  assert.match((await run('tab', `${base}/counter`)).out, /count 0/)
  assert.match((await run('read')).out, /— no change since your last read \(read --full shows it again\)/)
  await run('click', 'Add')
  const again = (await run('read')).out
  assert.match(again, /— \d+ lines? gone, \d+ new since your last read \(read --full shows it all\)/)
  assert.match(again, /^- count 0$/m)
  assert.match(again, /^\+ count 1$/m)
  assert.doesNotMatch(again, /stays the same/)
  assert.match((await run('read', '--full')).out, /stays the same[\s\S]*count 1/)
})

test('a ref from another tab never acts on the current one: refs are unique across the browser', async () => {
  const add = ref((await run('tab', `${base}/counter`)).out, /button "Add"/)
  await run('tab', `${base}/products`)
  assert.match((await run('click', add)).out, new RegExp(`\\[${add}\\] is not on the page`))
})

test('tab on a page already open switches to its tab; tabs lists them by last use', async () => {
  await run('stop')
  await run('tab', `${base}/counter`)
  await run('tab', `${base}/products`)
  const again = (await run('tab', `${base}/counter`)).out
  assert.match(again, /^tab 1 .*\/counter .* — already open here, so this is that tab \(reload loads it again\)/m)
  const list = (await run('tabs')).out.trim().split('\n')
  assert.equal(list.length, 2)
  assert.match(list[0], /^\* 1 .*\/counter .* used \d+ s ago$/)
  assert.match(list[1], /^  2 .*\/products .* used \d+ s ago$/)
})

test('a region already shown, unchanged, is one line on the next page; read --full and read <ref> still show it', async () => {
  await run('stop')
  const first = (await run('tab', `${base}/results/1`)).out
  const banner = ref(first, /banner/)
  assert.match(first, /link "Deals"/)
  const second = (await run('click', 'Next')).out
  assert.match(second, new RegExp(`\\[${banner}\\] banner — shown before, unchanged`))
  assert.doesNotMatch(second, /"Deals"/)
  // What the next page showed is what the agent has: reading it again adds nothing.
  assert.match((await run('read')).out, /no change since your last read/)
  const third = (await run('click', 'Next')).out
  assert.match(third, new RegExp(`\\[${banner}\\] banner — shown before, unchanged`))
  assert.match(third, /Page 3/)
  assert.doesNotMatch(third, /Free delivery/)
  assert.match((await run('read', '--full')).out, /Free delivery/)
  assert.match((await run('read', banner)).out, /Free delivery/)
})

test('records never take more than one page of an answer, even with --limit', async () => {
  const list = ref((await run('tab', `${base}/longrecords`)).out, /list of 40/)
  const out = (await run('get', list, '--limit', '40')).out
  assert.ok(out.length < 16000, `${out.length} chars`)
  assert.match(out, /… \d+ more records: --limit, --cols, or --out <file> for all/)
})

test('a number that is no ref here clicks the control with exactly that name', async () => {
  await run('tab', `${base}/years`)
  await run('click', '2023')
  assert.match((await run('read')).out, /picked 2023/)
  assert.match((await run('click', '9999')).out, /\[9999\] is not on the page/)
})

test('an element keeps its ref when the page re-renders it', async () => {
  const target = ref((await run('tab', `${base}/rerender`)).out, /button "Target"/)
  await run('click', 'Swap')
  await run('click', target)
  assert.match((await run('read')).out, /hit/)
})

test('the same element on the next page keeps its ref; one that is no longer unique does not', async () => {
  const first = (await run('tab', `${base}/results/1`)).out
  const next = ref(first, /link "Next"/), add = ref(first, /button "Add to cart"/)
  const second = (await run('click', next)).out
  assert.match(second, /results\/2/)
  assert.match(second, /navigation "Pagination" — shown before, unchanged/)
  assert.equal(ref((await run('map')).out, /link "Next"/), next)
  assert.match((await run('click', add)).out, new RegExp(`\\[${add}\\] is not on the page`))
})

test('columns that hold parts of the page are layout, not records; cards that hold a form are records', async () => {
  await run('tab', `${base}/shell`)
  const map = (await run('map')).out
  assert.equal(map.match(/list of 3/g)?.length, 1)
  assert.match(map, /list of 3: ### Lamp/)
})

test('an API answer outlives the page that asked for it, and net save writes it whole', async () => {
  await openRead(`${base}/catalog`)
  const id = (await run('net')).out.match(/^#(\d+) +GET +200 +\/api\/catalog/m)![1]
  await run('go', `${base}/longmenu`)
  assert.match((await run('net', 'show', id)).out, /response body:\n\[\{"id":0,"name":"item 0"\}.*… \(\d+ more chars: browser-layer net save \d+ <file> writes it all\)/s)
  const file = join(mkdtempSync(join(tmpdir(), 'net-')), 'catalog.json')
  assert.match((await run('net', 'save', id, file)).out, new RegExp(`saved .*catalog\\.json \\(\\d+ bytes, application/json\\)`))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 500)
})

test('permissions are denied until allowed for the site; geolocation takes coordinates', async () => {
  const page = await openRead(`${base}/where`)
  const locate = ref(page.out, /button "Locate"/)
  assert.match((await run('click', locate)).out, /denied/)
  assert.match((await run('allow', 'geolocation', '19.07,72.87')).out, /allowed geolocation for http:\/\/127\.0\.0\.1:\d+ at 19\.07,72\.87/)
  assert.match((await run('click', locate)).out, /at 19\.07/)
})

test('a profile is a separate browser with its own tabs', async () => {
  await run('--profile', 'work', 'tab', `${base}/page/work`)
  assert.match((await run('--profile', 'work', 'tabs')).out, /page\/work/)
  assert.doesNotMatch((await run('tabs')).out, /page\/work/)
  await run('--profile', 'work', 'stop')
})

test('a session saved by a normal browser window on the agent profile carries into the agent browser', async () => {
  // What `browser-layer login` launches, headless here and quit through DevTools instead of by a person.
  const dir = mkdtempSync(join(tmpdir(), 'al-login-'))
  const found = await findBrowser()
  if ('error' in found) throw new Error(found.error)
  const chrome = spawn(found.path, [`--user-data-dir=${join(dir, 'profile')}`, ...PROFILE_FLAGS, '--no-first-run', '--no-default-browser-check', '--headless=new', '--remote-debugging-port=9335', `${base}/signin`], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 2500))
  const { chromium } = await import('playwright-core')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9335')
  await (await browser.newBrowserCDPSession()).send('Browser.close').catch(() => {})
  await new Promise(r => chrome.on('exit', r))
  await runIn(dir, 'tab', `${base}/who`)
  assert.match((await runIn(dir, 'read', '--full')).out, /who: signed in/)
  await runIn(dir, 'stop')
  rmSync(dir, { recursive: true, force: true })
})

test('switching the browser between visible and headless reopens every tab in its session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-show-'))
  await runIn(dir, 'tab', `${base}/page/one`)
  await runIn(dir, 'tab', `${base}/page/two`)
  await runIn(dir, '--session', 'b', 'tab', `${base}/page/three`)
  await runIn(dir, 'use', '1')
  // hide restarts headless; show would do the same with a window, which a test should not open.
  const r = await runIn(dir, 'hide')
  assert.match(r.out, /headless now\. Reopened:/)
  const tabs = (await runIn(dir, 'tabs')).out
  assert.match(tabs, /page\/two/)
  assert.match(tabs, /^\* \d+ +\S+\/page\/one/m)
  assert.match((await runIn(dir, '--session', 'b', 'tabs')).out, /page\/three/)
  await runIn(dir, 'stop')
  rmSync(dir, { recursive: true, force: true })
})

test('when the browser goes away (window closed, crash), the next command starts a fresh one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-gone-'))
  await runIn(dir, 'tab', `${base}/page/one`)
  // Quit this daemon's Chrome out from under it, as closing the last visible window does.
  await killByArgument(`user-data-dir=${join(dir, 'profile')}`)
  await new Promise(r => setTimeout(r, 1500))
  const again = await runIn(dir, 'tab', `${base}/page/two`)
  assert.equal(again.code, 0, again.out)
  assert.match(again.out, /page two/)
  await runIn(dir, 'stop')
  rmSync(dir, { recursive: true, force: true })
})

test('controls say what they reveal and whether they react to hover, before any trigger', async () => {
  const out = (await openRead(`${base}/reveal`)).out
  assert.match(out, /button "Products" collapsed reveals: Laptops · Phones/)
  assert.match(out, /button "Shipping" collapsed reveals: Ships in 2 days, free over ₹500/)
  assert.match(out, /button "Deals" reacts to hover/)
  assert.match(out, /button "Inline hover" reacts to hover/)
  assert.doesNotMatch(out, /button "Plain" reacts/)
})

test('text drawn on a canvas reads as lines, and text painted over is forgotten', async () => {
  const out = (await run('tab', `${base}/canvas`)).out
  const map = (await run('map')).out
  assert.match(map, /\[\d+\] canvas: 2 lines — Name · Price …/)
  assert.match(out, /^Name · Price\nTea · ₹40$/m)
  assert.doesNotMatch(out, /stale/)
  const rows = await run('get', ref(map, /canvas: 2 lines/), '--sort', 'c1', '--desc')
  assert.match(rows.out, /canvas: 2 records, 2 columns/)
  assert.match(rows.out, /^c1\tc2\nTea\t₹40\nName\tPrice$/m)
})

test('explore opens every declared menu, reads it, closes it, and never runs a command', async () => {
  await run('tab', `${base}/menus`)
  const map = (await run('map')).out
  assert.match(map, /closed menus and pop-ups: 2 \(browser-layer explore lists what they hold\)/)
  const out = (await run('explore')).out
  assert.match(out, /2 declared menus and pop-ups, each opened, read and closed/)
  assert.match(out, /^\[\d+\] File ▸ New · Download ▸ · Print$/m)
  assert.match(out, /^\[\d+\] File > Download ▸ CSV · PDF$/m)
  assert.match(out, /^\[\d+\] Edit ▸ Undo · Redo$/m)
  const after = (await run('read')).out
  assert.match(after, /nothing done/)
  assert.doesNotMatch(after, /menuitem/)
  assert.match((await run('menu', 'File > Download > CSV')).out, /did CSV/)
})

test('check and uncheck set a state; submit submits; --keys sends key events', async () => {
  const page = await openRead(`${base}/form2`)
  const agree = ref(page.out, /checkbox "Agree"/)
  await run('check', agree)
  await run('check', agree)
  assert.match((await run('read')).out, /checkbox "Agree"(?: \w+)* checked\b/)
  await run('uncheck', agree)
  assert.match((await run('read')).out, /checkbox "Agree"(?: \w+)* unchecked\b/)
  await run('check', ref(page.out, /checkbox "Newsletter"/))
  assert.match((await run('read')).out, /checkbox "Newsletter"(?: \w+)* checked\b/)
  const query = ref(page.out, /textbox "Query"/)
  await run('type', query, 'tea')
  assert.match((await run('submit', query)).out, /submitted tea/)
  const keys = ref(page.out, /textbox "Keys"/)
  await run('type', keys, 'abc')
  assert.match((await run('find', 'keydowns')).out, /keydowns: 0/)
  await run('type', keys, 'abc', '--keys')
  // A Backspace to clear the field, then one key per character, as a person replacing the text.
  assert.match((await run('find', 'keydowns')).out, /keydowns: 4/)
  assert.match((await run('find', 'no such words')).out, /is not on the page/)
})

test('drag works for HTML drag and drop and for pointer-based drags', async () => {
  const page = await openRead(`${base}/drag`)
  assert.match((await run('drag', ref(page.out, /button "Card A"/), ref(page.out, /region "Done"/))).out, /dropped card A/)
  assert.match((await run('drag', ref(page.out, /button "Card B"/), ref(page.out, /region "Later"/))).out, /moved card B/)
})

test('cookies list names without values and can be cleared; storage is listed and cleared', async () => {
  await openRead(`${base}/signin`)
  const jar = (await run('cookies', '127.0.0.1')).out
  assert.match(jar, /127\.0\.0\.1 {2}sid {2}\/ {2}until \d{4}-\d\d-\d\d/)
  assert.doesNotMatch(jar, /signed-in/)
  await run('cookies', 'clear', '127.0.0.1')
  assert.match((await openRead(`${base}/who`)).out, /who: anonymous/)
  await openRead(`${base}/store`)
  assert.match((await run('storage', 'local')).out, /^theme = dark$/m)
  assert.match((await run('storage', 'session')).out, /^step = 2$/m)
  await run('storage', 'local', 'clear')
  assert.match((await run('storage', 'local')).out, /localStorage is empty/)
})

test('a page that asks before it is left waits for the agent', async () => {
  const page = await openRead(`${base}/leave`)
  await run('type', ref(page.out, /textbox "Draft"/), 'unsaved')
  assert.match((await run('go', `${base}/page/after`)).out, /a beforeunload dialog is open/)
  assert.match((await run('dialog', 'accept')).out, /\/page\/after/)
})

test('a standing long-poll channel does not hold settle; requests the action starts still do', async () => {
  const page = await openRead(`${base}/channel`)
  const quick = await run('click', ref(page.out, /button "Quick"/))
  assert.match(quick.out, /settled: idle in \d+ ms/)
  assert.match(quick.out, /clicked/)
  const load = await run('click', ref(page.out, /button "Load"/))
  assert.match(load.out, /settled: idle in \d+ ms/)
  assert.match(load.out, /loaded slow data/)
})

test('elements made clickable only by a script get refs; wrappers and root listeners do not', async () => {
  const page = await openRead(`${base}/clicky`)
  assert.match(page.out, /clickable "Open report"/)
  assert.match(page.out, /clickable "Inline one"/)
  assert.match(page.out, /button "Real button"/)
  assert.doesNotMatch(page.out, /clickable "Real button"|clickable "Delegated"/)
  assert.match((await run('click', ref(page.out, /clickable "Open report"/))).out, /report opened/)
})

test('a link or form whose address is not a valid URL does not stop the page from reading', async () => {
  const out = (await run('open', `${base}/badlink`)).out
  assert.match(out, /Still readable\./)
  assert.match(out, /link "broken"/)
  assert.match(out, /link "About"/)
  await run('tab', `${base}/badlink`)
  const live = (await run('read', '--full')).out
  assert.match(live, /Still readable\./)
  assert.match(live, /link "broken"/)
})

test('open answers JSON compactly, says what it cut, and writes it all with --out', async () => {
  const shown = (await run('open', `${base}/api/catalog`)).out
  assert.match(shown, /^\[\{"id":0,"name":"item 0"\},\{"id":1/m)
  assert.match(shown, /… \d+ more chars: --out <file> writes it all$/m)
  const file = join(mkdtempSync(join(tmpdir(), 'open-')), 'catalog.json')
  assert.match((await run('open', `${base}/api/catalog`, '--out', file)).out, /^saved .*catalog\.json: \d+ chars$/m)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 500)
})

test('a static page reads the same over plain HTTP and in a live tab: same roles and names', async () => {
  const controls = (out: string) => [...out.matchAll(/\[\d+\] ([a-z]+)(?: "([^"]*)")?/g)].map(m => `${m[1]} ${m[2] ?? ''}`).sort()
  const fast = controls((await run('open', `${base}/parity`)).out)
  const live = controls((await openRead(`${base}/parity`)).out)
  assert.ok(fast.length >= 12, fast.join('\n'))
  assert.deepEqual(fast, live)
})

test('stale refs and missing tabs fail with a clear message', async () => {
  const none = await run('--session', 'empty', 'read')
  assert.equal(none.code, 1)
  assert.match(none.out, /no live tab in session "empty"/)
  await run('tab', `${base}/page/x`)
  const r = await run('click', '9999')
  assert.equal(r.code, 1)
  assert.match(r.out, /\[9999\] is not on the page/)
})

test('another site\'s requests do not hold a page; the site\'s own data call does', async () => {
  const t0 = Date.now()
  const r = await run('tab', `${base}/thirdparty`)
  assert.match(r.out, /own data: slow data/)
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`)
})

test('a short page answers whole when opened, and reading it next says nothing changed', async () => {
  const r = await run('tab', `${base}/page/whole`)
  assert.match(r.out, /— the whole page/)
  assert.match(r.out, /page whole/)
  assert.match((await run('read')).out, /no change since your last read/)
})

test('too many requests (429) waits as the site asks and loads the page again', async () => {
  const r = await run('tab', `${base}/busy-site`)
  assert.match(r.out, /HTTP 429\); loaded again after 1 s/)
  assert.match(r.out, /served after the wait/)
})

test('text already in the page but shown a moment later is waited for', async () => {
  assert.match((await run('tab', `${base}/shown-late`)).out, /Result 59/)
})

test('a document whose end is slow to arrive is read as far as it got', async () => {
  const r = await run('tab', `${base}/slowdoc`)
  assert.match(r.out, /still loading after 2 s/)
  assert.match(r.out, /first part/)
})

test('several pages open side by side in one call; the last is current', async () => {
  const r = await run('tab', `${base}/page/one`, `${base}/page/two`)
  assert.match(r.out, /page one[\s\S]*page two/)
  assert.match((await run('tabs')).out, /^\* \d+ +\S+\/page\/two/m)
})

test('steps runs several commands in one call: actions in one line, reads and the last in full', async () => {
  await run('tab', `${base}/form2`)
  const r = await run('steps', 'type Query "hello there"; press Enter; find submitted')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^1\. type Query "hello there"  → tab \d+ /m)
  assert.match(r.out, /^2\. press Enter  → tab \d+ /m)
  assert.match(r.out, /^3\. find submitted\n1 lines with "submitted"\n\nsubmitted hello there/m)
  const stop = await run('steps', 'click 99999; find submitted')
  assert.equal(stop.code, 1)
  assert.match(stop.out, /1\. click 99999  → error: \[99999\] is not on the page/)
  assert.match(stop.out, /stopped at step 1 of 2; the page now:/)
  assert.doesNotMatch(stop.out, /2\. find/)
})

test('a covered control names what covers it and the buttons that answer it', async () => {
  await run('tab', `${base}/banner`)
  const r = await run('click', 'Behind')
  assert.equal(r.code, 1)
  assert.match(r.out, /covered by <\w+> "We use cookies[^"]*"; its controls: "Reject all" · "Accept all" \(click one by name, then this again\)/)
  assert.match((await run('steps', 'click "Reject all"; click Behind')).out, /reached/)
})

test('typing says when the field holds something else, and when Enter did nothing', async () => {
  await run('tab', `${base}/fields`)
  assert.match((await run('type', 'Code', 'abc')).out, /note: \[\d+\] holds "ABC", not what was typed/)
  assert.match((await run('type', 'Loose', 'x', '--enter')).out, /note: Enter changed nothing on the page/)
})

test('pick opens a custom dropdown and chooses its option by name', async () => {
  await run('tab', `${base}/combo`)
  assert.match((await run('pick', 'Plan', 'Pro')).out, /plan Pro/)
  const none = await run('pick', 'Plan', 'Gold')
  assert.equal(none.code, 1)
  assert.match(none.out, /no option "Gold"; options: Free \| Pro \| Team/)
})

test('a ref the page re-rendered acts on the new element without looking again', async () => {
  const page = await openRead(`${base}/rerender`)
  const target = ref(page.out, /button "Target"/)
  await run('click', ref(page.out, /button "Swap"/))
  assert.match((await run('click', target)).out, /hit/)
})
