# Developer Toolbox

20 everyday developer utilities in one responsive, framework-free web app. HTML5 + CSS3 + vanilla ES modules — no build step, no backend, no database.

## Run locally

ES modules and `fetch` require HTTP (not `file://`). Use any static server from the project folder:

```bash
python -m http.server 8080     # or:  npx serve .   /   php -S localhost:8080
```

Open <http://localhost:8080>. Routing is hash-based (`#/tool/json-formatter`), so refreshing on any route works with any static server.

## Features

- Sidebar + top bar, dashboard (favorites, recently used, categories), All Tools catalog
- Global search (**Ctrl/Cmd + K**) by name, description, keyword, with category filter
- Light / dark theme, default editor font size and indentation, clear history, reset preferences (all persisted in `localStorage`)
- Responsive: desktop, tablet, mobile (off-canvas sidebar)

## Tools

| Category | Tools |
|---|---|
| JSON & Data | JSON Formatter · Data Converter (CyberChef-style) · JWT Decoder · Regex Tester · API Client |
| Text & Docs | Diff Checker · Markdown Editor · Markdown Viewer · Code Beautifier · SQL Formatter |
| Code Development | Prettier Playground · Code Image Generator · Base64 Converter |
| URL, Time & Utilities | URL Encoder/Decoder · Cron Generator · UUID Generator · Timestamp Converter |
| API & Database | Webhook Inspector · Table Converter · HTTP Status Reference |

## Features that need external services

Everything runs locally except:

| Feature | Dependency |
|---|---|
| Icons | Lucide via unpkg CDN |
| Markdown Editor / Viewer | marked, DOMPurify, highlight.js (CDN, loaded on demand). The viewer imports `render.js`/`logic.js` from the editor folder |
| Code Beautifier | js-beautify for HTML/CSS/JS formatting (CDN). JSON formatting and all minifiers work offline |
| Prettier Playground | Prettier standalone + plugins (CDN) |
| Code Image Generator | None — own tokenizer and canvas export, works offline |
| API Client | The target API must allow CORS. There is **no proxy**; CORS failures are explained, not bypassed |
| Webhook Inspector | A static page cannot receive HTTP requests. **Demo mode** simulates requests; an optional mode polls a third-party service (webhook.site) that you supply |

If a CDN is unreachable, the affected tool shows a clear message and the rest of the app keeps working.

## Known limits

- Diff Checker: no "ignore blank lines" option; near-total rewrites fall back to a replace-all diff (the UI says so).
- Cron Generator: next runs search 10 years ahead; rare schedules (e.g. `0 0 29 2 *`) may show fewer than 10 runs.
- Timestamp Converter: auto-detect treats values >= 1e11 as milliseconds; pick Seconds explicitly for huge second values.
- Regex Tester: patterns prone to catastrophic backtracking are paused until you click "Run anyway".
- Table Converter: SQL Server `N''` prefix and 1000-row chunking are unverified against a real database.
- Webhook Inspector: real mode relies on webhook.site's public API format; demo mode is simulated.

## Project structure

```
index.html            application shell
assets/css, assets/js shell styles, router, registry, storage, shared UI helpers
tools/<id>/           index.html (fragment) · tool.js · tool.css · logic.js (pure, DOM-free)
docs/architecture.md  tool contract and architecture
```

### Adding a tool
1. Create `tools/my-tool/{index.html,tool.css,tool.js}` (see [docs/architecture.md](docs/architecture.md)).
2. Register it in `assets/js/registry.js`.

`tool.js` exports `default { mount(root, ctx) }` and may return a cleanup function. Keep pure logic in `logic.js` so it can be tested in Node:

```bash
node --input-type=module -e "import('./tools/uuid-generator/logic.js').then(m => console.log(Object.keys(m)))"
```

## Browser support
Current Chrome, Edge, Firefox, Safari (ES2020+, `color-mix`, `crypto.subtle` on secure contexts — `localhost` counts).
