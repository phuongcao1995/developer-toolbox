// Pure renderer: CV data + template id -> semantic HTML string. All user text is escaped.
import { SECTIONS, sectionHasContent, FONT_STACKS } from './model.js';
import { getTemplate } from './templates.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only http(s) and mailto links are ever emitted; bare domains get https://.
export function safeHref(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^mailto:/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ''; // javascript:, data:, etc.
  return 'https://' + s.replace(/^\/+/, '');
}
const shortUrl = s => String(s).trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
const link = (url, label) => {
  const href = safeHref(url);
  const text = esc(label ?? shortUrl(url));
  return href ? `<a href="${esc(href)}">${text}</a>` : text;
};

const SIDE = new Set(['skills', 'languages', 'certifications', 'awards']);

const list = items => (items.length ? `<ul class="cv-list">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
const chips = items => (items.length ? `<ul class="cv-chips">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
const meta = parts => parts.filter(Boolean).map(p => `<span>${p}</span>`).join('<span class="cv-sep" aria-hidden="true"> · </span>');

function entry(head, rest) {
  return `<div class="cv-entry"><div class="cv-entry-head">${head}</div>${rest}</div>`;
}
const head = (title, sub, date) =>
  `<div class="cv-entry-main">${title ? `<strong class="cv-entry-title">${esc(title)}</strong>` : ''}${title && sub ? '<span class="cv-sep" aria-hidden="true"> — </span>' : ''}${sub ? `<span class="cv-entry-sub">${sub}</span>` : ''}</div>${date ? `<span class="cv-entry-date">${esc(date)}</span>` : ''}`;

const RENDERERS = {
  summary: cv => `<p class="cv-summary">${esc(cv.summary.trim()).replace(/\n+/g, '<br>')}</p>`,
  skills: cv => `<dl class="cv-skills">${cv.skills.filter(g => g.items.length).map(g => `<div class="cv-skill-row"><dt>${esc(g.label || 'Other')}</dt><dd>${chips(g.items)}</dd></div>`).join('')}</dl>`,
  experience: cv => cv.experience.filter(e => e.position || e.company || e.responsibilities.length || e.achievements.length).map(e => entry(
    head(e.position, esc(e.company) + (e.location ? `<span class="cv-loc">, ${esc(e.location)}</span>` : ''), e.period),
    list(e.responsibilities) +
    (e.achievements.length ? `<p class="cv-label">Key achievements</p>${list(e.achievements)}` : '') +
    (e.tech.length ? `<p class="cv-tech"><span class="cv-label-inline">Technologies:</span> ${esc(e.tech.join(', '))}</p>` : ''))).join(''),
  projects: cv => cv.projects.filter(p => p.name || p.description || p.contributions.length).map(p => entry(
    head(p.name, '', ''),
    (p.description ? `<p class="cv-desc">${esc(p.description)}</p>` : '') +
    list(p.contributions) +
    (p.stack.length ? `<p class="cv-tech"><span class="cv-label-inline">Stack:</span> ${esc(p.stack.join(', '))}</p>` : '') +
    ((p.github || p.demo) ? `<p class="cv-urls">${[p.github, p.demo].filter(Boolean).map(u => link(u)).join(' · ')}</p>` : ''))).join(''),
  education: cv => cv.education.filter(e => e.school || e.degree).map(e => entry(
    head(e.school, esc(e.degree), e.period), e.details ? `<p class="cv-desc">${esc(e.details)}</p>` : '')).join(''),
  certifications: cv => `<ul class="cv-plain">${cv.certifications.filter(c => c.name).map(c => `<li><strong>${esc(c.name)}</strong>${c.issuer || c.date ? `<span class="cv-muted"> — ${meta([esc(c.issuer), esc(c.date)])}</span>` : ''}</li>`).join('')}</ul>`,
  languages: cv => `<ul class="cv-plain">${cv.languages.filter(l => l.name).map(l => `<li><strong>${esc(l.name)}</strong>${l.level ? `<span class="cv-muted"> — ${esc(l.level)}</span>` : ''}</li>`).join('')}</ul>`,
  awards: cv => cv.awards.filter(a => a.title).map(a => entry(
    head(a.title, esc(a.issuer), a.date), a.description ? `<p class="cv-desc">${esc(a.description)}</p>` : '')).join(''),
  publications: cv => `<ul class="cv-plain">${cv.publications.filter(p => p.title).map(p => `<li><strong>${esc(p.title)}</strong>${p.venue || p.date ? `<span class="cv-muted"> — ${meta([esc(p.venue), esc(p.date)])}</span>` : ''}${p.url ? ` ${link(p.url)}` : ''}</li>`).join('')}</ul>`,
};

export function contactItems(p) {
  const out = [];
  if (p.email) out.push(link('mailto:' + p.email, p.email));
  if (p.phone) out.push(esc(p.phone));
  if (p.location) out.push(esc(p.location));
  if (p.github) out.push(link(p.github));
  if (p.linkedin) out.push(link(p.linkedin));
  if (p.website) out.push(link(p.website));
  return out;
}

function sectionHtml(cv, id) {
  return `<section class="cv-sec cv-sec-${id}" data-section="${id}"><h2 class="cv-h">${esc(SECTIONS[id].label)}</h2><div class="cv-sec-body">${RENDERERS[id](cv)}</div></section>`;
}

// Inline CSS variables from user settings (colour, font, size, density).
export function styleVars(cv, tpl) {
  const s = cv.settings;
  const dens = { compact: 0.78, normal: 1, relaxed: 1.25 }[s.density] ?? 1;
  const font = FONT_STACKS[s.font];
  return [
    `--accent:${s.color || tpl.accent}`,
    font ? `--font:${font}` : '',
    `--fs:${s.size}pt`,
    `--gap:${dens}`,
  ].filter(Boolean).join(';');
}

// Which sections appear, in the user's order (hidden and empty ones skipped).
export function visibleSections(cv) {
  return cv.order.filter(o => o.visible && sectionHasContent(cv, o.id)).map(o => o.id);
}

export function renderCV(cv, templateId) {
  const tpl = getTemplate(templateId || cv.settings.template);
  const p = cv.personal;
  const ids = visibleSections(cv);
  const contact = contactItems(p);
  const contactHtml = contact.length ? `<ul class="cv-contact">${contact.map(c => `<li>${c}</li>`).join('')}</ul>` : '';
  const nameHtml = `<header class="cv-head"><h1 class="cv-name">${esc(p.name || 'Your Name')}</h1>${p.title ? `<p class="cv-role">${esc(p.title)}</p>` : ''}${tpl.layout === 'single' ? contactHtml : ''}</header>`;
  let body;
  if (tpl.layout === 'side') {
    const side = ids.filter(i => SIDE.has(i)).map(i => sectionHtml(cv, i)).join('');
    const main = ids.filter(i => !SIDE.has(i)).map(i => sectionHtml(cv, i)).join('');
    body = `${nameHtml}${contactHtml}<main class="cv-main">${main}</main><aside class="cv-aside">${side}</aside>`;
  } else {
    body = `${nameHtml}<main class="cv-main">${ids.map(i => sectionHtml(cv, i)).join('')}</main>`;
  }
  return `<article class="cv cv-t-${tpl.id} cv-l-${tpl.layout}" style="${esc(styleVars(cv, tpl))}">${body}</article>`;
}

// Plain-text rendering (ATS check / paste into web forms).
export function renderText(cv) {
  const p = cv.personal;
  const lines = [p.name, p.title, [p.email, p.phone, p.location, p.github, p.linkedin, p.website].filter(Boolean).join(' | ')].filter(Boolean);
  for (const id of visibleSections(cv)) {
    lines.push('', SECTIONS[id].label.toUpperCase());
    if (id === 'summary') lines.push(cv.summary.trim());
    else if (id === 'skills') for (const g of cv.skills.filter(g => g.items.length)) lines.push(`${g.label}: ${g.items.join(', ')}`);
    else if (id === 'experience') for (const e of cv.experience) {
      lines.push('', [e.position, e.company].filter(Boolean).join(' - ') + (e.period ? ` (${e.period})` : ''));
      for (const r of [...e.responsibilities, ...e.achievements]) lines.push('- ' + r);
      if (e.tech.length) lines.push('Technologies: ' + e.tech.join(', '));
    } else if (id === 'projects') for (const x of cv.projects) {
      lines.push('', [x.name, x.github, x.demo].filter(Boolean).join(' | '));
      if (x.description) lines.push(x.description);
      for (const r of x.contributions) lines.push('- ' + r);
      if (x.stack.length) lines.push('Stack: ' + x.stack.join(', '));
    } else {
      for (const e of cv[id]) lines.push(Object.entries(e).filter(([k, v]) => k !== 'id' && v && !Array.isArray(v)).map(([, v]) => v).join(' | '));
    }
  }
  return lines.join('\n') + '\n';
}
