# DevKit / Developer Toolbox — Improvement Report (Phase 1 audit → Phase 2)

> **Historical snapshot.** This is the audit as it stood *before* any code was changed (21 tools). Nearly all findings have since been addressed; the current
> status of every group, and the items that remain open, is in [TEST_REPORT.md](TEST_REPORT.md), section 6. The app now has 36 tools; see the [README](../README.md).

Scope: shell (`index.html`, `assets/js`, `assets/css`) and all 20 tools under `tools/`.
Method: full read of the shell; each tool read in full by an auditor; pure `logic.js` modules were executed in Node on edge cases. Items marked **(run)** were reproduced by execution, **(read)** by code reading only. Nothing in the browser was exercised in this phase, and no application code was changed.

Priority scale: Critical (data loss / exploitable) · High (wrong results, real security or a11y failure) · Medium · Low.
Effort: S (< 1 h) · M (half day) · L (multi-day).

## 0. Overall assessment

The foundation is sound: no `eval`/`new Function`, every audited render path escapes untrusted data, there is a clean tool contract (`mount(root, ctx)` + cleanup), lazy loading per tool, token-based theming and a working hash router. Saltbox's crypto is well tested (39/39 pass). The weaknesses are concentrated in:

1. **Un-sandboxed Markdown preview** (stylable/clobberable by untrusted `.md`).
2. **Silent data corruption** in formatters (JSON big numbers, SQL strings) and wrong diff output on large files.
3. **Shell UX gaps**: no usage stats, no fuzzy search or highlighting, no focus management in modals, weak focus indicators, contrast failures.
4. **Cross-cutting plumbing missing**: `debounce` cannot be cancelled, tabs and messages lack ARIA, no SRI/CSP for CDN scripts, sensitive data persisted in plaintext.
5. **Feature gaps** against the requested roadmap (JSONPath, schema, TS generation, cURL, collections, Mermaid, SQL analysis…).

## 1. Findings

### 1.1 Shell / architecture (A-)

| ID | Cat | Pri | Files | Problem | Solution | Benefit | Effort |
|---|---|---|---|---|---|---|---|
| A-01 | Architecture | High | `assets/js/components/ui.js:22` | `debounce` has no `cancel()`. Every tool leaves pending timers after unmount (jwt, regex, diff, table, cyberchef, prettier, markdown, url, carbon…). | Add `.cancel()`; add a per-mount disposer helper (`ctx.onCleanup(fn)`, `ctx.debounce`) that the shell runs automatically. | Removes a whole class of leak/late-callback bugs without touching each tool's logic. | S |
| A-02 | Architecture | High | `assets/js/registry.js`, `app.js` | Registry has no metadata beyond name/desc/keywords: no `version`, `updated`, `tags`, `deps`, `status`; no manifest validation (duplicate ids, missing files go unnoticed until click). | Extend entries (`updated`, `version`, `libs`), validate at boot in dev, expose `ctx.meta`. | Enables "recently updated", docs generation, health checks. | S |
| A-03 | Architecture | High | `app.js:140-165` (`mountTool`) | CSS `<link>` never removed; `ctx` has no `signal`/`onCleanup`; cleanup failures are only logged; no retry button on load failure; a failed `index.html` fetch gives raw "HTTP 404". | Provide `ctx.signal` (AbortController aborted on unmount), `ctx.onCleanup`, friendly error panel with Retry and Back, timeout on fetch. | Standard lifecycle, graceful fallback. | M |
| A-04 | Architecture | Medium | `app.js:187-208` | `route()` re-runs on every favorite toggle on card pages and calls `recent.push` for every tool navigation (also on re-render); no usage counters. | Separate "navigate" from "re-render"; track `usage[id] = {count,last}`. | Correct stats, fewer remounts. | S |
| A-05 | Architecture | Medium | `router.js` | Query string stripped (`?`), no unknown-route redirect, no scroll/focus management after navigation, no title announcement. | Parse query, focus `main` + announce via live region on route change. | Keyboard/screen-reader navigation. | S |
| A-06 | Architecture | Medium | `ui.js:150` | `enableTabIndent` rewrites `.value` (kills native undo), always traps Tab. | Use `execCommand('insertText')` / `setRangeText` + Esc-to-release. | Editors behave like editors. | S |
| A-07 | Architecture | Medium | `ui.js:120,130` | `showMessage` has no `role=alert`; `initTabs` sets `aria-selected` but no `role=tab/tablist/tabpanel`, no arrow keys. Affects ~every tool. | Fix once in `ui.js`. | Fixes ~15 tools' a11y at once. | S |
| A-08 | Architecture | Medium | tool folders | Duplicated patterns: tab markup, drop zones, copy/download rows, debounce+autorun, size caps, per-tool `showMsg`. | Shared `ui.js` primitives (`sizeGuard`, `toolbar`, `onCleanup`), shared editor module (D-01). | Less duplicated code, consistent UX. | M |
| A-09 | Architecture | Low | `markdown-viewer` | Imports `render.js`/`logic.js` from `markdown-editor` folder — breaks "independent child project". | Move to `assets/js/shared/markdown/`. | Real independence. | S |
| A-10 | Architecture | Low | `docs/`, README | Docs are `architecture.md` (lower-case); the requested `ARCHITECTURE.md` would collide on Windows/macOS file systems. | Update the existing file in place. | Avoid case-colliding paths. | S |

### 1.2 Security (S-)

| ID | Cat | Pri | Files | Problem | Solution | Benefit | Effort |
|---|---|---|---|---|---|---|---|
| S-01 | Security | High | `markdown-editor/render.js:27`, `markdown-viewer` | DOMPurify default profile keeps `<style>`, `<form>`, `<input>`, `<button>`, `id`/`name` **(run)**: `<style>body{display:none}</style>` in a `.md` restyles the whole app; phishing form possible; id-clobbering hijacks TOC/anchors. | `FORBID_TAGS` for style/form/input/textarea/select/button, `FORBID_ATTR:['style']`, `SANITIZE_NAMED_PROPS`, prefix heading ids with `md-`; keep disabled task checkboxes via hook. | Safe viewing of untrusted Markdown. | S |
| S-02 | Security | Medium | `ui.js:103` `loadScript` | CDN scripts (marked, DOMPurify, hljs, js-beautify, prettier, lucide) loaded without SRI/`crossorigin`; no CSP. | Central `CDN` map with `integrity`; add `_headers`/meta CSP restricting `script-src` to self + the three CDNs. | Supply-chain mitigation. | M |
| S-03 | Security | High | `api-client/tool.js:143`, `webhook-inspector/tool.js:20` | Request history stores `Authorization`/`Cookie`/API-key headers and bodies in plaintext localStorage, no opt-out. Webhook bodies uncapped. | Redact sensitive headers on save, "Save headers" toggle (default off), body size cap with "truncated" marker. | Prevents credential persistence. | S |
| S-04 | Security | Low | `json-formatter`, `carbon`, `regex`, `markdown-editor` | User input auto-persisted to localStorage without notice. | Global "Remember my input" setting (default on, clear + notice). | Privacy control. | S |
| S-05 | Security | Medium | `base64-converter/logic.js:360,423` | Pasted `data:image/png"onerror=…` keeps quote in MIME → generated `<img>` snippet is attacker-shaped **(run)**. | Allow only `^image/[\w.+-]+$`, encode snippets. | Safe copied snippets. | S |
| S-06 | Security | Medium | `webhook-inspector/logic.js:176` | Custom API URL accepts `localhost`, `169.254.169.254`, `http:` (browser-side, CORS limited). | Warn/confirm on private/loopback/non-https. | Prevents accidental LAN probing. | S |
| S-07 | Security | Medium | `webhook-inspector/logic.js:145` | `sanitizeHistory` keeps `headers:null` → tool crashes on every mount with tampered/corrupt storage **(run)**. | Validate shapes. | Resilience. | S |
| S-08 | Security | Low | `table-converter`, `json-formatter` CSV | CSV export doesn't neutralise formula cells (`=cmd|…`) **(run)**. | Opt-in "escape formulas". | Safe Excel import. | S |
| S-09 | Security | Low | `saltbox/tool.js:254` | `wipeSecrets` leaves plaintext/ciphertext/output areas. | Clear them too. | Less residue. | S |
| S-10 | Security | Low | `api-client/tool.js:157` | `${h.status}` from storage unescaped. | `Number()`. | Hardening. | S |
| S-11 | Security | Info | all | No `eval`/`new Function`; all audited innerHTML sinks escape data; Markdown fallback never renders unsanitised HTML; `__proto__` keys safe. | — | — | — |

### 1.3 Functionality / correctness (F-)

| ID | Cat | Pri | Files | Problem | Solution | Benefit | Effort |
|---|---|---|---|---|---|---|---|
| F-01 | Functionality | High | `sql-formatter/logic.js:71` | `'a\'b;c'` is split at `;` and whitespace injected into the literal **(run)** — data-changing. | Dialect option with backslash-escape strings (MySQL/BigQuery default off for ANSI/Postgres). | Never corrupt SQL. | S |
| F-02 | Performance | High | `sql-formatter/logic.js:238` | `slice(i+1).find` per token → O(n²): 20k cols = 1.9 s, 60k = 17.5 s **(run)**. | Precompute next-significant index. | Large queries usable. | S |
| F-03 | Functionality | High | `json-formatter/logic.js:27` | Format silently rewrites `12345678901234567890`, `1e400→null`, duplicate keys **(run)**. | Detect lossy numbers/dup keys during a scan; warn (and offer lossless mode via BigInt-preserving tokenizer). | A formatter must not corrupt data. | M |
| F-04 | Functionality | High | `json-formatter/logic.js:45-62` | `stats`, `sortKeys`, `flatten`, `toXml` recurse unbounded; `[`×200000 throws uncaught RangeError **(run)**. | Iterative walks or depth cap + try/catch in handlers. | No silent crash. | S |
| F-05 | Functionality | High | `diff-checker/logic.js:4,49` | `MAX_D=3000` fallback marks whole middle as replaced: 20k lines/4k changes → 19 996 vs 4 000 **(run)**. | Linear-space Myers (middle snake) / unique-line anchoring. | Correct large diffs. | M |
| F-06 | Performance | High | `diff-checker/tool.js:35` | Renders all rows incl. unchanged; 100k-line file = 100k-row table. Diff itself 45 ms **(run)**. | Fold unchanged runs (context 3) with expand; size guard on paste. | UI stays responsive. | M |
| F-07 | Functionality | High | `regex-tester/tool.js:14`, `logic.js:23` | Default Email example triggers "risky pattern" pause on first load; heuristic false-positives; true ReDoS `(a|aa)+$` not flagged and cannot be interrupted; `replaceAll` has no budget **(run)**. | Run matching in a Worker with `terminate()` timeout; drop the heuristic block. | Reliable tool, no tab freeze. | M |
| F-08 | Functionality | High | `jwt-decoder/logic.js:47` | `alg:none` decodes with no warning; `alg:5` gives misleading error; no checks for jku/x5u/jwk, future iat, ms exp, nbf>exp **(run)**. | `securityWarnings()` + sanity checks + claim docs (see P4). | Correct security guidance; never implies verification. | S |
| F-09 | Functionality | High | `api-client/tool.js:209` | Enter in URL field can start a concurrent request; first finally resets busy; controller overwritten. | Guard when in flight. | No orphaned requests. | S |
| F-10 | Functionality | Medium | `api-client/logic.js:62` | Non-GET body must be JSON; no HEAD/OPTIONS; response read via `text()` (binary corrupt); fixed 30 s timeout; params not synced with URL. | Body types, methods, blob handling + size cap, timeout setting, two-way params. | Real-world usable client. | M |
| F-11 | Functionality | High | `table-converter/logic.js:124,187,273` | `Math.max(...rows.map())` stack overflow at ~130k rows **(run)**. | Loop/reduce. | Large CSV works. | S |
| F-12 | Functionality | Medium | `table-converter/logic.js:76`, `:165` | 1-col CSV drops `""` rows; nested JSON stringified into one cell with no flatten option **(run)**. | Distinguish quoted-empty; add dot-path flatten. | Correct conversions. | S–M |
| F-13 | Functionality | Medium | `url-encoder/logic.js:109` | "Rebuilt URL" re-encodes even if untouched: `a=b/c:d` → `%2F%3A`, `;`, malformed `%E4`, `?`/`#` dropped **(run)**. | Preserve original until edited. | Faithful URLs. | M |
| F-14 | Functionality | Medium | `json-formatter/logic.js:35` | Error position missing on modern V8 messages **(run)** — no caret/line/col. | Own scanner for position. | Actionable errors. | M |
| F-15 | Functionality | Medium | `sql-formatter/logic.js:257` | Keywords after `.` start clauses (`a.select`) **(run)**; no dialects; `BEGIN…END`, `DELIMITER`, `FOR UPDATE`, `ARRAY[]` mis-handled. | Fix `matchClause`; dialect option; block-aware split. | Better formatting. | M |
| F-16 | Functionality | Medium | `code-beautifier/logic.js:454,269,170` | HTML minify drops newline-only gaps between inline elements (rendering change); minifyCss on SCSS/Less swallows declarations after `//`; `<svg>`/XML detected as JS **(run)**. | Collapse to a single space; gate on lang; better detection. | Correct minify. | S |
| F-17 | Functionality | Medium | `cron-generator/logic.js:66,192` | `7/2` yields empty set + "undefined" text; DST spring-forward skips jobs; fall-back omits repeated sub-hourly runs **(run)**. | Normalise 7→0, reject empty; DST note. | Correct schedules. | S–M |
| F-18 | Functionality | Medium | `webhook-inspector/logic.js:234`, `tool.js:129` | One bad record kills polling forever; 429/5xx hammered every 5 s; abort reported as "invalid JSON". | Skip bad records, back off, rethrow Abort. | Stable polling. | S |
| F-19 | Functionality | Medium | `markdown-editor/tool.js:45` | "Draft saved" shown even when storage write fails; export HTML lacks code colouring/TOC/print CSS; hljs `<link>` leaks. | Check return, inline CSS, cleanup. | Honest status, better export. | S |
| F-20 | Functionality | Medium | `timestamp-converter/tool.js:91` | Partial datetime-local clears all numeric fields; ms/µs ambiguity not hinted; ns precision lost **(run)**. | Targeted clear; hint; BigInt. | Fewer surprises. | S–M |
| F-21 | Functionality | Medium | `cyberchef/tool.js:292` | Binary output copied/downloaded as hex text; file upload read as text. | Keep bytes, "Download bytes", read ArrayBuffer. | Correct for hashing files. | M |
| F-22 | Functionality | Medium | `prettier-playground/tool.js:178` | Missing plugin → confusing "Couldn't resolve parser"; failed format clears last good output; no YAML/GraphQL/Vue; few options. | Clear errors, keep output, add languages. | Better playground. | S–M |
| F-23 | Functionality | Low | `carbon/render.js`,`logic.js:114` | Width uses UTF-16 length vs code-point drawing; per-glyph `fillText`; unbundled font. | Width-aware columns; per-token drawing. | Correct emoji/CJK export. | M |
| F-24 | Functionality | Low | misc | `diff` strips all whitespace (not collapse) and hides CRLF/LF difference; `base64 detectMime("BM…")`; MD5 `hexToBytes` strips `0x` anywhere; HTTP "4xx" count mismatch; json `flatten` key collisions; `jwt formatDuration` rounding; colon-handling in `url describeUriError`. | Individually small fixes. | Polish. | S each |

### 1.4 Performance (P-)

| ID | Pri | Files | Problem | Solution | Effort |
|---|---|---|---|---|---|
| P-01 | Medium | json tree (`tool.js:46-75`) | `expandAll` does up to 20 000 `querySelector`+click; full child render of 60k arrays. | Level-wise expand, chunked rAF, page arrays by 200. | M |
| P-02 | Medium | json, table, markdown, regex, carbon, sql | Heavy work synchronous on main thread with no size guard or progress. | Shared `sizeGuard` + loading state; Worker for JSON convert/regex/diff. | M |
| P-03 | Medium | `markdown-*` | Whole-document parse+sanitise+hljs per keystroke; viewer creates one IntersectionObserver per heading. | Adaptive debounce, idle render, single observer. | M |
| P-04 | Low | `saltbox`, `cyberchef` | 512 MB file hashed in memory on main thread (MD5 ~64 MB/s); cyberchef MD5 slower than saltbox's. | Chunk + progress, reuse md5. | M |
| P-05 | Low | `cron`, `http-status`, `uuid` | Full re-render for tiny updates. | In-place updates. | S |
| P-06 | Low | localStorage | Writes on each keystroke in several tools. | Debounce writes (1 s) via shared helper. | S |

### 1.5 UX / Accessibility (U-)

| ID | Pri | Files | Problem | Solution | Effort |
|---|---|---|---|---|---|
| U-01 | High | `components.css:24` | `.input/.textarea:focus` removes `:focus-visible`; remaining ring contrast 1.17:1 light / 1.25:1 dark; `.panel .textarea` has **no** focus indicator (computed). | `:focus-visible` outline with `--primary`. | S |
| U-02 | High | `components.css:93` | Dark-theme toasts white on bright accents: 1.93 / 1.88 / 2.66:1 (computed). | `--on-accent` tokens. | S |
| U-03 | Medium | `themes.css` | Light `--text-faint` 3.1:1, warn/success/primary on soft ≈ 4.3:1. | Darken tokens ~10 %. | S |
| U-04 | Medium | `responsive.css:5` | Off-canvas sidebar still focusable when closed. | `visibility:hidden`/`inert`. | S |
| U-05 | Medium | `ui.js openModal` | No focus trap, no focus restore, no initial focus; palette lacks `aria-activedescendant`/combobox semantics. | Focus management in `openModal`. | S |
| U-06 | Medium | `cron-generator/tool.css:14` | Visually hidden checkboxes with no focus style. | `label:has(:focus-visible)`. | S |
| U-07 | Medium | diff side-by-side | Add/remove only by colour. | +/- marker column. | S |
| U-08 | Medium | all | Textareas without labels; many tabs w/o tabpanel/arrow keys; message boxes not live; history items as clickable `div`s (api-client). | Labels via shared helpers; semantic buttons. | M |
| U-09 | Low | `main.css` | Reduced-motion freezes spinner so loading feedback disappears. | Static "Loading…" / pulse. | S |
| U-10 | Low | `responsive.css` | `.btn-sm` 28 px, `.btn-icon` 34 px (<44 px touch); `vh` modals. | `pointer:coarse` sizing, `dvh`. | S |
| U-11 | Medium | dashboard/search | No usage stats, no frequent tools, no fuzzy search or highlight, categories fixed at 5, no shortcut help (`?`), "avatar" placeholder in header looks like a real feature. | See Phase 3 B/C/E. | M |
| U-12 | Low | `carbon` | Sample overwrites code unconfirmed; no undo. | Confirm. | S |

### 1.6 Feature gaps vs. requested roadmap (G-)

| Tool | Present | Missing (verified absent) |
|---|---|---|
| JSON Formatter | format/minify/validate/tree/XML/CSV/YAML | JSONPath, Schema validation, JSON diff, TS interfaces, tree search/copy-path, sample-data generator |
| JWT Decoder | header/payload/exp/iat/nbf | alg warnings, claim descriptions, countdown states, sanity checks |
| API Client | send, headers, history | collections, env vars, cURL import/export, auth helpers, Postman import/export, response tree, timing (TTFB), body types |
| Regex Tester | 14 examples, explain, replace | y/d/v flags, templates/cheat-sheet, code export, saved patterns |
| Markdown Editor | live preview, export | TOC, Mermaid, fullscreen, scroll-sync, front matter, hljs in export |
| SQL Formatter | format/minify | dialects, highlighting, analysis, explain |
| Diff Checker | line/word diff, unified | char-level, ignore-case, collapse, large-file algorithm |
| Data conversion | CSV/JSON/SQL/MD | nested flatten, XML (none exists), BOM option |

## 2. Top 10 highest-priority improvements

1. **S-01** Sanitise Markdown properly (style/form/id) — real injection-class risk on untrusted files.
2. **A-01 + A-03** Lifecycle hardening: cancellable debounce, `ctx.onCleanup`/`signal`, retry fallback — fixes leaks across ~12 tools.
3. **U-01/U-02/U-03/A-07/U-04/U-05** Accessibility foundation: focus rings, contrast, roles, sidebar inertness, modal focus management.
4. **F-03 + F-04** JSON: warn on lossy numbers/duplicate keys, depth-safe walks.
5. **F-01 + F-02** SQL: backslash-string corruption and O(n²) formatter.
6. **F-05 + F-06** Diff: correct large-file algorithm and folded rendering.
7. **F-07** Regex: Worker-based execution with hard timeout, remove false "risky" block on the default example.
8. **S-03 + S-04** Stop persisting credentials/inputs silently (API client, webhook).
9. **F-08** JWT security warnings and claim docs.
10. **U-11 + search** Dashboard usage stats, fuzzy search with highlighting, shortcut help.

## 3. Technical debt assessment

- **Low-to-moderate overall.** 11.8 k lines, consistent contract, pure `logic.js` separation (good for tests). Debt is repetition rather than tangle.
- Recurring debt: per-tool re-implemented tabs/messages/debounce/size caps/drop zones; no automated tests except Saltbox; `markdown-viewer` coupled to editor folder; no CSP/SRI; localStorage usage unstructured.
- No automated regression harness exists → Phase 6 adds a Node test runner for pure `logic.js` modules, because the rest of the plan rewrites logic.

## 4. Security risks (summary)

Primary: Markdown preview CSS/form/id injection (S-01); CDN scripts without SRI/CSP (S-02); plaintext persistence of credentials and inputs (S-03/S-04); copied HTML snippets built from unvalidated MIME (S-05); LAN probing via custom webhook URL (S-06). No XSS found in any audited render path. Client-side validation is never treated as authorization: the app has no server, so the real boundary is the browser origin, which is why CSP/SRI matter.

## 5. UX weaknesses (summary)

Invisible focus indicators, failing contrast (dark toasts), off-screen focusable nav, no focus management in dialogs, unlabeled textareas and tab semantics, colour-only diff, no usage-aware dashboard, plain substring search, no shortcut help, placeholder avatar, touch targets under 44 px.

## 6. Recommended architecture improvements

1. `ctx` v2: `{ toolId, meta, ui, storage, settings, signal, onCleanup, debounce, indentUnit, fontSize }`; shell auto-runs cleanups; cleanup return stays supported (back-compatible, no tool breaks).
2. Registry entries gain `version`, `updated`, `libs`, `status`; a dev-time validator; categories extended (Web, Productivity, Files).
3. Shared modules in `assets/js/shared/` (markdown, diff-worker, sizeGuard, editor) — tools remain independent folders, shared code lives in the shell.
4. Central CDN manifest with SRI + CSP via `_headers` (Cloudflare Workers static assets supports `_headers`).
5. Workers (`worker.js` per tool) for regex, JSON conversion, diff, hashing.
6. Lightweight editor: a textarea-overlay component (line numbers, highlight overlay, find/replace, wrap, font size, fullscreen, resize, drop). **Decision:** CodeMirror 6 is ESM-only and needs a bundler or ~30 CDN module imports; Monaco is multi-MB. Both violate "lightweight / no build step" for modest gain, so use a custom ~300-line component built on `<textarea>`, with the existing tokenizers (SQL, carbon highlighter) for overlay highlighting.

## 7. Recommended new tools (Phase 5)

Already partially covered: HTML entities (in Data Converter), cURL (will be shared with API Client), TS interface (will be shared with JSON Formatter), hashing (Saltbox). Plan:

| # | Tool | Notes / dependency |
|---|---|---|
| 1 | HTML Entity Converter | standalone, full named table subset + numeric |
| 2 | TypeScript Interface Generator | pure logic, shared with JSON formatter |
| 3 | OpenAPI Viewer | JSON native, YAML via shared mini-parser (js-yaml from CDN with SRI) |
| 4 | cURL Converter | shared parser with API Client |
| 5 | SQL Query Analyzer | tokenizer reuse; heuristic labelled as such |
| 6 | XML Formatter & Validator | `DOMParser`, no lib |
| 7 | YAML Formatter & Validator | js-yaml CDN |
| 8 | Image Converter | canvas, offline |
| 9 | File Hash Generator | WebCrypto + shared MD5, chunked |
| 10 | QR Generator & Reader | generator own implementation or CDN lib; reader via `BarcodeDetector` with jsQR fallback (CDN) — must be explicit about support |
| 11 | HTML/CSS/JS Playground | `iframe sandbox="allow-scripts"` (no `allow-same-origin`) |
| 12 | Color Converter | pure logic, WCAG contrast |
| 13 | HTTP Header Analyzer | static knowledge base, labelled heuristic |
| 14 | Chmod Calculator | pure logic |
| 15 | Git Command Generator | static builder, never executes |

## 8. Proposed implementation order

1. **Group 1 – Shell foundation** (A-01, A-03, A-07, U-01…U-05, U-09, U-10, S-02 partial): lifecycle, a11y, focus, contrast.
2. **Group 2 – Dashboard, search, shortcuts, toasts/dialogs** (B, C, E).
3. **Group 3 – Correctness/security fixes in existing tools** (S-01, S-03, S-05, F-01/02/03/04/09/11, F-08).
4. **Group 4 – Advanced tool features** (JSON, JWT, Regex, Diff, SQL, Markdown, API Client, converters).
5. **Group 5 – Shared editor component + Workers.**
6. **Group 6 – 15 new tools** in batches of ~3 (pure-logic tools first).
7. **Group 7 – Tests, TEST_REPORT.md, README/ARCHITECTURE.**
