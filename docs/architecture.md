# Architecture

Developer Toolbox is a static, build-free single-page app (HTML + CSS + ES modules).

```
index.html            shell markup (sidebar, topbar, #main)
assets/js/app.js      shell: dashboard, catalog, settings, Ctrl+K palette, dynamic tool loader
assets/js/router.js   hash router  (#/tool/<id>, #/category/<id>, ...) – refresh-safe on any static server
assets/js/registry.js tool registry: id, name, description, category, icon, keywords, entry
assets/js/storage.js  localStorage wrapper + settings store
assets/js/components/ui.js  shared helpers (copy, download, toast, file read, tabs, modal, loadScript…)
assets/css/*          tokens (themes.css), base, layout, shared components, responsive
tools/<id>/           one independent child project per tool
```

## Tool contract

Each `tools/<id>/` folder contains:

| File | Purpose |
|------|---------|
| `index.html` | HTML **fragment** (no `<html>`/`<body>`) injected into the tool root |
| `tool.css`   | Styles, **every selector scoped under `.tool-<id>`** (the root element has that class) |
| `tool.js`    | ES module, `export default { mount(root, ctx) }`; may return a cleanup function |
| `logic.js`   | (recommended) pure functions with no DOM access, importable from Node for testing |

`ctx` = `{ toolId, ui, settings, storage, indentUnit, fontSize }` where `ui` is `components/ui.js`,
`storage` is a per-tool persisted key/value store (`get/set/remove`; cleared by Settings → Clear history),
and `indentUnit` is the user's default indentation string.

Lifecycle: the router fetches `index.html`, injects it, loads `tool.css`, imports `tool.js`, calls `mount`.
On navigation the returned cleanup function is called (remove global listeners, clear timers).

## Adding a tool
1. Create `tools/<id>/{index.html,tool.css,tool.js}`.
2. Add an entry to `TOOLS` in `assets/js/registry.js`.

## External services
Lucide icons (unpkg), and per-tool optional CDN libraries loaded lazily via `ui.loadScript` (Prettier, marked,
DOMPurify, highlight.js, html2canvas). Each tool reports a clear error if a CDN script cannot load.
