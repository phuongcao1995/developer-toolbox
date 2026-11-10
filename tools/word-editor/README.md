# Folio — browser-based Word document editor

Folio opens, edits and saves Microsoft Word `.docx` documents entirely in the browser. There is no backend. Files never leave your computer: they are read with the File API and saved as a downloaded Blob.

It is written in plain HTML, CSS and vanilla JavaScript. There is no framework and no build step.

## Running it

**Option 1: open the file directly.** Double-click `index.html`. Chrome, Edge, Firefox and Safari all run it from `file://`.

**Option 2: serve the folder** (recommended, and closest to real deployment):

```bash
cd folio
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static host works too, such as GitHub Pages, Netlify or an S3 bucket.

An internet connection is needed the first time, to load three small libraries from the jsDelivr CDN (see below). If they fail to load, Folio shows a banner explaining that opening and saving files won't work. Typing still works.

## Features

### Files

| Action | How | Notes |
|---|---|---|
| New document | **New** or `Ctrl+Alt+N` | Asks before discarding unsaved changes |
| Open `.docx` | **Open**, `Ctrl+O`, or drag a file onto the page | Also accepts `.docm`, `.dotx`, `.dotm` (macros are ignored) |
| Open `.doc` | Same | **Text only**: see [Legacy .doc files](#legacy-doc-files) |
| Save | **Save .docx** or `Ctrl+S` | Downloads `<document name>.docx` |
| Print / PDF | **Print** or `Ctrl+P` | Uses the document's paper size and margins |

The file type is detected from the file's content, not its extension. A `.doc` renamed to `.docx`, for example, is still opened correctly.

### Editing toolbar

- **Undo / redo:** `Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`. Covers typing, formatting, tables, images and find & replace.
- **Paragraph styles:** Normal, Heading 1–4, Quote.
- **Font family and size.** The size box accepts any value from 1 to 400 pt.
- **Character formatting:**
  - Bold, italic, underline, strikethrough, clear formatting.
  - Font colour and highlight colour. The highlight palette is Word's own, so highlights stay real Word highlights.
- **Paragraph formatting:**
  - Alignment: left, centre, right, justify (`Ctrl+L/E/R/J`).
  - Bulleted and numbered lists. Tab / Shift+Tab nest and un-nest items.
  - Increase / decrease indent.
  - Line spacing: 1.0, 1.15, 1.5, 2.0, 2.5, 3.0.
- **Insert:**
  - Links (`Ctrl+K`). Insert, edit or remove; `Ctrl+click` opens a link.
  - Tables, from a grid picker or exact rows × columns.
    - Tab moves between cells, and Tab in the last cell adds a row.
    - Rows and columns can be inserted or deleted from the table menu.
  - Images: from a file, by drag & drop, or by pasting a screenshot. Click an image to resize it (aspect ratio kept); press Delete to remove it.
  - Page breaks (`Ctrl+Enter`).
- **Find & replace** (`Ctrl+F` / `Ctrl+H`):
  - Match case and whole-word options.
  - Next/previous match, Replace and Replace all.
  - Matches work across formatting changes, e.g. "he**llo**".
- **Headers and footers:**
  - Click the top or bottom margin of the page to type. A small toolbar offers bold, italic, underline, alignment, **Page #** and **Pages** (live page-number fields).
  - Opened from a file, the default header and footer are loaded, including pictures and page-number fields, and written back on save with the header/footer distances.
  - The editor shows them once (header on the first page, footer on the last); Word repeats them on every page.
  - Different first-page and odd/even headers are not imported; a notice says so.
- **Styles:** Normal, Title, Subtitle, Heading 1–4 and Quote, saved as the matching Word styles.
- **Table tools** (Table menu, with the cursor in a table):
  - Merge selected cells: select from the first to the last cell, like dragging in Word. Works across rows and down columns.
  - Split a merged cell, shade cells, turn the header row on or off, turn borders on or off.
- **Footnotes** (AB¹ button): the note is listed under the document and numbered in reading order. Click a number to edit or delete it. They are saved as real Word footnotes, so Word puts each at the bottom of its page. Footnotes in a .docx are read back as plain text.
- **Table of contents** (TOC button): built from Heading 1–3, with a link for each entry. Press the button again to update it. Headings are saved as bookmarks so the links work in Word.
- **More text tools:**
  - Superscript (`Ctrl+Shift+=`) and subscript (`Ctrl+=`).
  - Format painter: copy the formatting at the cursor, then select the text to apply it to.
  - Change case: sentence, lower, UPPER, Capitalize Each Word, tOGGLE.
  - Insert symbols, today's date and a horizontal line (the Ω menu). `Ctrl+Shift+V` pastes as plain text.
  - Paragraph settings (¶): left and right indent, first-line or hanging indent, space before and after, line spacing.
- **Page layout:**
  - Paper size: Letter, A4, Legal.
  - Orientation and margin presets.
  - A document's own page setup is preserved when it is opened.
- **Feedback:**
  - Toolbar buttons and boxes reflect the formatting at the cursor.
  - The status bar shows the page estimate, word count, character count and zoom.
  - The title bar shows unsaved changes, and the browser warns before you close a tab with unsaved changes.

Pasted content is sanitized. Scripts, event handlers, classes and unsafe links (`javascript:`) are removed, while supported formatting is kept.

## What survives import and export (.docx)

| Element | Import | Export |
|---|---|---|
| Paragraphs, line breaks, tabs, repeated spaces | ✓ | ✓ |
| Headings 1–6, Title (→ Heading 1), Quote | ✓ | ✓ |
| Bold, italic, underline, strikethrough, sub/superscript | ✓ | ✓ |
| Font family, font size, text colour | ✓ | ✓ |
| Highlight and run shading | ✓ | ✓ |
| Alignment, left/first-line indent, spacing before/after, line spacing | ✓ | ✓ |
| Bulleted / numbered lists, nesting, list type (1, a, A, i, I), start number | ✓ | ✓ |
| Tables, merged cells (row & column span), column widths, cell shading, borderless tables | ✓ | ✓ |
| Images: PNG, JPEG, GIF, BMP, SVG, WebP | ✓ inline and floating¹ | ✓ inline² |
| External links, internal `#bookmark` links, HYPERLINK fields | ✓ | ✓ |
| Page breaks, page size, orientation, margins | ✓ | ✓ |
| Document default font, size, paragraph spacing | ✓ | ✓ |
| Tracked changes | accepted³ | — |

1. Floating images become inline images.
2. SVG, WebP and BMP are converted to PNG on export.
3. Insertions are kept and deletions are removed.

Folio warns, rather than failing silently, when a file contains things it can't keep. Those are:

- Different first-page or odd/even headers and footers (the default ones are kept).
- Endnotes.
- Comments.
- Text boxes.
- Charts, shapes and SmartArt.
- Equations.
- EMF/WMF/TIFF images.
- Embedded objects.
- Multiple sections or columns.

The warnings appear in a banner after opening.

## Legacy .doc files

**Short version:** `.doc` files open as **plain text** and are always saved as `.docx`.

**Why:** `.doc` is a binary format, not XML. Formatting is stored in binary property tables, tables are encoded as special paragraph marks, and images are stored in a separate drawing stream. Rebuilding all of that faithfully in the browser would be a project in its own right. Doing it partly would produce documents that *look* right but silently lose things.

**What Folio does instead:**

1. It opens the file's OLE container using the CFB library.
2. It reads the document text through Word's piece table, in both 8-bit and Unicode text runs.
3. It removes field codes, keeping each field's displayed result.
4. It keeps paragraph breaks, line breaks and page breaks.

A banner states exactly what was lost.

Password-protected files, Word 6/95 files, and Excel or PowerPoint files are recognized and explained with a specific error.

**For a full-fidelity import:** open the `.doc` in Word, LibreOffice or Google Docs, use *Save As → Word Document (.docx)*, and open that file in Folio.

## Libraries (via CDN, pinned versions)

| Library | Version | Purpose |
|---|---|---|
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | Reads and writes the ZIP container of `.docx` files |
| [CFB](https://github.com/SheetJS/js-cfb) | 1.2.2 | Reads the OLE container of `.doc` files |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) | 1.8.0 | **Fallback** importer, used only if Folio's own parser fails on an unusual file. It keeps structure but not fonts, colours or alignment, and the user is told when it was used. |

To run fully offline, download those three files, put them in a `vendor/` folder, and change the three `<script src>` tags in `index.html` to point at them.

## Architecture

```
folio/
├── index.html            Markup: title bar, toolbar, popovers, page, dialogs, icon sprite
├── css/
│   ├── app.css           Application chrome, responsive and print rules
│   └── document.css      Page content styles (mirror the exported Word styles)
├── js/
│   ├── references.js     Footnotes and table of contents
│   ├── header-footer.js  Page header and footer regions and their mini toolbar
│   ├── util.js           Units, colours, fonts, XML escaping, file sniffing
│   ├── ui.js             Modal dialogs (<dialog>), toasts, notice banner
│   ├── history.js        Undo/redo: HTML snapshots + caret offsets
│   ├── docx-import.js    .docx → HTML (styles, numbering, theme, relationships)
│   ├── doc-import.js     .doc → plain paragraphs (piece-table text extraction)
│   ├── docx-export.js    HTML → .docx package (document, styles, numbering, media)
│   ├── editor.js         Formatting commands, selection, tables, images, links, paste
│   ├── find-replace.js   Search across text nodes, CSS Custom Highlight API
│   └── app.js            File actions, page setup, zoom, status bar, wiring
├── samples/              Test documents (see TESTING.md)
├── README.md
└── TESTING.md
```

Modules attach to a single global namespace, `window.Folio`, and are loaded with ordinary `<script>` tags in dependency order. That's why no bundler is needed.

### Key design decisions

**A custom importer and exporter, rather than separate off-the-shelf tools.** Using one library to import and an unrelated one to export means each understands formatting differently, so a document loses information every time it is opened and saved. Folio reads and writes the same subset of WordprocessingML: `docx-import.js` and `docx-export.js` are two sides of one model.

- Exporting and then reopening a file produces identical editor content.
- A second export is byte-identical to the first.

**HTML as the document model.** The editor is a `contenteditable` element containing a deliberately small set of tags: `p`, `h1`–`h6`, `blockquote`, `ul`/`ol`/`li`, `table`, `img`, `a`, `b`/`i`/`u`/`s`, `sub`/`sup`, `span` with inline styles, `br`, and `hr.page-break`.

**`execCommand` only where it is reliable.** It is deprecated but still the only native rich-text API in browsers. Folio uses it for character formatting, alignment and lists. Paragraph styles, indentation, line spacing, tables, images and page breaks are implemented with direct DOM changes, because `execCommand` behaves inconsistently there.

The editor also repairs invalid structures that browsers sometimes produce, such as Chrome placing a list *inside* a paragraph.

**Its own undo history.** The browser's undo stack is wiped by any direct DOM change. Folio records HTML snapshots instead. Images are referenced by short `blob:` URLs, so snapshots stay small.

**Schema-ordered XML.** Microsoft Word rejects files whose properties are in the wrong order. The exporter writes elements in ECMA-376 sequence, and exported files have been validated against the official schemas (see TESTING.md).

## Known limitations

These are stated plainly so nobody relies on something that doesn't work.

- **Pagination is estimated.** The editor is one continuous page. Page boundaries are calculated from the printable height and shown as dashed lines. Word's own layout (widow/orphan control, exact font metrics) can break pages slightly differently. Printing paginates properly.
- **Line spacing is approximate on screen.** Word's "single" spacing depends on the font's line gap, while the editor uses CSS line height. The saved value is exact; only the on-screen look differs a little.
- **Headings use Folio's heading styles.** On import, a heading keeps its level and any direct formatting, but takes Folio's heading look (size and colour) rather than the source document's style definition.
- **Not supported:**
  - Different first-page or odd/even headers and footers.
  - A ruler and custom tab stops.
  - Endnotes, and footnotes with formatting (a note is kept as plain text).
  - Comments.
  - Tracked-change review.
  - Text boxes.
  - Shapes, charts and SmartArt.
  - Equations.
  - Columns.
  - Multiple sections.
  - Page numbers in the table of contents (Word adds them when you update the field there).
  - Spell-check beyond the browser's own.
- **Tables:**
  - Row and column editing is disabled in tables with merged cells (deleting the whole table still works). Split the merged cells first.
  - Borders are either single black lines or none; custom border styles and colours are not kept.
  - Cells with paragraphs use zero spacing between paragraphs.
- **Images:**
  - Exported images are always inline.
  - Images pasted from other websites can only be saved if that site allows cross-origin access; otherwise you are asked to insert the image from a file.
  - EMF/WMF images (common in older Office files) cannot be displayed by browsers and are omitted, with a warning.
- **Lists:** Word's complex multi-level list definitions (e.g. legal "1.1.1" numbering) are imported as standard nested lists.
- **Page setup:** changes to page setup are not part of undo history.
- **`.doc` files:** text only; see above. Folio cannot *write* `.doc`.
- **Browser support:**
  - Tested in Chromium 141, the engine behind Chrome and Edge.
  - Firefox and Safari use the same standard APIs but **have not been tested**.
  - Highlighting of all find results uses the CSS Custom Highlight API (Chrome/Edge 105+, Safari 17.2+, Firefox 140+). Older browsers select only the current match.
- **Microsoft Word compatibility** has been verified indirectly: schema validation, python-docx and LibreOffice. It has not been tested in Microsoft Word itself, so please report any file Word complains about.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` / `Ctrl+O` / `Ctrl+Alt+N` | Save / Open / New |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+B` / `I` / `U` | Bold / Italic / Underline |
| `Ctrl+L` / `E` / `R` / `J` | Align left / centre / right / justify |
| `Ctrl+K` | Insert or edit link |
| `Ctrl+Shift+=` / `Ctrl+=` | Superscript / Subscript |
| `Ctrl+Shift+V` | Paste as plain text |
| `Ctrl+F` / `Ctrl+H` | Find / Replace |
| `Ctrl+Enter` | Page break |
| `Tab` / `Shift+Tab` | Nest list item, or move between table cells |
| `Ctrl+click` | Open link |

On macOS, use `Cmd` in place of `Ctrl`.
