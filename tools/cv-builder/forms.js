// Form builder driven by the section registry in model.js. Mutates the CV object in place.
import { el, renderIcons } from '../../assets/js/components/ui.js';
import { SECTIONS, PERSONAL_FIELDS, blankEntry, newId, strList, tagList, isEmail, isUrl } from './model.js';

const iconBtn = (name, label, onclick, extra = {}) =>
  el('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': label, title: label, onclick, ...extra }, el('i', { 'data-lucide': name }));

function move(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}

// A single labelled control bound to obj[key]. Value conversion depends on the field type.
function control(f, obj, onInput, idBase) {
  const id = `${idBase}-${f.key}`;
  let input;
  const val = obj[f.key];
  if (f.type === 'area' || f.type === 'lines' || f.type === 'tags') {
    input = el('textarea', { class: 'textarea', id, rows: f.type === 'area' ? 3 : f.type === 'tags' ? 2 : 4, placeholder: f.placeholder || '' });
    input.value = Array.isArray(val) ? (f.type === 'tags' ? val.join(', ') : val.join('\n')) : val || '';
  } else {
    input = el('input', { class: 'input', id, type: f.type === 'email' ? 'email' : 'text', placeholder: f.placeholder || '', autocomplete: f.autocomplete || 'off', spellcheck: f.type === 'url' || f.type === 'email' ? 'false' : null });
    input.value = val || '';
  }
  const hint = el('span', { class: 'cvb-hint', 'aria-live': 'polite' });
  const check = () => {
    const v = input.value.trim();
    const bad = v && ((f.type === 'email' && !isEmail(v)) || (f.type === 'url' && !isUrl(v)));
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
    hint.textContent = bad ? (f.type === 'email' ? 'Check the email address' : 'Check the URL') : '';
  };
  input.addEventListener('input', () => {
    obj[f.key] = f.type === 'lines' ? strList(input.value) : f.type === 'tags' ? tagList(input.value) : input.value;
    check(); onInput();
  });
  check();
  return el('div', { class: `field cvb-f-${f.type}` }, el('label', { for: id }, f.label), input, hint);
}

export function buildForm(root, cv, { onChange, rebuild }) {
  const open = buildForm.open || (buildForm.open = new Set(['personal']));
  root.replaceChildren();

  const card = (key, title, body, { head = [], sub = '' } = {}) => {
    const d = el('details', { class: 'cvb-card', 'data-key': key });
    d.open = open.has(key);
    d.addEventListener('toggle', () => { d.open ? open.add(key) : open.delete(key); });
    d.append(el('summary', {}, el('span', { class: 'cvb-card-title' }, title, sub ? el('small', {}, sub) : null), el('span', { class: 'cvb-card-tools', onclick: e => e.stopPropagation() }, head)), el('div', { class: 'cvb-card-body' }, body));
    return d;
  };

  // Personal information
  const pers = el('div', { class: 'cvb-grid' }, PERSONAL_FIELDS.map(f => control(f, cv.personal, onChange, 'cvb-p')));
  root.append(card('personal', 'Personal information', pers));

  cv.order.forEach((o, idx) => {
    const def = SECTIONS[o.id];
    const vis = el('label', { class: 'cvb-vis', title: 'Show in CV' }, el('input', { type: 'checkbox', 'aria-label': `Show ${def.label}` }), el('span', {}, 'Show'));
    const chk = vis.querySelector('input'); chk.checked = o.visible;
    chk.addEventListener('change', () => { o.visible = chk.checked; d.classList.toggle('is-hidden', !o.visible); onChange(); });
    const tools = [
      vis,
      iconBtn('chevron-up', `Move ${def.label} up`, () => { if (move(cv.order, idx, -1)) { onChange(); rebuild(); } }, { disabled: idx === 0 }),
      iconBtn('chevron-down', `Move ${def.label} down`, () => { if (move(cv.order, idx, 1)) { onChange(); rebuild(); } }, { disabled: idx === cv.order.length - 1 }),
    ];
    let body;
    if (def.kind === 'text') {
      body = control({ key: 'summary', label: 'Summary', type: 'area', placeholder: '2–4 lines: role, years of experience, strongest technologies, measurable impact' }, cv, onChange, 'cvb-sum');
      body.querySelector('textarea').rows = 5;
    } else if (def.kind === 'skills') {
      body = skillsForm(cv, onChange, rebuild);
    } else {
      body = listForm(cv, o.id, def, onChange, rebuild);
    }
    const count = def.kind === 'list' ? (cv[o.id].length ? `${cv[o.id].length}` : '') : '';
    const d = card(o.id, def.label, body, { head: tools, sub: count });
    d.classList.toggle('is-hidden', !o.visible);
    root.append(d);
  });
  renderIcons(root);
}

function skillsForm(cv, onChange, rebuild) {
  const wrap = el('div', { class: 'cvb-skills' });
  cv.skills.forEach((g, i) => {
    const idb = `cvb-sk-${g.id}`;
    const items = el('textarea', { class: 'textarea', id: idb + '-i', 'aria-label': `Skills in ${g.label || 'group'}`, rows: 2, placeholder: 'Comma separated: TypeScript, Go, Python' });
    items.value = g.items.join(', ');
    items.addEventListener('input', () => { g.items = tagList(items.value); onChange(); });
    const label = el('input', { class: 'input', id: idb + '-l', 'aria-label': 'Group name' });
    label.value = g.label;
    label.addEventListener('input', () => { g.label = label.value; onChange(); });
    wrap.append(el('div', { class: 'cvb-skill' },
      el('div', { class: 'cvb-skill-head' }, label,
        iconBtn('chevron-up', `Move group ${g.label} up`, () => { if (move(cv.skills, i, -1)) { onChange(); rebuild(); } }),
        iconBtn('chevron-down', `Move group ${g.label} down`, () => { if (move(cv.skills, i, 1)) { onChange(); rebuild(); } }),
        iconBtn('trash-2', `Remove group ${g.label}`, () => { cv.skills.splice(i, 1); onChange(); rebuild(); })),
      items));
  });
  wrap.append(el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { cv.skills.push({ id: newId(), label: '', items: [] }); onChange(); rebuild(); } }, el('i', { 'data-lucide': 'plus' }), ' Add group'));
  return wrap;
}

function listForm(cv, section, def, onChange, rebuild) {
  const arr = cv[section];
  const wrap = el('div', { class: 'cvb-list' });
  arr.forEach((e, i) => {
    const title = e[def.titleKey] || `${def.item} ${i + 1}`;
    const item = el('details', { class: 'cvb-item', open: arr.length <= 2 || !e[def.titleKey] ? '' : null });
    const tools = el('span', { class: 'cvb-card-tools', onclick: ev => ev.stopPropagation() },
      iconBtn('chevron-up', `Move ${title} up`, () => { if (move(arr, i, -1)) { onChange(); rebuild(); } }, { disabled: i === 0 }),
      iconBtn('chevron-down', `Move ${title} down`, () => { if (move(arr, i, 1)) { onChange(); rebuild(); } }, { disabled: i === arr.length - 1 }),
      iconBtn('trash-2', `Remove ${title}`, () => { arr.splice(i, 1); onChange(); rebuild(); }));
    const titleEl = el('span', { class: 'cvb-item-title' }, title);
    item.append(el('summary', {}, titleEl, tools));
    const grid = el('div', { class: 'cvb-grid' }, def.fields.map(f => {
      const c = control(f, e, () => { if (f.key === def.titleKey) titleEl.textContent = e[f.key] || `${def.item} ${i + 1}`; onChange(); }, `cvb-${e.id}`);
      if (f.type === 'area' || f.type === 'lines' || f.type === 'tags') c.classList.add('cvb-wide');
      return c;
    }));
    item.append(grid);
    wrap.append(item);
  });
  wrap.append(el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { arr.push(blankEntry(section)); onChange(); rebuild(); } }, el('i', { 'data-lucide': 'plus' }), ` Add ${def.item.toLowerCase()}`));
  return wrap;
}
