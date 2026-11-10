// Template definitions: metadata + CSS only. CV data never lives here.
// In template CSS, `&` stands for the template's root selector (.cv-t-<id>).

export const LEVELS = [
  { id: 'entry', label: 'Entry' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'senior', label: 'Senior' },
  { id: 'advanced', label: 'Advanced' },
];
export const STYLES = ['Standard', 'Formal', 'Modern', 'Minimalist', 'Impressive', 'Professional', 'Creative'];

export const BASE_CSS = `
.cv{--font:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;--px:16mm;--py:14mm;--muted:#5b6470;--rule:#d9dee5;
  box-sizing:border-box;width:210mm;min-height:297mm;padding:var(--py) var(--px);background:#fff;color:#1b1f24;
  font:var(--fs,10pt)/1.42 var(--font);-webkit-print-color-adjust:exact;print-color-adjust:exact;
  box-decoration-break:clone;-webkit-box-decoration-break:clone;overflow-wrap:anywhere;text-align:left}
.cv *,.cv *::before,.cv *::after{box-sizing:border-box}
.cv h1,.cv h2,.cv p,.cv ul,.cv dl,.cv dd,.cv dt{margin:0;padding:0}
.cv ul{list-style:none}
.cv a{color:inherit;text-decoration:none}
.cv-name{font-size:2.3em;line-height:1.1;font-weight:700}
.cv-role{font-size:1.2em;margin-top:.25em;color:var(--accent)}
.cv-contact{display:flex;flex-wrap:wrap;gap:.15em 1.1em;margin-top:.7em;font-size:.95em;color:var(--muted)}
.cv-sec{margin-top:calc(1.35em * var(--gap,1))}
.cv-head+.cv-main>.cv-sec:first-child,.cv-main>.cv-sec:first-child{margin-top:calc(1.1em * var(--gap,1))}
.cv-h{font-size:1.08em;line-height:1.2;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);font-weight:700;margin-bottom:.5em;break-after:avoid;page-break-after:avoid}
.cv-entry{margin-top:calc(.85em * var(--gap,1));break-inside:avoid;page-break-inside:avoid}
.cv-entry:first-child{margin-top:0}
.cv-entry-head{display:flex;justify-content:space-between;align-items:baseline;gap:.2em 1em;flex-wrap:wrap;break-after:avoid}
.cv-entry-title{font-weight:650}
.cv-entry-sub{color:#2d333b}
.cv-entry-date{white-space:nowrap;color:var(--muted);font-size:.95em}
.cv-sep{color:var(--muted)}
.cv-list{list-style:disc !important;padding-left:1.2em !important;margin-top:.3em !important}
.cv-list li{margin-top:.12em;padding-left:.1em}
.cv-label{font-weight:650;font-size:.92em;margin-top:.45em;color:var(--muted)}
.cv-label+.cv-list{margin-top:.12em !important}
.cv-tech,.cv-urls{margin-top:.35em;font-size:.95em;color:var(--muted)}
.cv-label-inline{font-weight:650}
.cv-desc,.cv-summary{margin-top:.2em}
.cv-sec-summary .cv-summary{margin-top:0}
.cv-muted{color:var(--muted)}
.cv-plain li{margin-top:.2em}
.cv-skill-row{display:grid;grid-template-columns:11.5em 1fr;gap:0 .8em;margin-top:.3em}
.cv-skill-row:first-child{margin-top:0}
.cv-skills dt{font-weight:650}
.cv-chips{display:flex;flex-wrap:wrap;column-gap:0}
.cv-chips li:not(:last-child)::after{content:",";margin-right:.3em}
.cv-l-side{display:grid;padding-left:0;padding-right:0;align-content:start}
.cv-l-side .cv-head{grid-area:head}
.cv-l-side .cv-contact{grid-area:contact}
.cv-l-side .cv-main{grid-area:main;min-width:0}
.cv-l-side .cv-aside{grid-area:aside;min-width:0}
.cv-l-side .cv-skill-row{grid-template-columns:1fr;margin-top:.5em}
`;

const T = (id, name, level, style, layout, accent, ats, blurb, css) => ({ id, name, level, style, layout, accent, ats, blurb, css: css.replaceAll('&', `.cv-t-${id}`) });

export const TEMPLATES = [
  T('standard', 'Standard', 'entry', 'Standard', 'single', '#1d4ed8', true, 'Plain single column, maximum ATS compatibility.', `
&{--px:17mm;--py:15mm}
& .cv-head{border-bottom:2px solid #222;padding-bottom:.65em}
& .cv-name{font-size:2.1em}
& .cv-role{color:#333}
& .cv-h{color:#111;border-bottom:1px solid #bbb;padding-bottom:.2em}`),

  T('campus', 'Campus', 'entry', 'Modern', 'single', '#0f766e', false, 'Colour header band and pill skills for first roles.', `
&{--px:16mm;--py:12mm}
& .cv-head{margin:-12mm -16mm 0;padding:12mm 16mm 7mm;background:var(--accent);color:#fff}
& .cv-role,& .cv-contact{color:rgba(255,255,255,.92)}
& .cv-h{border-left:4px solid var(--accent);padding-left:.6em;color:#111}
& .cv-chips{gap:.3em .35em}
& .cv-chips li{border:1px solid var(--accent);color:var(--accent);border-radius:99em;padding:.02em .65em;font-size:.95em}
& .cv-chips li::after{content:none !important}`),

  T('starter', 'Starter', 'entry', 'Minimalist', 'single', '#6b7280', true, 'Light, airy and quiet. Lets your projects talk.', `
&{--px:22mm;--py:20mm;--font:"Segoe UI",system-ui,sans-serif}
& .cv-name{font-size:2em;font-weight:300;letter-spacing:.01em}
& .cv-role{color:var(--muted);font-weight:400}
& .cv-h{text-transform:none;letter-spacing:.02em;font-weight:600;color:#111;font-size:1em;margin-bottom:.6em}
& .cv-entry-date,& .cv-tech,& .cv-urls{font-family:ui-monospace,Consolas,monospace;font-size:.88em}
& .cv-sec{margin-top:calc(1.8em * var(--gap,1))}`),

  T('formal', 'Formal', 'intermediate', 'Formal', 'single', '#7f1d1d', true, 'Traditional serif layout with a centred masthead.', `
&{--font:Georgia,"Times New Roman",serif;--px:20mm;--py:16mm}
& .cv-head{text-align:center;border-bottom:3px double #333;padding-bottom:.8em}
& .cv-role{color:#333;font-style:italic}
& .cv-contact{justify-content:center}
& .cv-h{font-variant:small-caps;text-transform:none;letter-spacing:.06em;font-size:1.2em;color:#111;border-bottom:1px solid #333;padding-bottom:.12em}`),

  T('pipeline', 'Pipeline', 'intermediate', 'Modern', 'single', '#0e7490', false, 'Experience on a vertical timeline.', `
&{--px:17mm;--py:15mm}
& .cv-name{font-size:2.5em;letter-spacing:-.01em}
& .cv-head::after{content:"";display:block;width:16mm;height:3px;background:var(--accent);margin-top:.7em}
& .cv-sec-experience .cv-entry{position:relative;padding-left:1.3em;border-left:2px solid var(--accent);margin-left:.3em;padding-bottom:.2em}
& .cv-sec-experience .cv-entry::before{content:"";position:absolute;left:-.48em;top:.35em;width:.7em;height:.7em;border-radius:50%;background:#fff;border:2px solid var(--accent)}
& .cv-h{letter-spacing:.12em;font-size:1em}
& .cv-chips{gap:.25em .3em}
& .cv-chips li{background:#ecfeff;border-radius:3px;padding:0 .5em}
& .cv-chips li::after{content:none !important}`),

  T('sidebar', 'Sidebar', 'intermediate', 'Professional', 'side', '#38bdf8', false, 'Dark sidebar for contact and skills, main column for experience.', `
&{--side:66mm;--py:14mm;background:linear-gradient(to right,#1e293b 66mm,#fff 66mm);grid-template-columns:66mm 1fr;grid-template-areas:"contact head" "aside main";grid-template-rows:auto 1fr}
& .cv-contact{flex-direction:column;color:#e2e8f0;margin:0;padding:0 7mm 0;font-size:.92em;align-self:start;overflow-wrap:anywhere}
& .cv-head{padding:0 14mm 0 10mm}
& .cv-main{padding:0 14mm 0 10mm}
& .cv-aside{padding:6mm 7mm 0;color:#e2e8f0}
& .cv-aside .cv-h{color:#fff;border-bottom:1px solid rgba(255,255,255,.3);padding-bottom:.25em}
& .cv-aside .cv-skills dt,& .cv-aside .cv-entry-sub,& .cv-aside strong{color:#fff}
& .cv-aside .cv-muted,& .cv-aside .cv-entry-date{color:#cbd5e1}
& .cv-name{color:#0f172a}
& .cv-role{color:#0369a1}
& .cv-main .cv-h{color:#0f172a;border-bottom:2px solid #38bdf8;padding-bottom:.2em}`),

  T('clean', 'Clean', 'intermediate', 'Minimalist', 'single', '#334155', true, 'Quiet left labels, wide content column.', `
&{--px:16mm;--py:15mm}
& .cv-name{font-size:2.1em;font-weight:600}
& .cv-role{color:var(--muted)}
& .cv-sec{display:grid;grid-template-columns:32mm 1fr;gap:0 6mm;border-top:1px solid var(--rule);padding-top:.9em}
& .cv-sec-body{min-width:0}
& .cv-h{text-transform:none;letter-spacing:0;color:#111;font-size:1em;margin:0}
& .cv-skill-row{grid-template-columns:9em 1fr}`),

  T('terminal', 'Terminal', 'senior', 'Creative', 'single', '#16a34a', false, 'Monospace, dark header, built for engineers.', `
&{--font:ui-monospace,"Cascadia Code",Consolas,"SF Mono",Menlo,monospace;--px:15mm;--py:12mm;font-size:calc(var(--fs,10pt) * .94)}
& .cv-head{margin:-12mm -15mm 0;padding:12mm 15mm 7mm;background:#0d1117;color:#e6edf3}
& .cv-name{color:var(--accent);font-size:2em}
& .cv-name::before{content:"$ ";color:#6e7681}
& .cv-role{color:#e6edf3}
& .cv-contact{color:#9da7b3}
& .cv-h{text-transform:none;letter-spacing:0;color:#111;font-size:1.1em}
& .cv-h::before{content:"## ";color:var(--accent)}
& .cv-chips{gap:.25em .3em}
& .cv-chips li{border:1px solid #c9d1d9;border-radius:3px;padding:0 .5em;background:#f6f8fa}
& .cv-chips li::after{content:none !important}
& .cv-entry-title{color:#0d1117}`),

  T('ledger', 'Ledger', 'senior', 'Professional', 'side', '#1e40af', false, 'Dense two-column layout with a skills rail.', `
&{--side:60mm;--py:13mm;font-size:calc(var(--fs,10pt) * .97);background:linear-gradient(to right,#fff calc(210mm - 60mm),#f1f5f9 calc(210mm - 60mm));grid-template-columns:1fr 60mm;grid-template-areas:"head aside" "contact aside" "main aside";grid-template-rows:auto auto 1fr}
& .cv-head{padding:0 10mm 0 15mm}
& .cv-contact{padding:0 10mm 0 15mm;margin-top:.5em}
& .cv-main{padding:0 10mm 0 15mm}
& .cv-aside{padding:0 7mm 0 7mm}
& .cv-name{font-size:2.2em;color:#0f172a}
& .cv-head{border-bottom:3px solid var(--accent);padding-bottom:.5em;margin-right:0}
& .cv-h{font-size:1em;border-bottom:1px solid var(--rule);padding-bottom:.15em}
& .cv-sec{margin-top:calc(1.1em * var(--gap,1))}
& .cv-aside .cv-sec:first-child{margin-top:0}
& .cv-aside .cv-skills dt{color:#0f172a}
& .cv-entry-title{color:#0f172a}`),

  T('spotlight', 'Spotlight', 'senior', 'Impressive', 'single', '#6d28d9', false, 'Bold gradient banner and accent bars that stand out.', `
&{--px:16mm;--py:12mm}
& .cv-head{margin:-12mm -16mm 0;padding:14mm 16mm 9mm;background:linear-gradient(120deg,var(--accent),#be185d);color:#fff}
& .cv-name{font-size:2.9em;font-weight:800;letter-spacing:-.02em}
& .cv-role{color:#fff;opacity:.95;font-size:1.3em}
& .cv-contact{color:rgba(255,255,255,.95)}
& .cv-h{display:flex;align-items:center;gap:.6em;color:#111;font-size:1.15em}
& .cv-h::before{content:"";width:1.6em;height:.28em;background:var(--accent);border-radius:99em}
& .cv-entry{padding-left:.8em;border-left:3px solid color-mix(in srgb,var(--accent) 30%,#fff)}
& .cv-chips{gap:.3em .35em}
& .cv-chips li{background:color-mix(in srgb,var(--accent) 12%,#fff);color:var(--accent);border-radius:4px;padding:.02em .6em;font-weight:600}
& .cv-chips li::after{content:none !important}`),

  T('prism', 'Prism', 'senior', 'Modern', 'single', '#0891b2', false, 'Clean white page with tinted headings and project cards.', `
&{--px:16mm;--py:14mm}
& .cv-head{border-top:7px solid var(--accent);padding-top:.8em}
& .cv-name{font-size:2.5em;letter-spacing:-.015em}
& .cv-h{background:color-mix(in srgb,var(--accent) 12%,#fff);color:#0f172a;padding:.3em .7em;border-radius:4px;letter-spacing:.06em;font-size:1em}
& .cv-sec-projects .cv-entry{border:1px solid var(--rule);border-radius:6px;padding:.6em .85em;background:#f9fafb}
& .cv-chips{gap:.25em .3em}
& .cv-chips li{border:1px solid var(--rule);border-radius:4px;padding:0 .5em;background:#fff}
& .cv-chips li::after{content:none !important}`),

  T('executive', 'Executive', 'advanced', 'Formal', 'single', '#8a6d3b', true, 'Restrained serif with a leadership-first summary.', `
&{--font:Georgia,"Times New Roman",serif;--px:21mm;--py:17mm}
& .cv-name{font-size:2.4em;text-transform:uppercase;letter-spacing:.14em;font-weight:600}
& .cv-role{color:#333;letter-spacing:.04em}
& .cv-head{border-bottom:1px solid var(--accent);padding-bottom:.8em}
& .cv-contact li+li::before{content:"|";margin-right:1.1em;color:var(--rule)}
& .cv-contact{gap:.15em 1.1em}
& .cv-sec-summary .cv-summary{font-size:1.1em;font-style:italic;line-height:1.5}
& .cv-h{color:#111;letter-spacing:.16em;font-size:.95em;border-bottom:1px solid var(--accent);padding-bottom:.25em}`),

  T('architect', 'Architect', 'advanced', 'Professional', 'side', '#b45309', false, 'Dark masthead, tech-landscape rail on the left.', `
&{--py:0;grid-template-columns:62mm 1fr;grid-template-areas:"head head" "contact contact" "aside main";grid-template-rows:auto auto 1fr}
& .cv-head{background:#1f2937;color:#fff;padding:14mm 16mm 6mm}
& .cv-name{font-size:2.5em}
& .cv-role{color:#fbbf24}
& .cv-contact{margin:0;padding:3mm 16mm;background:#f3f4f6;border-bottom:1px solid var(--rule)}
& .cv-aside{padding:7mm 6mm 12mm 16mm;border-right:1px solid var(--rule);margin-top:0}
& .cv-main{padding:0 16mm 12mm 8mm}
& .cv-h{color:#1f2937;border-left:3px solid var(--accent);padding-left:.55em}
& .cv-aside .cv-sec:first-child{margin-top:0}
& .cv-aside .cv-sec{margin-top:calc(1.1em * var(--gap,1))}`),

  T('keynote', 'Keynote', 'advanced', 'Impressive', 'single', '#e11d48', false, 'Big typography and numbered achievements.', `
&{--px:17mm;--py:14mm;border-left:8mm solid var(--accent);width:210mm;padding-left:12mm}
& .cv-name{font-size:3.3em;font-weight:800;text-transform:uppercase;letter-spacing:-.02em;line-height:1}
& .cv-role{font-size:1.3em;font-weight:600;margin-top:.4em}
& .cv-h{font-size:1.5em;text-transform:none;letter-spacing:-.01em;font-weight:800;color:#111;display:inline-block;border-bottom:3px solid var(--accent);padding-bottom:.05em}
& .cv-label+.cv-list{list-style:none !important;padding-left:0 !important;counter-reset:ach}
& .cv-label+.cv-list li{counter-increment:ach;position:relative;padding-left:2.4em;margin-top:.3em}
& .cv-label+.cv-list li::before{content:counter(ach,decimal-leading-zero);position:absolute;left:0;top:-.12em;font-size:1.5em;font-weight:800;color:var(--accent);line-height:1.2}`),
];

const byId = new Map(TEMPLATES.map(t => [t.id, t]));
export const getTemplate = id => byId.get(id) || TEMPLATES[0];

// Concatenated stylesheet for preview and the gallery (all templates; scoped by class).
export const allCSS = () => BASE_CSS + TEMPLATES.map(t => t.css).join('\n');
export const cssFor = id => BASE_CSS + getTemplate(id).css;
