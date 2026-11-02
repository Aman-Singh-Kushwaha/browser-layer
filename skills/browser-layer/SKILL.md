---
name: browser-layer
description: >-
  Browse and act on websites from the terminal with the browser-layer CLI: open pages, read them
  as a short text map, click, type, fill forms, read lists and tables as records, follow pagination,
  download files, and see the API calls a page makes. Use for any task on a website — research,
  extracting data, filling forms, testing a web app, checking a flow — instead of curl, scraping
  HTML by hand, or screenshots.
license: Apache-2.0
compatibility: Requires Node.js 22+, the browser-layer npm package, and Chrome, Edge or Chromium (browser-layer install downloads Chromium). Needs network access.
metadata:
  author: Naman Rai
  homepage: https://github.com/NAMANIND/browser-layer
allowed-tools: Bash(browser-layer:*)
---

# browser-layer

A browser for agents. A page comes back as a short text map of its regions and controls, every
action answers with what changed, and lists and tables come back as records. Read the page as
text; never ask for pixels to understand it.

Install once with `npm install -g browser-layer` (Node.js 22+); `browser-layer install` gets a
browser if none is found. `browser-layer help` lists every command.

## The loop: one call per decision

Work as a person at a browser does: look, decide, do everything you decided, look at the result.
Every call costs you a turn, so make each call one decision, and come back only when the next step
depends on something you cannot see yet.

1. `browser-layer tab <url>` opens a page and answers with its **map**: regions, fields, actions,
   lists and links, each with a ref like `[15]`. Need its text too? `tab <url> && browser-layer read`
   in the same call. Keep one tab per site and switch with `use <id>` (nothing reloads; `tabs` lists
   them); move within a site with `go <url>`.
2. Act on a ref or a control's name: `click 31`, `click "Next"`, `type 15 Mumbai --enter`,
   `pick 22 "Economy"`, `check 40`. Every action answers with **what changed** or the new page, with
   the refs of anything it opened (options, a dialog, a date grid), and says when something did not
   take. That answer is the new state: no need for `map` or `read` after it.
3. **Do what you already know in one call** with `steps`: actions answer in one line, reads and the
   last step in full, and the first error stops the rest and shows the page as it is then.
4. Go deeper only where you need to: `read <ref>` for one region, `find <text>` for the lines that
   mention something, `get <ref>` for a list or table as records (`--urls` adds their addresses).

```text
$ browser-layer tab shop.example.com
[40] main
  fields: [12] searchbox "Search"
  actions: [13] button "Search"
$ browser-layer steps 'type 12 "desk lamp" --enter; pick "Sort" "Price: low to high"; get 52 --limit 3'
1. type 12 "desk lamp" --enter  → tab 1  https://shop.example.com/s?q=desk+lamp — the whole page changed
2. pick "Sort" "Price: low to high"  → tab 1  https://shop.example.com/s?q=desk+lamp&sort=price — 30 lines gone, 30 new
3. get 52 --limit 3
[52] list: 48 records, 3 columns (first 3)
c1 Name	c2 Price	c3 Rating
Clip lamp	₹499	4.1
```

## Habits

- Put filters in the URL when the site does (`?q=python&page=2`); `wait "<text>"` when content loads
  late; `open <url>` for a static page that needs no JavaScript.
- The data usually comes from an API: `net` lists the calls, `net show <#>` previews one,
  `net save <#> data.json` writes it whole. More pages from the same API:
  `eval "await (await fetch('/api/x?page=2')).json()" > p2.json` (the site's own cookies go along).
- A big result goes to a file, not your context: `get <ref> --out rows.tsv`, `find <text> --out
  hits.txt`, `read --out page.txt`; then `grep`, `jq` or a script.
- A list is complete only when you can show it ended: the site's total matches, the last page has
  no Next, or `scroll` brings nothing new three times. Until then say how many of how many.
- After a filter or search, its answer shows whether the results, their count or the URL changed.
  When the site drops a setting you were given, set it another way (its own controls, the URL as it
  writes it). Add no filters of your own.
- Follow the site's links and its own search rather than guessing deep URLs.
- A field with suggestions (a city, a product search) opens a list as you type: choose from it
  (`click` the option, or `press Enter` for the first) before the next field, in the same call:
  `steps 'type "From" Zurich; press Enter; type "To" London; press Enter'`.
- **Deliver as you go.** Write the deliverable itself early and update it with each finding, so
  stopping at any moment still leaves your best result. Mark what you have not checked as
  unchecked; never fill it in.
- **Know when to stop.** When two different ways to the same thing have failed, report it as
  unavailable and move on; do not repeat the same kind of attempt.

## Answers you will see

- `blocked: …` — the site refused this browser or shows a CAPTCHA. Never solve or evade it. A block
  often covers one page: try the site's home page or search, another URL for the same content, its
  API or sitemap, or another source. If it stays blocked, a person can clear it: `browser-layer show`,
  then `hide`. Report what you could not reach as unavailable, never as empty.
- `covered by <div> "…"; its controls: "Reject all" · …` — a pop-up is over the control: answer it
  and go on in one call, `steps 'click "Reject all"; click 31'`, or `press Escape`.
- `note: …` — something did not take (a field holds other text, Enter did nothing): act on it
  directly, such as clicking the form's own button.
- A page whose content is pictures (a scanned book, a map, a video) or that asks you to turn off an
  ad blocker: `allow images`, then `reload`.

## When a person is involved

- **Sign-in:** never type passwords. The person runs `browser-layer login <url>` and signs in there.
- **Irreversible steps** (submit, pay, send, delete): confirm first unless they already said to.
- `screenshot [ref] [file] [--full]` saves a picture when a person wants one.
- Several agents at once: give each its own `--session <name>`.

`browser-layer stop` closes the browser when the task is over.
