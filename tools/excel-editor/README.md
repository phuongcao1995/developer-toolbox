# Sheet Editor

A spreadsheet editor that runs entirely in your browser. Open `.xlsx`, `.xls` and `.csv` files, edit them in a familiar grid, and download the result. There is no server and no build step, and files never leave your computer.

> **In the Developer Toolbox copy** both libraries (ExcelJS and SheetJS) are bundled in `vendor/` and are loaded on demand, so the editor starts before they arrive. The CDN fallback described below was removed.

## Getting started

1. Open `index.html` in a modern browser (Chrome, Edge, Firefox or Safari). Double-clicking the file works; so does any static web server.
2. To work **offline**, download the two libraries once:

   ```sh
   ./scripts/download-vendor.sh
   ```

   On Windows (PowerShell):

   ```powershell
   iwr https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js -OutFile vendor/xlsx.full.min.js
   iwr https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js -OutFile vendor/exceljs.min.js
   ```

ExcelJS is already included in `vendor/`. SheetJS is not bundled, because its current release is published only on the SheetJS CDN and the older npm copy (0.18.5) has known security issues. When `vendor/xlsx.full.min.js` is missing, the app loads SheetJS 0.20.3 from the CDN automatically. Without it, `.xlsx` and `.csv` still work, but `.xls` and Excel number-format display are unavailable, and the app says so.

## Libraries and why

| Library | Used for | Notes |
|---|---|---|
| ExcelJS 4.4.0 (MIT) | Reading and writing `.xlsx` | The only evaluated library that writes formatting back. Cannot read `.xls`. |
| SheetJS CE 0.20.3 (Apache-2.0) | Reading `.xls`, writing `.xls`, rendering number formats | The free edition drops styles on write, and its `.xls` writer does not save formulas. |
| None (built in) | CSV, the grid, the formula engine | Keeps control over delimiters, encodings and CSV-injection escaping. |

Univer and Jspreadsheet were evaluated and not used: they would duplicate the grid, add a large dependency, and raise licensing questions for some features.

## Features

**Files.** Open with the Open button, Ctrl+O, or drag and drop. Formats are detected from file contents, not just the extension, so a mislabeled file is still read correctly. The header shows the file name, format, sheet count and size. Unsaved changes are flagged, and you are warned before anything is discarded (New, Open, closing the tab).

**Grid.** Only visible cells are drawn, so large sheets scroll smoothly (a 100,000-row sheet renders in under 10 ms per frame). Other grid features:
- row numbers and column letters
- frozen panes
- column and row resizing by dragging (double-click a column edge to auto-fit)
- merged cells
- text that overflows into empty neighbouring cells
- markers for notes and for formulas that were not recalculated

**Editing.**
- Click to select. Double-click, F2 or Enter to edit, or start typing.
- Arrow keys, Tab, Enter, Home/End, Page Up/Down, and Ctrl+Arrow to jump to the edge of a data block.
- Shift extends the selection; drag to select ranges.
- Cut, copy and paste work within the app (formulas adjust their references) and with other programs (tab-separated text).
- Undo and redo up to 200 steps.
- Insert and delete rows and columns. Formulas everywhere update, including on other sheets.
- Hide and show rows and columns (Rows & columns menu). Hidden columns are kept when you save.
- Paste special (right-click): values only, formulas only, formatting only, transposed.
- Format painter: copy the active cell's formatting onto the next cells you select.
- Sheet tab colours (right-click a tab); colours from files are shown and saved.
- Find and replace, searching either displayed values or contents.
- Vietnamese input methods (Telex/VNI, Unikey, OS keyboards) work from the first keystroke.

**Worksheets.** Add, rename, duplicate, reorder (drag or menu) and delete sheets. Renaming a sheet updates formulas that refer to it. Each sheet remembers its own selection and scroll position.

**Formatting.**
- Font, size, bold, italic, underline
- Text and fill colour
- Horizontal and vertical alignment, wrapping
- Borders
- Merge and unmerge
- Number formats, including date, percent, currency and custom formats from files, plus more/fewer decimals

The formula bar area shows the **stored value** next to the **format**, so changing how a value looks is never confused with changing the value itself.

**Formulas.** Type a formula beginning with `=`. About 110 functions are calculated:
- **Maths and statistics:** SUM, AVERAGE, MIN, MAX, MEDIAN, LARGE, SMALL, RANK, STDEV, STDEV.S, STDEV.P, VAR, VAR.S, VAR.P, COUNT, COUNTA, COUNTBLANK, PRODUCT, SUMPRODUCT, ROUND, ROUNDUP, ROUNDDOWN, CEILING, FLOOR, TRUNC, INT, ABS, SIGN, MOD, POWER, SQRT, EXP, LN, LOG, LOG10, PI
- **Conditional:** COUNTIF, SUMIF, AVERAGEIF, COUNTIFS, SUMIFS, AVERAGEIFS, MAXIFS, MINIFS
- **Lookup:** VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH, CHOOSE, ROW, COLUMN, ROWS, COLUMNS
- **Logical:** IF, IFS, SWITCH, IFERROR, IFNA, AND, OR, NOT, XOR, TRUE, FALSE, ISBLANK, ISNUMBER, ISTEXT, ISNONTEXT, ISLOGICAL, ISERROR, ISNA
- **Text:** CONCAT, CONCATENATE, TEXTJOIN, LEN, LEFT, RIGHT, MID, FIND, SEARCH, SUBSTITUTE, REPLACE, REPT, UPPER, LOWER, PROPER, TRIM, CLEAN, EXACT, CHAR, CODE, TEXT, VALUE
- **Date and time:** TODAY, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY, EDATE, EOMONTH, DAYS, DATEDIF, DATEVALUE, TIME, HOUR, MINUTE, SECOND. A cell given `=DATE(...)` or similar gets a date format automatically.

**Writing formulas.**
- Click or drag over cells while typing a formula and their addresses are inserted; each reference gets a coloured box on the grid.
- Press F4 with the caret on a reference to cycle `A1` → `$A$1` → `A$1` → `$A1`.
- Function names are suggested as you type (Up/Down to choose, Tab to accept).
- Drag the small square at the corner of the selection (the fill handle) to continue a series: numbers, dates, `Item 1`, weekday and month names. Formulas shift their references. Ctrl+D and Ctrl+R copy the first row or column over the selection.

Operators, cross-sheet references (`'Dữ liệu'!B2`), absolute references (`$A$1`) and whole-column ranges (`A:A`) are supported. Errors (#DIV/0!, #VALUE!, #REF!, #NAME?) are shown in red. Circular references show `#CIRC!`.

**A function the editor cannot calculate is never replaced with a wrong answer.** It keeps the result saved in the file, is marked with an amber corner and an explanation, and Excel recalculates it when the file is opened (saved files request a full recalculation on load). A syntax error keeps the editor open with a message instead of saving a broken formula.

**Data.**
- Sort A→Z or Z→A by the active column, with automatic header detection, or use a custom two-level sort.
- Filter rows by conditions (contains, equals, greater than, empty and more).
- Data validation: whole number, decimal, list or text length, with reject or warn behaviour.
- Show cells that break validation.
- Highlight duplicate values.
- **Conditional formatting** (Rules menu): highlight cells by value, text, top/bottom N, above/below average, duplicates or a formula; 2- and 3-colour scales; manage and delete rules. Rules are saved in the .xlsx and read back from files.
- **Remove duplicate rows** (choose the columns that count) and **Text to columns** (comma, semicolon, tab, space, pipe or your own separator).
- The status bar shows count, sum and average for the selection.

**Download.** Choose `.xlsx`, `.xls` or `.csv`. Before you download, the dialog lists exactly what the chosen format will not include. The original format is preselected when nothing would be lost; otherwise `.xlsx` is selected and the reason is shown. CSV options include:
- sheet choice
- separator: comma, semicolon, tab or bar
- decimal point or comma
- values as displayed or raw
- a byte-order mark so Excel reads accents correctly
- protection against formula injection (text starting with `= + - @` is prefixed with an apostrophe; negative numbers are untouched)

Only a lossless download clears the "Unsaved changes" flag.

## Keyboard shortcuts

| Action | Keys |
|---|---|
| Open / Download | Ctrl+O / Ctrl+S |
| Undo / Redo | Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) |
| Bold / Italic / Underline | Ctrl+B / Ctrl+I / Ctrl+U |
| Find / Replace | Ctrl+F / Ctrl+H |
| Copy / Cut / Paste | Ctrl+C / Ctrl+X / Ctrl+V |
| Edit cell | Enter, F2, or double-click |
| Commit and move | Enter (down), Shift+Enter (up), Tab (right), Shift+Tab (left) |
| New line inside a cell | Alt+Enter |
| Cancel editing | Esc |
| Jump to data edge | Ctrl+Arrow |
| First column / last used column | Home / End |
| Top-left / last used cell | Ctrl+Home / Ctrl+End |
| Select all | Ctrl+A |
| Fill down / fill right | Ctrl+D / Ctrl+R |
| Cycle `$` on a reference (while editing a formula) | F4 |
| Insert today's date / current time | Ctrl+; / Ctrl+Shift+; |
| Paste values only | Ctrl+Shift+V (after copying inside the editor) |
| Clear contents | Delete or Backspace |
| Go to a cell or range | Type it in the name box (`C5`, `A1:D10`, `Sheet2!B3`) and press Enter |

On a Mac, use Cmd instead of Ctrl.

## Usage examples

**Fix one value in a report.** Open `report.xlsx`, double-click the cell, type the new value, and press Enter. Totals that depend on it recalculate. Press Ctrl+S and choose Download. The `.xlsx` keeps every sheet, formula and style.

**Clean a CSV export from a Vietnamese system.** Open `khach-hang.csv`. The import dialog detects the separator (for example `;`), the encoding (UTF-8, or Windows-1258 for older files) and decimal commas, and shows a preview. Codes such as `007` and long ID numbers stay as text. Sort or filter, highlight duplicates, then download as `.csv` with the same separator, or as `.xlsx`.

**Turn several CSV-style sheets into one workbook.** Open a file, add sheets with `+`, paste data from other programs into each (Ctrl+V), and download as `.xlsx`.

## Format support and known limitations

| | .xlsx | .xls | .csv |
|---|---|---|---|
| Values, formulas | Read and write | Read; written as **results only** | Read; written as results |
| Fonts, colours, borders, alignment | Read and write | Not read, not written | — |
| Number formats | Read and write | Read and write | Saved as displayed text |
| Merges, sizes, frozen panes | Read and write | Merges and sizes only | — |
| Multiple sheets | Yes | Yes | One sheet per file |

**Not kept when saving** (the app lists these when you open the file and again before you download):
- charts
- pivot tables
- macros (`.xlsm` files are saved as `.xlsx`)
- links to other workbooks
- slicers and form controls
- shapes and text boxes
- threaded comments (classic notes are kept)
- Excel tables, which become plain ranges with their data intact
- array formulas, which are saved as regular formulas
- mixed formatting within one cell, where the text is kept

**Kept but not shown or edited:**
- Images are written back unchanged, not displayed. Data bars and icon sets are kept but not drawn, and conditional formatting does not move when rows or columns are inserted or deleted.
- Named ranges are kept. Formulas that use them keep their saved results.
- Theme colours from the file are kept but drawn without colour.
- Validation rules for dates, times, custom formulas, and lists that come from a cell range are kept but not checked while editing.

**Other limitations:**
- Formula functions outside the list above are not calculated (see "Formulas"). Merging cells keeps only the top-left value (you are asked first).
- Cutting and pasting moves cells but does not update formulas elsewhere that pointed at them.
- Filter conditions are applied as hidden rows. Excel shows the filter arrows but not the conditions.
- Dates before 1 March 1900 follow JavaScript dates rather than Excel's 1900 leap-year bug, so they may differ by one day.
- Typed dates are read as `yyyy-mm-dd` or day-first `dd/mm/yyyy`.
- `.xls` files are limited to 65,536 rows and 256 columns. Larger sheets must be saved as `.xlsx`.
- Password-protected files cannot be opened. Remove the password in Excel first.
- Very large files take a while because everything runs on your computer. A 1-million-cell `.xlsx` (5 MB) took about 4–7 s to open and about 10 s to save in testing. The app shows progress, and asks before opening files over 30 MB. The limit is 300 MB.

## Project structure

```
index.html            Page markup; toolbar controls are static, labelled buttons
css/styles.css        All styles
js/utils.js           Addresses, CSV, encodings, file sniffing, value parsing and display, DOM helper
js/formula.js         Formula tokenizer, parser and evaluator; reference rewriting
js/spreadsheet.js     Workbook model: cells, calculation, undo/redo, all editing operations
js/file-manager.js    Format detection, import, export, and what-will-be-lost warnings
js/grid.js            Virtualized grid: rendering, selection, editing, resizing, clipboard
js/dialogs.js         Accessible dialogs, menus, toasts
js/condfmt.js         Conditional formatting rules and evaluation
js/toolbar.js         Toolbar, formula bar, sheet tabs, status bar, find/sort/filter/validation
js/app.js             Wiring, open/new/download flows, shortcuts, unsaved-change protection
js/load-vendor.js     Falls back to pinned CDN builds when vendor/ files are missing
vendor/               Browser libraries (ExcelJS included; SheetJS via scripts/download-vendor.sh)
tests/                Unit, round-trip and browser tests
```

The model (`spreadsheet.js`) has no DOM code and is tested directly in Node. The grid and toolbar listen to model change events. Everything lives under one global, `window.SheetApp`. Classic scripts are used (not ES modules) so the page works when opened straight from disk.

## Security

- Formulas are parsed and interpreted. `eval` and `new Function` are never used.
- Spreadsheet content is always inserted with `textContent`, never as HTML. Cells and sheet names containing markup display as plain text (this is tested).
- A Content Security Policy blocks inline scripts and `eval`, limits scripts to this folder and the two pinned CDNs, and sets `connect-src 'none'`, so the page cannot send data anywhere.
- CSV export protects against formula injection by default, and CSV import treats `=` values as text unless you opt in.
- Files are checked by content (zip, OLE or text) and size before parsing. Damaged, mislabeled, empty and unsupported files get a specific message.

## Testing

```sh
cd tests
npm install                # ExcelJS and SheetJS for Node (test-only)
npm test                   # 18 unit tests + 10 import/export round-trip tests
python3 make_fixtures.py   # run inside tests/fixtures; needs openpyxl and LibreOffice
pip install playwright && playwright install chromium
python3 ui_test.py         # 19 end-to-end browser tests
```

Run `make_fixtures.py` from inside `tests/fixtures/`. The round-trip tests and the UI download tests also convert every exported file with LibreOffice when it is installed (`soffice`). This confirms that the files open correctly in an independent spreadsheet program.

The tests cover every case in the original brief:
- `.xlsx`, `.xls` and Vietnamese CSV round trips
- empty cells, duplicates, dates, numbers and formulas
- multiple sheets
- corrupted, unsupported and 1-million-cell files
- edits present in downloaded files
- names and data preserved
- CSV escaping of commas, quotes and newlines
- unsupported features reported rather than silently lost

The UI tests drive the real interface with clicks and keystrokes. They cover editing, input-method text, clipboard, formatting, structure changes, sheets, find/replace, sort, filter, validation, merges, resizing, freezing, the context menu, all download formats, the unsaved-changes guard, and error dialogs.
