# Developer Toolbox

40 everyday developer utilities in one responsive, framework-free web app. HTML5, CSS3 and vanilla ES modules: **no build step, no backend, no database.**
Tools process your input in the browser. The few that use the network (API Client, Weather Forecast, optional URL import and webhook polling, CDN libraries) are listed under
[External services](#dependencies-and-cdn-libraries).

## Run locally

ES modules and `fetch` need HTTP, not `file://`. Serve the project folder with any static server:

```bash
npm run serve                    # a tiny no-cache server (any static server also works)
```

Open <http://localhost:8080>. Routing is hash-based (`#/tool/json-formatter`), so a refresh or a pasted link works on any static host.
The app is deployed as Cloudflare static assets (`wrangler.jsonc`); `.assetsignore` keeps `tests/`, `docs/` and package files out of the deployment.

## Features

- Sidebar and top bar, dashboard (favorites, recently used, most used, recently updated, categories), All Tools catalog
- **Global search (Ctrl/Cmd + K, or `/`)**: fuzzy, typo tolerant, searches name, description, keywords and category, highlights matches, full keyboard control
- **Keyboard shortcuts** (press `?`): `g` then `d`/`t`/`f`/`r`/`s` to navigate, Alt+1…9 for your quick-access tools
- Light and dark themes, default editor font size and indentation, "Clear history" and "Reset preferences" (all stored in `localStorage`)
- Responsive layout from desktop to 375 px phones, off-canvas navigation, keyboard and screen-reader support
- A shared code editor (line numbers, highlighting, find and replace, wrap, font size, fullscreen, drag and drop) and resizable panels in ten tools

## Tools

| Category | Tools |
|---|---|
| JSON & Data (8) | JSON Formatter · Data Converter · JWT Decoder · Regex Tester · Saltbox · API Client · XML Formatter & Validator · YAML Formatter & Validator |
| Text & Docs (10) | Text Pad · CV Builder · Test Case Manager · Word Editor* · Diff Checker · Markdown Editor · Markdown Viewer · Code Beautifier · SQL Formatter · HTML Entity Converter |
| Code Development (4) | Prettier Playground · Code Image Generator · Base64 Converter · TypeScript Interface Generator |
| URL, Time & Utilities (7) | URL Encoder / Decoder · Cron Generator · UUID Generator · Weather Forecast · Timestamp Converter · Git Command Generator · Chmod Calculator |
| API & Database (6) | Webhook Inspector · Table Converter · HTTP Status Codes · SQL Query Analyzer · OpenAPI / Swagger Viewer · cURL Converter |
| Files & Media (4) | Excel Editor* · Image Converter · File Hash Generator · QR Code Generator & Reader |
| Web Development (3) | HTML/CSS/JS Playground · Color Converter · HTTP Header Analyzer |

\* **Standalone apps.** Excel Editor and Word Editor (Folio) are self-contained pages in `tools/excel-editor/` and `tools/word-editor/` with their own interface and bundled libraries (ExcelJS, SheetJS, JSZip, CFB, mammoth). The toolbox only links to them (they open in a new tab) and shares no code or UI with them. To add another one, use `link(...)` instead of `t(...)` in `assets/js/registry.js`.

Highlights: JSON (tree explorer, JSONPath, JSON Schema validation, diff, TypeScript, sample data) · JWT (security warnings, claim descriptions, signature verification
that never implies the claims are valid) · API Client (collections, environments, auth helpers, cURL and Postman import/export) · Regex (47 templates, mistake checker,
code export, runs in a worker with a timeout) · Markdown (TOC, Mermaid, front matter, safe preview) · Diff (exact on huge files, character level, folding).

## Architecture

The shell loads each tool on demand from `tools/<id>/`. A tool is an independent child project (its own HTML fragment, CSS, JavaScript and pure logic) that the
shell knows only through one entry in `assets/js/registry.js` and one small contract: `export default { mount(root, ctx) }`, returning an optional cleanup.
The shell provides the lifecycle (abortable loading, automatic cleanup of debounces and listeners registered through `ctx`, a retry panel when loading fails), so a tool
that follows the contract cannot leak or leave timers behind. Full details are in [docs/architecture.md](docs/architecture.md).

```
index.html                  shell markup
assets/css/                 design tokens (themes.css, light and dark), layout, components, editor
assets/js/app.js            shell: dashboard, catalog, settings, search, shortcuts, tool loader
assets/js/router.js         hash router
assets/js/registry.js       tool and category registry, validation, fuzzy search
assets/js/storage.js        localStorage wrapper and settings
assets/js/components/       ui.js (shared helpers), editor.js + editor-core.js, split.js
assets/js/shared/           pure modules reused by several tools (jsonpath, json-schema, json-diff, ts-interfaces, curl, sql-analyzer, sql-json)
assets/js/vendor/           vendored third-party libraries with their licences
tools/<id>/                 index.html (fragment) · tool.css · tool.js · logic.js (pure) · optional worker.js
tests/unit/                 Node tests for pure logic
tests/browser/              Chrome DevTools Protocol smoke, accessibility and leak checks
docs/                       architecture.md · IMPROVEMENT_REPORT.md · TEST_REPORT.md
```

## Adding a tool

1. Create `tools/my-tool/` with `index.html`, `tool.css`, `tool.js` and, for logic, `logic.js`. Scope **every** CSS selector under `.tool-my-tool`.
2. `tool.js`: `export default { mount(root, ctx) { /* build the UI */ return () => { /* cleanup */ }; } }`. `ctx` gives you `ui`, `storage`, `settings`,
   `signal`, `onCleanup` and `debounce` (see the architecture doc).
3. Add `tests/unit/my-tool.test.mjs` for the pure logic.
4. **Register it**: add one line to `TOOLS` in `assets/js/registry.js`:

   ```js
   t('my-tool', 'My Tool', 'One-sentence description.', 'utility', 'wrench', ['keyword', 'another'])
   ```

   The id must match the folder name, the category must exist in `CATEGORIES`, and the icon must be a Lucide name. After using a new icon run `node scripts/build-icons.mjs` to add it to `assets/js/icons.js` (`tests/unit/icons.test.mjs` fails if one is missing). `npm test` fails if the registry is invalid or a file is missing.
5. Run `npm test`, then `npm run serve` and `npm run test:browser`. The browser sweep fails if the new tool logs an error, overflows at 375 px, has no icon, or has unlabelled controls.

## Dependencies and CDN libraries

The app itself has **no build step and no runtime dependency to install**. Libraries are loaded lazily, only by the tool that needs them. If one cannot load, that tool
shows a clear message and everything else keeps working.

| Library | Used by | Source |
|---|---|---|
| Lucide 0.468 (icons) | the shell | bundled: only the icons used, inline in `assets/js/icons.js` (no CDN) |
| marked 12.0.2, DOMPurify 3.1.6, highlight.js 11.9.0 | Markdown Editor and Viewer | jsDelivr, cdnjs |
| Mermaid 10.9.1 | Markdown Editor and Viewer, only when a diagram is present | jsDelivr |
| js-beautify 1.15.1 | Code Beautifier (HTML, CSS, JavaScript) | cdnjs |
| Prettier 3.3.3 and plugins | Prettier Playground | jsDelivr |
| js-yaml 4.1.1, qrcode-generator 2.0.4, jsQR 1.4.0 | YAML Formatter, OpenAPI Viewer, QR Code | **vendored** in `assets/js/vendor/` with licences |
| SheetJS 0.20.3 | Test Case Manager (.xlsx import/export) | **vendored** in `assets/js/vendor/`, loaded only when an .xlsx file is read or written |

Other network use: the Weather Forecast fetches live forecasts from the public Open-Meteo API, plus disaster alerts from GDACS (cyclones, floods) and the USGS earthquake catalogue (no keys; responses cached 10 minutes in `localStorage`; Vietnamese agencies NCHMF/VNDMA have no browser-readable API and are linked as the authority to confirm with), the API Client sends the requests you ask for (the target must allow CORS; there is **no proxy**), the OpenAPI Viewer can fetch a spec from a URL you
enter, and the Webhook Inspector can poll a service you supply (its demo mode is simulated). The Code Image Generator, Image Converter, QR Code, File Hash Generator and
most other tools work fully offline.

## Testing

```bash
npm install            # jsdom, dompurify and marked (pinned), for the Markdown DOM tests only
npm test               # 51 suites, about 1,958 tests of the pure logic, plus Saltbox's crypto vectors
npm run serve          # in a second terminal
npm run test:browser   # every tool in real Chrome: desktop/light and 375 px mobile/dark, no console errors, no overflow, labelled controls
npm run test:leaks     # memory leak and duplicate-listener check for tool switching
```

See [docs/TEST_REPORT.md](docs/TEST_REPORT.md) for results, methodology, known limitations and what has not been verified, and
[docs/IMPROVEMENT_REPORT.md](docs/IMPROVEMENT_REPORT.md) for the audit that drove this work.

## Browser support

Targets current Chrome, Edge, Firefox and Safari: ES2022 modules, module workers, `:has()`, `color-mix()`, and `crypto.subtle` on secure contexts (`localhost` counts).
**Only Chrome 155 has been tested.** Features that depend on newer browser APIs have fallbacks in code (Fullscreen API, `BarcodeDetector`, `EyeDropper`, WebCrypto
with a pure-JS hash path for large files), but those fallbacks have not been exercised in other browsers.

## Security considerations

- **No `eval` or `new Function`**, and untrusted data is rendered with `textContent` or escaped; Markdown is sanitised with a hardened DOMPurify configuration
  (no `<style>`, forms or buttons, and user-supplied ids and names are prefixed). The OpenAPI Viewer and HTTP Header Analyzer render documents as text.
- **The HTML/CSS/JS Playground runs your code in an `<iframe sandbox="allow-scripts">` without `allow-same-origin`**, with a restrictive Content-Security-Policy meta,
  so it cannot read the app's storage, cookies or page, or make network requests (unless you explicitly relax external resources).
- **Decoding is not verifying.** The JWT Decoder says so everywhere; signature verification is a separate, explicit step that refuses `alg: none` and key and algorithm
  mismatches, and keys are never stored.
- **Secrets**: the API Client and Webhook Inspector redact sensitive headers in stored history by default; the JWT tool, Saltbox and the hash tools do not persist keys.
  Request URLs and bodies in API Client history are stored as typed, and environment secret values are stored unencrypted in `localStorage`; the UI says so.
- **Test Case Manager** keeps its test cases in this browser's IndexedDB (not `localStorage`), so "Clear history" does not remove them; delete them in the tool or clear site data. Imported cells are rendered as text only, and exported CSV cells that start with `=`, `+`, `-` or `@` get a leading `'` so spreadsheets do not run them as formulas.
- **Heuristic tools** (SQL analysis, security header review, regex mistake checker, Git danger notes) are static advice. They never run queries, commands or requests,
  and each says so on screen.
- **Open items**: CDN scripts are loaded without Subresource Integrity hashes and there is no Content-Security-Policy for the app itself. Several tools remember their last
  input in `localStorage` (clear it under Settings, "Clear history"). Details in [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Known limits

See [docs/TEST_REPORT.md](docs/TEST_REPORT.md), section 7, for the full list. In short: YAML Formatter drops comments (it asks first); the Cron Generator's
daylight-saving handling was tested only for one time zone; PBKDF2 in Saltbox cannot be cancelled; the HTML entity table is a 312-entry subset of the HTML5 list;
hash routes discard query strings.
