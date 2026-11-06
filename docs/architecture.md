# Architecture

Developer Toolbox is a static, build-free single-page application: HTML, CSS and ES modules, no framework and no backend. The shell
(navigation, dashboard, search, settings) loads each tool on demand from its own folder. A tool is an independent child project that
the shell knows about only through one registry entry and one small contract.

This file is `architecture.md` (lower case) on purpose: a second `ARCHITECTURE.md` would collide with it on case-insensitive file systems (Windows, macOS).

## 1. Layout

```
index.html                  application shell markup (sidebar, top bar, <main id="main">, live region, skip link)
assets/
  css/                      themes.css (design tokens), main, layout, components, responsive, editor.css
  js/
    app.js                  shell: dashboard, catalog, settings, search palette, shortcuts, tool loader and lifecycle
    router.js               hash router
    registry.js             tool and category registry, validation, fuzzy search
    storage.js              localStorage wrapper and the settings store
    components/
      ui.js                 shared helpers for the shell and every tool
      editor.js, editor-core.js   shared code editor (textarea based) and its pure logic
      split.js              resizable two-panel splitter
    shared/                 pure modules reused by several tools (jsonpath, json-schema, json-diff, ts-interfaces,
                            curl, sql-analyzer, sql-json); no DOM, unit-tested in Node
    vendor/                 third-party libraries that are checked in, with their licences (js-yaml, qrcode-generator, jsQR)
  icons/favicon.svg
tools/<id>/                 one independent child project per tool (index.html, tool.js, tool.css, logic.js, ...)
tests/
  unit/                     Node tests for pure logic (run by tests/run-all.mjs)
  browser/                  Chrome DevTools Protocol harness, smoke and accessibility sweep, leak check
docs/                       this file, IMPROVEMENT_REPORT.md, TEST_REPORT.md
wrangler.jsonc, .assetsignore   Cloudflare static-assets deployment (tests, docs and package files are excluded)
```

## 2. The tool contract

Every `tools/<id>/` folder contains:

| File | Purpose |
|---|---|
| `index.html` | An HTML **fragment** (no `<html>` or `<body>`), injected into the tool root. |
| `tool.css` | Styles. **Every selector is scoped under `.tool-<id>`**, the class on the root element. Colours come only from the CSS variables in `themes.css`, so tools follow the theme. |
| `tool.js` | An ES module with `export default { mount(root, ctx) }`. It may return a cleanup function (or register cleanups with `ctx.onCleanup`). |
| `logic.js` | Recommended. Pure functions with no DOM access, importable from Node for testing. |
| `worker.js` | Optional. A module worker for heavy work, started with `new URL('./worker.js', import.meta.url)`. Always keep an in-thread fallback. |

`ctx` passed to `mount(root, ctx)`:

| Property | Meaning |
|---|---|
| `toolId`, `meta` | The tool's id and its registry entry (name, description, category, version, updated, note). |
| `ui` | The shared helpers from `components/ui.js` (`el`, `escapeHtml`, `copyText`, `downloadFile`, `toast`, `confirmDialog`, `openModal`, `initTabs`, `bindActions`, `pickFile`, `enableDrop`, `loadScript`, `withLoading`, `showMessage`, `debounce`, ...). |
| `storage` | A key-value store scoped to this tool (`get`, `set`, `remove`), persisted in `localStorage` under `devtoolbox:tool:<id>:<key>`. "Clear history" in Settings removes it. `set` returns `false` when the browser refuses (quota, blocked storage). |
| `settings` | The app settings (`theme`, editor `fontSize`, `indent`) and a change subscription. |
| `indentUnit`, `fontSize` | The user's defaults, read when the tool opens. |
| `signal` | An `AbortSignal` that is aborted when the user leaves the tool. Pass it to `fetch`. |
| `onCleanup(fn)` | Register a cleanup. Cleanups run in reverse order when the tool is unmounted. |
| `debounce(fn, ms)` | `ui.debounce`. Debounces created while a tool is mounted are cancelled automatically on unmount. |

## 3. Tool lifecycle

```
user navigates (hashchange)
  -> route(): bump mountToken, dispose the previous tool, clear the debounce scope
  -> viewTool(id): count the open (not on re-renders), draw the page header, a loading block, a root element
  -> mountTool(tool, root):
       create a lifecycle { AbortController, cleanups[], debounces[] }
       fetch tools/<id>/index.html (15 s timeout, abortable) and load tools/<id>/tool.css once   -- in parallel
       dynamic import of tools/<id>/tool.js
       if the user already navigated away -> dispose the lifecycle and stop
       root.innerHTML = fragment; build ctx; await mount(root, ctx)
       register the returned cleanup; render icons
  on any failure -> an error panel with the reason, Retry (re-imports with a cache-busting query) and "Browse all tools"
  on the next navigation -> lifecycle.dispose(): abort the signal, cancel debounces, run every cleanup (each in a try/catch)
```

Guarantees the shell provides, so tools do not each re-implement them:
- A stale or half-finished mount never touches the DOM or leaks: a `mountToken` check disposes it.
- Debounced handlers never fire after unmount, and in-flight `fetch` calls tied to `ctx.signal` are aborted.
- A failing cleanup does not stop the others.
- A tool that throws while mounting still has its partial cleanups run.
- The tool stylesheet loader is a module-level function whose handlers are cleared after loading, so the long-lived `<link>` element in `<head>` retains
  nothing from a mount (this was a real leak; see `TEST_REPORT.md`).

What a tool must do itself: remove listeners it attaches to `document`, `window` or other long-lived targets; stop timers, workers, camera streams and object URLs;
call `destroy()` on shared editors and splitters. Listeners on elements inside the tool root need no removal, because the root is discarded.

## 4. Routing

`router.js` is a minimal hash router, so a page refresh or a pasted link works on any static host:

| Hash | View |
|---|---|
| `#/` | Dashboard |
| `#/tools`, `#/favorites`, `#/recent` | Catalog views |
| `#/category/<id>` | Catalog filtered by category |
| `#/tool/<id>` | A tool |
| `#/settings`, `#/about` | App pages |

Unknown routes show a "not found" page with a link back. After each navigation the shell moves focus to `<main>` and announces the page title in a polite live
region. Known limitation: anything after `?` in the hash is discarded, so tools cannot use query parameters in the URL.

## 5. The registry

`registry.js` is the single source of truth for what exists:

```js
t('chmod-calculator', 'Chmod Calculator', 'One-sentence description.', 'utility', 'lock-keyhole', ['chmod', 'permissions', ...])
```

Fields: `id`, `name`, `description`, `category`, `icon` (a Lucide icon name), `keywords`, plus `entry` (derived), `version`, `updated` and `note` (release notes,
shown on the dashboard's "Recently updated" row). `validateRegistry()` checks ids, categories, required fields and dates, and `tests/unit/registry.test.mjs`
also checks that every registered tool has its `index.html`, `tool.js` and `tool.css`.

Search (`searchToolsDetailed`) is fuzzy: every query word must match, ranked by name match, id, exact keyword, keyword prefix, keyword contains, category,
description, then subsequence matches ("jsnfmt" finds JSON Formatter) and typo tolerance (edit distance 1 for words of 4+ letters, 2 for 7+). It returns the
character ranges to highlight.

Categories: JSON & Data, Text & Docs, Code Development, URL/Time & Utilities, API & Database, Files & Media, Web Development.

## 6. Shared components

- **`ui.js`**: DOM helper `el()`, `escapeHtml`, toasts, modal and confirm dialog (focus is trapped and restored), clipboard and file helpers, tab wiring with ARIA roles
  and arrow-key navigation (`initTabs`), `bindActions`, a cancellable `debounce`, lazy `loadScript` (optional SRI hash), `showMessage` (sets `role=alert` or `status`).
- **`editor.js`** (`createEditor(textarea, options)`): wraps an existing textarea in place (same element, native undo preserved) and adds a line-number gutter, an
  optional syntax-highlight overlay, find and replace, wrap, font size, fullscreen, copy, download, upload, clear, auto-indent, comment toggle and line operations.
  `destroy()` restores the original textarea. The pure logic and the JSON/CSS/HTML/JS highlighters are in `editor-core.js`.
- **`split.js`** (`createSplit`): a keyboard-accessible resizable splitter that stacks under 720 px.
- **`shared/*`**: pure logic used by more than one tool, for example `curl.js` (API Client and cURL Converter), `ts-interfaces.js` (JSON Formatter and the TypeScript tool),
  `sql-analyzer.js` (SQL Formatter and SQL Query Analyzer).
- **Design tokens**: `themes.css` defines light and dark values for colour, shadow and focus ring. All colours in tools must come from these variables.

## 7. Extending the app: adding a tool

1. Create `tools/<id>/` with `index.html`, `tool.css`, `tool.js` and, for anything with logic, `logic.js`. Scope every CSS selector under `.tool-<id>`.
2. In `tool.js`, `export default { mount(root, ctx) { ... return cleanup; } }`. Use `ctx.storage` for persistence, `ctx.signal` for network calls, and `ctx.onCleanup` for anything long-lived.
3. Put pure logic in `logic.js` and add `tests/unit/<id>.test.mjs` (plain `node:assert`; import `../../tools/<id>/logic.js`).
4. Add one entry to `TOOLS` in `assets/js/registry.js`. Pick a category and a Lucide icon name that exists in the pinned Lucide version (0.468), then run `node scripts/build-icons.mjs` to add it to `assets/js/icons.js`.
5. If the tool needs a third-party library, vendor it under `assets/js/vendor/` with its licence rather than loading it from a CDN, and load it lazily with `ctx.ui.loadScript`.
6. Run `npm test`, then `npm run serve` and `npm run test:browser`. The sweep fails if the new tool logs an error, overflows at 375 px, has no icon, or has unlabelled controls.

Conventions: no `eval` or `new Function`; never put untrusted data into `innerHTML` (use `textContent`, `el()` or `escapeHtml`); give every control an accessible name;
handle empty, invalid, Unicode and large input with a clear message; keep heavy work off the main thread when it can exceed about 100 ms.

## 8. External services

Everything runs locally except the items below. If a CDN is unreachable the affected tool shows a clear message and the rest of the app keeps working.

| Library | Used by | Source |
|---|---|---|
| Lucide 0.468 (icons) | the shell | bundled: only the icons used, inline in `assets/js/icons.js` (no CDN) |
| marked 12.0.2, DOMPurify 3.1.6, highlight.js 11.9.0 | Markdown Editor and Viewer | jsDelivr, cdnjs (lazy) |
| Mermaid 10.9.1 | Markdown Editor and Viewer (only when a diagram is present) | jsDelivr (lazy) |
| js-beautify 1.15.1 | Code Beautifier (HTML, CSS, JS) | cdnjs (lazy) |
| Prettier 3.3.3 and plugins | Prettier Playground | jsDelivr (lazy) |
| js-yaml 4.1.1, qrcode-generator 2.0.4, jsQR 1.4.0 | YAML Formatter and OpenAPI Viewer, QR Code | **vendored** in `assets/js/vendor/` |

None of the CDN scripts has a Subresource Integrity hash and there is no Content Security Policy yet (an open item in `TEST_REPORT.md`).
Network requests made on the user's behalf: the API Client (requests the user sends, CORS applies, there is no proxy), the OpenAPI Viewer's optional "From URL",
and the Webhook Inspector's optional polling of a service the user supplies.
