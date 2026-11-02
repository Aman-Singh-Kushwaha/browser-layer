# browser-layer

A terminal browser for AI agents. A page comes back as a short text map of its regions and controls,
every action answers with what changed, and lists and tables come back as records. The agent reads
text: no screenshots, no DOM dumps.

## Benchmark

Eight end-to-end tasks (six web apps plus Hacker News and GitHub): the same agent, model, prompt
and task for each tool, with only the browser CLI changing. Every answer is checked against ground
truth.

| | browser-layer | agent-browser 0.41.0 | playwright-cli 0.1.22 |
|---|---|---|---|
| Tasks passed | 8/8 | 8/8 | 8/8 |
| Tokens | **1.03M** | 1.97M | 1.91M |
| Steps | **47** | 64 | 83 |
| Time | **3.2 min** | 5.8 min | 4.9 min |

browser-layer used about half the tokens of either and the fewest steps, and was the cheapest on
7 of 8 tasks.

![Tokens per task: browser-layer, agent-browser, playwright-cli](https://raw.githubusercontent.com/NAMANIND/browser-layer/main/bench/charts/three-tools-tokens.png)

Agent: cursor-agent with `claude-sonnet-5-thinking-high`, one run per tool per task. Tasks, runner,
raw data and method: [github.com/NAMANIND/browser-layer](https://github.com/NAMANIND/browser-layer/blob/main/bench/RESULTS.md).

## Install

Needs Node.js 22 or newer, on macOS, Linux or Windows.

```bash
npm install -g browser-layer
browser-layer browser        # which browser it will drive
```

browser-layer drives a browser you already have: Google Chrome, then Microsoft Edge, then Chromium,
whichever it finds first (every Windows machine has Edge). To pick one, set `BROWSER_LAYER_BROWSER` to
its executable. On a machine with none, such as a server or a container, download Chromium once:

```bash
browser-layer install              # macOS, Windows, or Linux with the system libraries present
browser-layer install --with-deps  # Linux: also installs the libraries Chromium needs (uses sudo)
```

## Use

```bash
browser-layer tab google.com/travel/flights   # opens a live tab; answers with the page map
browser-layer type 15 Mumbai                  # answers with what changed
browser-layer click "Search"                  # a control by ref or by name
browser-layer read 231                        # one region in full
browser-layer get 233 --sort c11 --limit 3    # a list or table as records (TSV)
browser-layer net                             # the API calls the page made
browser-layer stop
```

`browser-layer help` lists every command. A background daemon keeps the browser and its tabs alive
between commands and exits after 30 idle minutes. Its state (profile, cookies, last page) lives in
`~/.browser-layer`, or `BROWSER_LAYER_HOME`.

**Fast path** (`open`, `do`, `verbs`): plain HTTP, no browser at all. It works when the content and
forms are in the HTML the server sends; pages built by JavaScript need a live tab.

**Signing in**: `browser-layer login <url>` opens a normal browser window on the agent's profile. You
sign in yourself (passwords, 2FA and passkeys stay with you), close it, and the agent stays signed in.

**Your own Chrome**: to use the browser you are already signed in with, run `browser-layer attach`. It opens
Chrome's `chrome://inspect/#remote-debugging` page, where you tick the box, and connects once; Chrome asks you to
click Allow. Then run commands with `--attach auto` (or `BROWSER_LAYER_ATTACH=auto`; `--attach <port>` for a Chrome
started with `--remote-debugging-port`). The agent works only in tabs of its own, never touches yours, keeps the one
connection (one Allow) until you `stop` it, and leaves Chrome running. It acts as you on every site you are signed
in to, so use it only when you want that.

**Watching**: `browser-layer show` turns the agent's browser into a visible window; `browser-layer hide`
makes it headless again. `browser-layer screenshot [ref]` saves a picture of the tab or one region
when a person wants one.

## Agent skill

Teach Claude Code, Codex, Cursor and other agents the workflow with one command:

```bash
npx skills add NAMANIND/browser-layer
```

## Develop

```bash
npm install
npm run build
npm test          # unit and live tests; the live tests drive the browser browser-layer finds
```

CI runs the build and every test on Linux, macOS and Windows with Node 22 and 24.

The reader's speed benchmark replays recorded pages of real sites. Those recordings stay on your
machine: make them once with `node bench/record-corpus.mjs`, then run `npm run measure`.

## License

Copyright 2026 Naman Rai. Licensed under Apache-2.0; see [LICENSE](LICENSE).
