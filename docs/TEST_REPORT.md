# Test Report

Date: 2026-11-05 · Scope: the shell and all 36 tools · Browser tested: **Chrome 155 (headless, Windows 11) only** · Node 22

This report states what was verified, how, and what was **not**. Where a claim rests on a unit test, a real-browser check or just a code
review, it says so. Nothing here is a claim about browsers other than Chrome.

## 1. Summary

| Layer | Result | Command |
|---|---|---|
| Node unit tests (pure logic) | **51 suites, about 1,958 tests, 0 failures** | `npm test` |
| Browser smoke and accessibility sweep | **36 tools × 2 configurations (desktop/light, 375 px mobile/dark): no findings** | `npm run test:browser` |
| Rapid tool-switching stress | No console errors | part of the sweep |
| Memory-leak and duplicate-listener check | **No leaking tool** after the fix described in section 4 | `npm run test:leaks` |
| Targeted browser flows | About 25 tools exercised end to end (section 3.3) | ad hoc scripts, not all committed |
| Other browsers (Firefox, Safari, Edge) | **Not tested** | |

The browser tests need a static server and a Chromium-family browser (see section 9).

## 2. What each layer proves, and what it does not

- **Unit tests** exercise the pure `logic.js` modules in Node: parsing, conversion, validation, algorithms, security checks. They do not touch the DOM, layout,
  focus, clipboard, file dialogs, workers or the CDN libraries.
- **The browser sweep** mounts every registered tool in real Chrome with the cache disabled and checks: no console error or uncaught exception, no failed
  resource load, no visible error panel, tool icon rendered, no horizontal page overflow, and no unlabelled form control. It does **not** use the tools.
- **Targeted browser flows** drive a tool with real input through the real DOM (section 3.3). They cover the main path of each tool they list, not every option.
- **The leak check** measures DOM nodes, event listeners and documents after forced garbage collection (section 4).

There was no automated test of any kind for the original 20 tools apart from Saltbox's crypto vectors. Regression protection for the original tools is therefore
(a) the unit tests written during this work for the logic that was changed, (b) the smoke sweep, and (c) the targeted flows. It is not a full regression suite.

## 3. Results

### 3.1 Unit tests (51 suites)

| Tool or module | Suites | Tests |
|---|---|---|
| JSON Formatter and shared JSON modules | json-formatter, jsonpath, json-schema, json-diff, ts-interfaces | 41 + 18 + 20 + 15 + 19 |
| JWT Decoder | jwt-decoder, jwt-verify | 17 + 22 |
| API Client, cURL | api-client, api-client-compose, curl (shared), postman | 29 + 24 + 133 + 36 |
| Regex Tester | regex-tester, -library, -lint, -export | 19 + 13 + 28 + 16 |
| SQL | sql-formatter, sql-analyzer (shared), sql-query-analyzer | 25 + 47 + 95 |
| Markdown | markdown-editor-logic, markdown-mermaid, markdown-render | 24 + 6 + 13 |
| Diff Checker | diff-checker | 34 |
| Data tools | table-converter (+ v2), cyberchef, xml-formatter, yaml-formatter, base64-converter, url-encoder | 12 + 24, 19, 92, 53, 12, 5 |
| Time and misc | cron-generator, timestamp-converter, uuid-generator (+ HTTP status), webhook-inspector, carbon-code-image, code-beautifier, prettier-playground | 19, 6, 7, 19, 6, 8, 6 |
| New tools | html-entity-converter, ts-interface-generator, curl-converter, chmod-calculator, color-converter, http-header-analyzer, html-css-js-playground, image-converter, file-hash-generator, qr-code, git-command-generator, openapi-viewer | 58, 119, 50, 52, 117, 117, 83, 12, 19, 24, 132, 42 |
| Shared UI | editor-core (editor and splitter logic, highlighters) | 93 |
| Registry | registry (validity, search, fuzzy matching, every tool's files exist) | 16 |
| Saltbox | its own crypto vectors (`tools/saltbox/tests/run-tests.js`) | 42 |

Notable properties covered by these tests (not exhaustive): round trips over all 4,096 chmod modes; 3,000 random diffs compared against a brute-force LCS;
a 20,000-line diff with exactly 4,000 changes; a 300,000-row CSV; a 60,000-column SQL statement (about 100 ms); a 5 MB, 1,000-operation OpenAPI spec;
JWT signatures against RFC 7515 and jwt.io vectors; DOMPurify hardening against real `jsdom`, `dompurify@3.1.6` and `marked@12.0.2`; fuzz round trips of every
syntax highlighter; ZIP writers checked against an independent reader.

### 3.2 Browser sweep

All 36 tools mounted in both configurations with no console errors, no failed resource loads, no visible error panels, no horizontal overflow at 375 px, and
a rendered icon. The sweep found one item: the two disabled checkboxes in the Markdown Editor's preview are rendered task-list items from the sample Markdown.
The sanitizer deliberately keeps them as bare disabled checkboxes, so the sweep ignores them. They are user content, not a control without a label.

### 3.3 Targeted browser flows (real input, real DOM)

| Tool | What was exercised |
|---|---|
| JSON Formatter | Lossy-number and duplicate-key warning; lossless format; a 200,000-deep input gives a clear error; error caret lands on the offending character; lazy tree with expand-all and search; JSONPath filter; Schema validation; Compare; TypeScript output; sample-data generator; shared editor |
| JWT Decoder | `alg:none` warning, future `iat` warning, not-verified badge; HS256 signature valid with the jwt.io vector and invalid with a wrong secret |
| API Client | Send; cURL import (Unicode body, Basic auth); Postman environment import; unresolved-variable warning and `{{base}}` resolution; masked then revealed bearer token; save to a collection and reload; stored history holds no literal secrets; Copy as bash, cmd, PowerShell, fetch, Python; JSON response tree with search |
| Regex Tester | Matches with named groups and indices, replace table, split, JSON; mistake list and click-to-select; code export for 6 languages; cheat-sheet insert; library load and save; ReDoS pattern stopped after about 3.5 s with the page still responsive |
| Diff Checker | 20,000 lines with exactly 4,000 changes; options; next-change navigation |
| Markdown Editor / Viewer | Mermaid renders a real SVG; front matter panel; TOC; code highlighting; hostile Markdown (`<style>`, form, `onerror`, id clobbering) neutralised |
| SQL Formatter | Dialect-aware string escaping (MySQL keeps `'a\'b;c'`); Analyze, Explain and To JSON tabs |
| Code Beautifier | Shared editor: gutter, highlighting, Enter auto-indent, Tab, find with count, wrap, font size, CSS fullscreen fallback, clean teardown and remount; 375 px and dark screenshots |
| Data Converter | New operations present (HTML entities, Base32, Base58, ROT13/47, binary, decimal, reverse, case) |
| Table Converter | CSV to XML with escaping and emoji preserved |
| UUID Generator | v7 option present |
| HTML Entity Converter | Encode and decode with HTML-spec semantics (legacy entities without semicolon, C1 remaps, surrogates); 312-entry reference search |
| TypeScript Interface Generator | Optional-field inference, Zod target, error with line and column |
| cURL Converter | Parse; secrets masked everywhere on the page; all 12 output targets; build tab |
| Chmod Calculator | Octal, symbolic and command stay in sync; invalid input explained; symbolic expression applied to a mode; `ls -l` parsing including setgid |
| HTML/CSS/JS Playground | Sandboxed preview; user code **cannot** reach `parent.document`, `localStorage` or `fetch`; console captures log, warn and uncaught errors; viewport presets |
| Color Converter | `#ff0000` to the expected `hsl`, `oklch`, `lab`, `display-p3` values; invalid input message; WCAG ratio 4.54:1 for `#767676` on white |
| HTTP Header Analyzer | CORS wildcard with credentials flagged; information-leaking headers; insecure cookie; `public` with `Set-Cookie`; Authorization value masked |
| File Hash Generator | SHA-256 of text and of a file; expected-hash match and mismatch states |
| QR Code | Generated code with emoji and CJK text read back exactly; camera denial handled with a clear message |
| Image Converter | Two PNGs to WebP with resize; small image not upscaled; sizes reported; ZIP button enabled |
| XML Formatter | Format; exact error positions; duplicate attribute; entity-expansion guard; XPath; tree; XML to JSON |
| YAML Formatter | Norway problem, tab indentation and duplicate-key errors; anchors and merge keys; multi-document to JSON; unsafe `!!js/function` rejected |
| Git Command Generator | 73 tasks; `reset` danger and undo hint; cheat-sheet search; explainer |
| OpenAPI Viewer | Three bundled samples; endpoint detail and example payloads; filter; Lint; hostile spec rendered as text with no injection and a remote `$ref` left unresolved; 1,000 endpoints rendered lazily; Markdown export |
| SQL Query Analyzer | Structure, JOIN explanations, sargability, index suggestions, lint with jump-to-location, EXPLAIN plan red flags; empty, `;;;`, unbalanced and unterminated input handled |

Tools covered only by the smoke sweep (and, where they exist, unit tests), with no targeted flow: Prettier Playground, Code Image Generator, Base64 Converter,
URL Encoder, Cron Generator, Timestamp Converter, Webhook Inspector, HTTP Status Codes, Saltbox (apart from its 42 crypto vectors), Markdown Viewer's own UI beyond
the hostile-file check, and the Diff Checker's side-by-side rendering details.

## 4. Memory leaks and duplicate listeners

Method: for each tool, visit it, return to the dashboard, force garbage collection, and record DOM nodes, event listeners and documents. Then visit twice more and
record again. A leak grows with every visit.

**Defect found and fixed.** The shell's stylesheet loader attached `onload` and `onerror` handlers to the `<link>` it appends to `<head>`. That element lives for the
whole session, and the handlers' closure chain included the mount's lifecycle object, which holds the tool's cleanup closures, which reference the tool's DOM.
The first mount of every tool therefore stayed reachable forever. This was traced with a heap snapshot (retaining path from the GC root to a detached node).

The loader is now a module-level function that clears its handlers after loading (`loadToolCss` in `assets/js/app.js`).

| After visiting all 36 tools three times | Before | After |
|---|---|---|
| DOM nodes (dashboard baseline 471) | 44,097 | **613** |
| Event listeners (baseline 21) | 1,272 | **32** |
| Tools with growth per visit | 4 | **0** |

**A false positive worth recording.** Four tools (Saltbox, QR Code, File Hash Generator, cURL Converter) still appeared to grow by 500 to 3,000 nodes per visit.
Heap snapshots showed no application-reachable detached DOM; every retaining path ran through "Global handles → DevTools console". Chrome logs the verbose warning
"[DOM] Password field is not contained in a form" for password inputs and keeps a live reference to each element in the console message. Clearing the console after each
visit gave exactly 0 growth for all four. All four contain password inputs. This is browser tooling, not application code, and `tests/browser/leak.mjs` clears the console
for that reason.

I considered wrapping those fields in `<form>` elements to silence the warning and decided against it: it would invite the browser's "save password?" prompt on fields
that hold encryption keys and HMAC secrets.

Remaining growth after a full cycle is bounded: one stylesheet `<link>` per tool in `<head>`, the loaded JavaScript, and 2 extra documents (from libraries that
create detached documents once, such as the sanitizer).

## 5. Defects found by testing and fixed

| Defect | How it was found | Fix |
|---|---|---|
| Every tool's first mount was retained forever (44,097 DOM nodes after a full cycle) | Leak check plus heap-snapshot retainer analysis | Module-level stylesheet loader that clears its handlers |
| API Client crashed on mount after its UI rewrite (tab wiring overwrote the ids of two panels that the response view looks up by id) | Browser smoke test (console error); the author had not run the UI | Tab wiring only sets an id when none exists |
| Regex Tester blocked its own default example as a "risky pattern", while a real ReDoS pattern froze the tab | Audit, reproduced in the browser | Matching moved to a worker with a hard timeout; the heuristic is advisory only |
| Markdown preview let a document restyle the whole app, inject a form and clobber element ids | Audit, verified in jsdom and in the browser | Hardened sanitizer configuration, id and name prefixing |
| JSON Formatter silently rewrote big numbers and duplicate keys; deep nesting crashed it | Audit, reproduced in Node | Lossiness scanner and lossless mode; iterative walks with a depth limit |
| SQL formatter split and altered `'a\'b;c'`; O(n²) on large queries (17 s for 60,000 columns) | Audit, reproduced in Node | Dialect-aware tokenizer; linear algorithm (about 100 ms) |
| Diff Checker reported a whole-file replace beyond 3,000 edits | Audit, reproduced in Node | Exact linear-space algorithm with an anchoring fallback |
| Closed mobile sidebar stayed focusable; invisible focus rings; dark-theme toast contrast about 1.9:1 | Audit with computed contrast | CSS and shell changes (section 6) |
| An early version of the shared test runner broke Saltbox's CommonJS tests and the vendored jsQR (a `"type": "module"` setting) | Running the full suite | Removed; the runner suppresses Node's reparse warning instead |

Several earlier browser "failures" turned out to be faults in the test scripts, not the app: stale cached modules (now prevented by disabling the cache), a shell
layer that mangled backslashes in test inputs, and wrong element hooks. They are not counted above.

## 6. Status of the findings in `IMPROVEMENT_REPORT.md`

Resolved (verified by tests, a browser check, or both): shell lifecycle and cleanup (A-01 to A-04, A-06, A-07, A-10); Markdown sanitisation (S-01); history redaction
and body caps (S-03); MIME and snippet safety (S-05); webhook URL checks and storage validation (S-06, S-07); opt-in CSV formula escaping (S-08); Saltbox residue (S-09);
correctness and performance findings F-01 to F-23, plus most of the small items grouped under F-24; accessibility findings U-01 to U-07, U-09 to U-11; performance findings P-01 to P-05.

Open or only partly resolved:

| ID | Item | State |
|---|---|---|
| S-02 | CSP and Subresource Integrity for CDN scripts | **Open.** `loadScript` accepts an integrity hash but none is configured; there is no CSP. Lucide (unpkg), Prettier, js-beautify, marked, DOMPurify, highlight.js and Mermaid load from CDNs without SRI. New tools vendor their libraries instead. |
| S-04 | Global "do not remember my input" control | **Open.** Several tools persist their input in localStorage; some have their own toggle (Playground, Header Analyzer, Code Image), others do not. |
| A-05 | Routing: query strings in hash routes | **Open.** The router still discards anything after `?`. Focus and announcements on navigation are done. |
| A-08 | Duplicated UI patterns across tools | **Partly.** The shared editor and splitter exist and are used by 10 tools; SQL Formatter, Markdown Editor and others keep their own overlays. |
| A-09 | Markdown Viewer imports its renderer from the Markdown Editor folder | **Open.** Not an independent child project. |
| P-06 | Debounced localStorage writes everywhere | **Partly.** Done in some tools, not all. |

## 7. Known limitations and unresolved issues

Security and privacy
- API Client history still stores secrets that appear in URL query strings or request bodies; only sensitive headers and auth are redacted. Secret environment values
  are stored unencrypted in localStorage (the UI says so).
- Webhook Inspector keeps its live in-memory list unredacted; exports and stored history are redacted.
- Mermaid is loaded from a pinned CDN version without SRI.
- The Playground cannot stop a runaway loop in user code if the browser runs the sandboxed frame in the same process; it detects a frozen preview and offers Stop but
  has no loop-protect code transform. The nonce is visible to user code, so user code can forge console messages (they render as text, so this is harmless).

Correctness and scope
- The SQL, Git, cURL and header analyses are static heuristics. They never run a query, command or request, and say so in the UI. Output for Go, PHP, PowerShell, HTTPie,
  Python and other target languages was checked as text only, not compiled or run.
- The YAML and OpenAPI tools parse in the main thread (js-yaml is a classic script and cannot run in a module worker); very large documents briefly block the UI.
- YAML formatting drops comments (the tool asks for confirmation first). JWT verification accepts SPKI PEM or JWK keys only (no X.509, PKCS#1 or EdDSA).
- The HTML entity table has 312 entries, not the full 2,231-name HTML5 list; unknown names are left alone and counted.
- Cron: spring-forward gap handling was tested only for America/New_York.
- Saltbox: PBKDF2 cannot be cancelled once started (WebCrypto offers no interruption); the maximum was lowered and a warning is shown above 1,000,000 iterations.
- Shared editor: in wrap mode the line-number gutter is hidden because exact alignment is impossible; a regex typed into the find bar runs on the main thread.
- Image Converter: AVIF output appears only if the browser can encode it; animated images keep their first frame.

Not verified
- **Other browsers.** Firefox and Safari were not tested. Features that depend on newer APIs and have fallbacks in code, but were not exercised without them: module
  workers, the Fullscreen API (CSS fallback exercised), `BarcodeDetector` (jsQR fallback exercised), `EyeDropper` (button hidden when absent), `createImageBitmap`
  options, `Intl`, and `color-mix()` in the stylesheets.
- **Native fullscreen** (headless Chrome refuses it), the **camera** path of the QR reader, **file downloads** (blob URLs are created, but saved files were not inspected,
  except the ZIP writers, which are unit-tested against an independent reader), and **clipboard** behaviour (verified with a spy in two tools only).
- **Visual layout** was reviewed in screenshots for about a third of the tools (light, dark and 375 px). The rest were checked by the sweep's overflow rule only.
- Screen-reader behaviour and keyboard-only operation were checked through ARIA attributes and scripted key events, not with assistive technology.

## 8. Per-tool QA checklist

For manual or future automated passes. Each item is a pass or fail per tool. The right-hand column shows what is already covered automatically.

| Item | Already covered automatically | Still manual |
|---|---|---|
| Normal input | Unit tests for every logic module; targeted flows (section 3.3) | |
| Empty input | Unit tests for most tools; SQL Query Analyzer in the browser | Systematic pass over every tool's UI |
| Invalid input | Unit tests and error-position tests; several browser flows | |
| Unicode (emoji, CJK, RTL, combining marks) | Unit tests in the entity, table, QR, base64, URL, JSON, diff and carbon tools | |
| Large input | Unit performance tests (section 3.1); workers or lazy rendering in JSON, Regex, Diff, Table, XML, File Hash, Image, OpenAPI | 10 MB or more in the browser for each tool |
| Special characters (quotes, backslashes, markup) | Escaping tests in cURL, regex export, SQL, XML, OpenAPI HTML export, entity tools | |
| Boundary cases | Unit tests (chmod all modes, JWT times, ports, timestamps) | |
| Copy and paste | Two tools, with a clipboard spy | Every Copy button; paste into every editor |
| Download | ZIP writers and report builders are unit-tested | Saved file contents for every Download button |
| Responsive behaviour | 375 px sweep for every tool (overflow); screenshots for about a third | Visual review of the rest; tablet widths |
| Browser compatibility | Chrome 155 | Firefox, Safari, Edge |
| No console errors | Sweep, all tools, both configurations | |
| No broken links or navigation | Sweep (failed resource loads would be logged); rapid switching | Link-by-link crawl of the About and Settings pages |
| No duplicate listeners or leaks from tool switching | Leak check (section 4) | |
| No regressions | Unit tests, sweep, targeted flows | A full UI regression pass of the original 20 tools |

## 9. How to reproduce

```bash
npm install            # jsdom, dompurify and marked, pinned, for the Markdown DOM tests only
npm test               # all unit suites plus Saltbox
npm run serve          # in another terminal: static server on http://localhost:8080
npm run test:browser   # all 36 tools, desktop/light and mobile/dark, plus rapid-switch stress
npm run test:leaks     # leak and duplicate-listener check
```

`BASE` selects another server URL and `CHROME_PATH` selects another browser binary. The browser tests use the Chrome DevTools Protocol directly with no dependencies.
