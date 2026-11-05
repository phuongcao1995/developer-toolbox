/*
 * load-vendor.js — runs after the local vendor/ scripts.
 * If a local copy is missing, loads the pinned version from its official CDN instead.
 * Must stay a classic, synchronous script so document.write keeps load order.
 */
(function () {
  'use strict';
  if (!window.ExcelJS) {
    document.write('<script src="https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js" ' +
      'integrity="sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz" crossorigin="anonymous"><\/script>');
  }
  if (!window.XLSX) {
    // SheetJS publishes current releases only on its own CDN (the npm registry copy is outdated).
    document.write('<script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"><\/script>');
  }
})();
