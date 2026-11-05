# Folio — test scenarios

The `samples/` folder contains the documents used below:

| File | What it is |
|---|---|
| `sample.docx` | Feature-rich document made with python-docx. It contains headings, every character format, alignment, indent, double spacing, nested bullets, a numbered list, a quote, a table with horizontally *and* vertically merged cells, a hyperlink, an image, a page break, tabs, and A4 paper. |
| `sample-libreoffice.docx` | The same content written by LibreOffice, a different producer with different XML habits. |
| `sample.doc` | Legacy Word 97–2003 binary version, for the text-only import path. |
| `red.png` | Small image for the insert-image tests. |

To check exported files independently, use one or more of:

- Microsoft Word.
- LibreOffice Writer.
- Google Docs (upload).
- `python-docx` (`pip install python-docx`).

---

## A. Import

**A1. Open a feature-rich .docx.** Open `sample.docx`. Expect:

- Headings are styled as headings.
- In the first paragraph: bold, italic, underlined and struck words; red 16 pt Arial text; a yellow highlight; H₂O and E=mc².
- Centred, right-aligned and indented double-spaced justified paragraphs.
- A bullet list with one nested bullet, a 2-item numbered list, and a quote.
- A 3×3 table: the top-left cell spans 2 columns, and "Tall cell" spans 2 rows.
- A working link ("our website"; Ctrl+click opens it), and a red image.
- A "Page break" marker followed by the *Second page* heading.
- The status bar shows **A4** and **Page 1 of 2**.

**A2. Open a .docx from another producer.** Open `sample-libreoffice.docx`. Expect the same content and formatting as A1. Use the browser dev tools to inspect the HTML: plain text should not be wrapped in redundant font/size spans.

**A3. Open a legacy .doc.** Open `sample.doc`. Expect:

- All text, as plain paragraphs.
- A yellow banner saying that formatting, tables and images were not imported, and how to convert the file to `.docx`.
- After **Save .docx**, the download is `sample.docx`, and a banner says `.doc` cannot be written.

**A4. Detection by content, not extension.** Rename `sample.doc` to `test.docx` and open it. Expect the same result as A3 (no error).

**A5. Invalid and unsupported files.** Each case should show an error dialog with the message below and leave the current document untouched.

| File | Expected message |
|---|---|
| A `.png` or `.pdf` | "…isn't a Word document. Folio opens .docx files, and .doc files as plain text." |
| A text file renamed to `.docx` | "This file is not a Word document, or it is damaged…" |
| `sample.docx` truncated to half its size | "This file is not a valid .docx document. It may be damaged or incompletely downloaded." (with technical details) |
| An `.xlsx` renamed to `.docx` | "This is an Excel spreadsheet, not a Word document." |
| An empty (0-byte) `.docx` | "The file is empty (0 bytes)." |
| A password-protected `.docx` | "This document is password-protected…" |

**A6. Unsupported features are reported.** Open a Word document with a header, a footnote and a comment. Expect it to open, with a banner listing "Headers and footers…", "Footnotes and endnotes…" and "Comments were removed."

## B. Editing

**B1. Text formatting.** In a new document, type a sentence. Then:

1. Select words and apply bold, italic (`Ctrl+I`), underline and strikethrough.
2. Set font Georgia and size 18.
3. Apply a red font colour from the palette and a yellow highlight.

Expect every change to show immediately. With the cursor inside formatted text, the toolbar buttons and boxes should reflect it.

**B2. Paragraphs.** Apply Heading 1, Heading 2, Quote and back to Normal. Then try:

- Centre, right and justify.
- Line spacing 2.0.
- Increase indent twice and decrease once.

**B3. Lists.**

1. Make a bulleted list.
2. Press Tab on the second item; it nests with a hollow bullet.
3. Press Shift+Tab; it un-nests.
4. Press Enter twice to leave the list.
5. Make a numbered list.

**B4. Tables.**

1. Insert a 2×3 table from the grid.
2. Type into the cells using Tab to move. Tab in the last cell adds a row.
3. From the table menu, insert a row above, insert a column right, delete a column, and delete a row.
4. Delete the table.

Expect each change to be undoable.

**B5. Links.**

1. Select text and press `Ctrl+K`. Enter `example.org`; it is saved as `https://example.org`.
2. Reopen the dialog on the link and remove it.
3. Try `javascript:alert(1)`. It is rejected with a message.

**B6. Images.**

1. Insert `red.png`.
2. Click it and drag the corner handle; the size label updates and the aspect ratio is kept.
3. Press Delete, then `Ctrl+Z`; the image comes back at the resized size.

**B7. Page break.** Put the cursor mid-paragraph and press `Ctrl+Enter`. The paragraph splits around a "Page break" marker, and the page count goes up.

**B8. Find & replace.**

1. Type "world" three times. `Ctrl+H` shows **1 of 3**.
2. Enter "planet" in Replace and choose Replace all; a toast says "Replaced 3 matches".
3. Press `Ctrl+Z`; all three come back.
4. Press `Ctrl+Y`; they are replaced again.
5. Check that *Match case* and *Whole words* change the counts as expected.

**B9. Paste.** Copy part of a web page that has links and formatting, and paste it. Formatting and links are kept, while page styles, scripts and layout wrappers are not.

**B10. Unsaved-changes guard.** Edit, then click **New**. A *Discard unsaved changes?* dialog appears; Cancel keeps your text. Closing the tab with unsaved changes triggers the browser's leave-page warning.

## C. Export and round trip

**C1. Export.** After the B-series edits, rename the document to "Edited plan" and click **Save .docx**. Expect the download `Edited plan.docx`. Open it in Word, LibreOffice or Google Docs; every edit from section B should be present.

**C2. Round trip.** Open `sample.docx`, save it, and open the saved file in Folio. The content should look identical to A1.

**C3. Page setup survives.** Set Layout to Legal, Landscape, Narrow margins, then save. The file opens in Word or LibreOffice on legal landscape paper with 0.5 in margins, and reopening it in Folio shows the same settings.

**C4. Print.** Click **Print**. The preview uses the document's paper size and margins, page breaks start new pages, and no editor chrome is shown.

## D. Responsive layout

**D1. Tablet.** Open the app at 820×1180 (iPad portrait) or on a tablet:

- The toolbar wraps to two rows.
- The page zooms to fit the width.
- There is no horizontal scrolling.
- Touch targets are larger on touch screens.

**D2. Zoom.** Use −/+ in the status bar, then click the percentage to fit the width again.

---

## Verification performed during development

These checks were automated with Playwright driving headless Chromium 141. They were run against the files in `samples/` and against documents created by typing and clicking through the UI.

| Check | Result |
|---|---|
| A1 import: every element listed in A1 present in the editor HTML | Pass |
| A2 LibreOffice-written file imports cleanly (no redundant spans) | Pass |
| A3–A5 legacy `.doc`, renamed `.doc`, and every invalid file in A5, including 0-byte and password-protected (encrypted with msoffcrypto) | Pass. Each gives the expected message |
| A6 header, footer and comment reported after opening (footnotes not tested) | Pass |
| B1–B8 editing through real clicks and keystrokes | Pass |
| B4 table row/column insert and delete; undo | Pass |
| B6 image resize keeps 2:1 aspect; delete and undo | Pass |
| B9 paste removes `<script>`, `onclick`, `javascript:` links; keeps colour, bold and safe links | Pass |
| B10 discard prompt; Cancel keeps content | Pass |
| C2 round trip: import → export → import gives identical editor HTML | Pass |
| Export stability: re-exporting a reopened file gives byte-identical `document.xml`, `numbering.xml`, `styles.xml` | Pass |
| Exported `document.xml`, `styles.xml`, `numbering.xml` and `settings.xml` validate against the ECMA-376 transitional XSD schemas⁴ | Pass |
| Exported files read by python-docx 1.2: styles, alignment, run formatting, merged cells, image, page size | Pass |
| Exported files rendered by LibreOffice: content matches, page break lands on page 2, A4 page | Pass |
| D1 tablet viewport 820×1180: wrapped toolbar, page fits, no horizontal overflow | Pass |
| No JavaScript errors in the console during any of the above | Pass |

⁴ The validator was confirmed to reject a deliberately mis-ordered file before it was trusted.

**Not verified:**

- Opening exported files in Microsoft Word itself (not available in the test environment).
- Firefox and Safari.
- Very large documents (hundreds of pages).
