// Export helpers: print-to-PDF through an isolated iframe, plus text/JSON/HTML files.
import { renderCV, renderText, esc } from './render.js';
import { cssFor } from './templates.js';
import { exportJSON } from './model.js';

export const PRINT_CSS = `
@page{size:A4;margin:0}
html,body{margin:0;padding:0;background:#fff}
.cv{min-height:296mm !important;margin:0 !important;box-shadow:none !important;zoom:1 !important}
`;

export function fileBase(cv) {
  const n = (cv.personal.name || 'CV').trim().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');
  return (n || 'CV') + '_CV';
}

// Full standalone HTML document of the CV (same markup and CSS as the preview).
export function buildDocument(cv) {
  const title = `${cv.personal.name || 'CV'}${cv.personal.title ? ' - ' + cv.personal.title : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${cssFor(cv.settings.template)}${PRINT_CSS}</style></head><body>${renderCV(cv)}</body></html>`;
}

// Opens the browser print dialog (choose "Save as PDF"). Resolves when the dialog was triggered.
export function printCV(cv, host = document) {
  return new Promise((resolve, reject) => {
    const frame = host.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', visibility: 'hidden' });
    let done = false;
    const cleanup = () => { if (done) return; done = true; setTimeout(() => frame.remove(), 500); };
    frame.onload = () => {
      const w = frame.contentWindow;
      if (!w) { cleanup(); reject(new Error('Print frame unavailable')); return; }
      w.addEventListener('afterprint', cleanup);
      setTimeout(cleanup, 5 * 60 * 1000);
      // Let layout settle (fonts, grid) before the dialog snapshots pages.
      requestAnimationFrame(() => setTimeout(() => {
        try { w.focus(); w.print(); resolve(); } catch (e) { cleanup(); reject(e); }
      }, 50));
    };
    frame.srcdoc = buildDocument(cv);
    host.body.append(frame);
  });
}

export const asText = cv => renderText(cv);
export const asJSON = cv => exportJSON(cv);
export const asHTML = cv => buildDocument(cv);
