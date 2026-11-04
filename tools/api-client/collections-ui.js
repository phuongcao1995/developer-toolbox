// Collections sidebar: an ARIA tree (role=tree / treeitem) with keyboard support and a toolbar of actions for the selected item.
// Names are always set with textContent.
import { dialog, askText, checkbox, h } from './dialogs.js';
import * as S from './store.js';
import { exportCollection as exportPostman } from './postman.js';
import { stripSecrets, countSecrets, fileSlug } from './compose.js';
import { downloadFile, confirmDialog, toast } from '../../assets/js/components/ui.js';

/**
 * col: { tree, readOnly } (live). deps: { root, persist(), openRequest(node), saveCurrentAs(parentId, name) -> node|null,
 * isDirty(), activeId(), onRemoved(ids:Set) }.
 */
export function createCollections({ root, col, persist, openRequest, saveCurrentAs, isDirty, activeId, onRemoved }) {
  const host = root.querySelector('#ac-tree-host');
  const toolBtns = Object.fromEntries([...root.querySelectorAll('[data-node]')].map(b => [b.dataset.node, b]));
  const expanded = new Set(); let selectedId = null, firstRender = true;

  const guard = () => { if (col.readOnly) { toast('Collections are read-only because they were saved by a different version.', 'warn'); return false; } return true; };
  const sel = () => (selectedId ? S.findNode(col.tree, selectedId) : null);
  const subtreeIds = node => { const ids = new Set(); S.walk([node], n => ids.add(n.id)); return ids; };
  const mutated = () => { persist(); render(); };

  function render() {
    const hadFocus = host.contains(document.activeElement);
    if (firstRender) { S.walk(col.tree, n => { if (n.type === 'collection') expanded.add(n.id); }); firstRender = false; }
    if (selectedId && !S.findNode(col.tree, selectedId)) selectedId = null;
    if (!col.tree.length) {
      host.replaceChildren(h('div', { class: 'ac-empty' }, 'No collections yet. Create one, then use "Save as…" to store the current request, or import a Postman / Toolbox file.'));
      updateTools(); return;
    }
    const act = activeId(), dirty = isDirty();
    const ul = h('ul', { class: 'ac-tree', role: 'tree', 'aria-label': 'Collections' });
    const focusId = selectedId || col.tree[0].id;
    const build = (list, level, parentUl) => {
      for (const n of list) {
        const container = S.isContainer(n), open = container && expanded.has(n.id);
        const li = h('li', { class: 'ac-titem', role: 'treeitem', 'aria-level': String(level), 'aria-selected': String(n.id === selectedId), tabindex: n.id === focusId ? '0' : '-1', 'data-id': n.id });
        if (container) li.setAttribute('aria-expanded', String(open));
        const row = h('div', { class: `ac-trow${n.id === selectedId ? ' sel' : ''}` });
        row.style.paddingLeft = `${(level - 1) * 14 + 6}px`;
        row.append(h('span', { class: 'ac-caret', 'aria-hidden': 'true' }, container ? (open ? '▾' : '▸') : ''));
        if (n.type === 'request') row.append(h('span', { class: `ac-m ac-m-${n.request.method}` }, n.request.method));
        else row.append(h('span', { class: 'ac-kind', 'aria-hidden': 'true' }, n.type === 'collection' ? '▣' : '▤'));
        row.append(h('span', { class: 'ac-tname' }, n.name));
        if (n.id === act && dirty) row.append(h('span', { class: 'ac-dirty', role: 'img', 'aria-label': 'Unsaved changes', title: 'Unsaved changes' }));
        li.append(row);
        row.addEventListener('click', () => {
          selectedId = n.id;
          if (container) { if (expanded.has(n.id)) expanded.delete(n.id); else expanded.add(n.id); render(); focusSel(); }
          else { render(); focusSel(); activate(n); }
        });
        parentUl.append(li);
        if (open) { const g = h('ul', { role: 'group' }); li.append(g); build(n.items, level + 1, g); }
      }
    };
    build(col.tree, 1, ul);
    host.replaceChildren(ul);
    updateTools();
    if (hadFocus) focusSel();
  }
  const focusSel = () => host.querySelector(`li[data-id="${CSS.escape(selectedId || '')}"]`)?.focus();

  async function activate(n) { if (n.type === 'request') await openRequest(n); }

  // ---- keyboard ----
  host.addEventListener('keydown', async e => {
    const li = e.target.closest?.('li.ac-titem');
    if (!li || e.target !== li || e.ctrlKey || e.altKey || e.metaKey) return;
    const items = [...host.querySelectorAll('li.ac-titem')], i = items.indexOf(li), id = li.dataset.id;
    const hit = S.findNode(col.tree, id); if (!hit) return;
    const goto = el => { if (el) { selectedId = el.dataset.id; render(); focusSel(); } };
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': goto(items[i + 1]); break;
      case 'ArrowUp': goto(items[i - 1]); break;
      case 'Home': goto(items[0]); break;
      case 'End': goto(items[items.length - 1]); break;
      case 'ArrowRight':
        if (S.isContainer(hit.node) && !expanded.has(id)) { expanded.add(id); render(); focusSel(); } else if (S.isContainer(hit.node) && hit.node.items.length) goto(items[i + 1]);
        break;
      case 'ArrowLeft':
        if (S.isContainer(hit.node) && expanded.has(id)) { expanded.delete(id); render(); focusSel(); } else if (hit.parent) { selectedId = hit.parent.id; render(); focusSel(); }
        break;
      case 'Enter': case ' ':
        selectedId = id;
        if (S.isContainer(hit.node)) { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); focusSel(); } else { render(); focusSel(); await activate(hit.node); }
        break;
      case 'F2': selectedId = id; await actions.rename(); break;
      case 'Delete': selectedId = id; await actions.delete(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  // ---- toolbar state ----
  function updateTools() {
    const hit = sel(), ro = col.readOnly;
    const set = (k, on) => { if (toolBtns[k]) toolBtns[k].disabled = !on || ro; };
    set('new-folder', !!hit); set('new-request', !!hit);
    set('rename', !!hit); set('duplicate', !!hit);
    set('up', !!hit && hit.index > 0); set('down', !!hit && hit.index < hit.list.length - 1);
    set('move', !!hit && hit.node.type !== 'collection' && S.moveTargets(col.tree, hit.node.id).length > 0);
    toolBtns.export.disabled = !(hit && hit.node.type === 'collection');
    set('delete', !!hit);
  }

  /** The container that "new folder / new request" should target for the current selection. */
  const targetContainer = () => { const hit = sel(); if (!hit) return null; return S.isContainer(hit.node) ? hit.node : hit.parent; };

  const actions = {
    async 'new-folder'() {
      if (!guard()) return;
      const t = targetContainer(); if (!t) return toast('Select a collection or folder first.', 'info');
      const name = await askText({ title: 'New folder', label: 'Folder name', value: 'New folder', confirmLabel: 'Create' }); if (!name) return;
      const n = S.addContainer(col.tree, t.id, name);
      if (!n) return toast('Could not add the folder (nesting or size limit reached).', 'error');
      expanded.add(t.id); selectedId = n.id; mutated();
    },
    async 'new-request'() {
      if (!guard()) return;
      const t = targetContainer(); if (!t) return toast('Select a collection or folder first.', 'info');
      const name = await askText({ title: 'Save current request here', label: 'Request name', value: 'New request', confirmLabel: 'Save' }); if (!name) return;
      const n = saveCurrentAs(t.id, name);
      if (n) { expanded.add(t.id); selectedId = n.id; render(); focusSel(); }
    },
    async rename() {
      if (!guard()) return;
      const hit = sel(); if (!hit) return;
      const name = await askText({ title: 'Rename', label: 'Name', value: hit.node.name, confirmLabel: 'Rename' }); if (!name) return;
      S.renameNode(col.tree, hit.node.id, name); mutated(); focusSel();
      if (hit.node.id === activeId()) root.dispatchEvent(new CustomEvent('ac-renamed'));
    },
    duplicate() {
      if (!guard()) return;
      const hit = sel(); if (!hit) return;
      const c = S.duplicateNode(col.tree, hit.node.id);
      if (!c) return toast('Could not duplicate (size limit reached).', 'error');
      selectedId = c.id; mutated(); focusSel();
    },
    up() { if (guard() && sel() && S.shiftNode(col.tree, selectedId, -1)) { mutated(); focusSel(); } },
    down() { if (guard() && sel() && S.shiftNode(col.tree, selectedId, 1)) { mutated(); focusSel(); } },
    move() {
      if (!guard()) return;
      const hit = sel(); if (!hit) return;
      const targets = S.moveTargets(col.tree, hit.node.id);
      if (!targets.length) return toast('There is nowhere to move this item.', 'info');
      let chosen = null;
      const list = h('div', { class: 'ac-movelist', role: 'radiogroup', 'aria-label': 'Destination' });
      targets.forEach((t, i) => {
        const r = h('input', { type: 'radio', name: 'ac-move', value: t.id });
        r.addEventListener('change', () => { chosen = t.id; });
        const lab = h('label', { class: 'ac-check' }, r, ' ', h('span', {}, `${' '.repeat(t.depth)}${t.name}`));
        list.append(lab); if (i === 0) setTimeout(() => r.focus(), 0);
      });
      dialog({
        title: `Move "${hit.node.name}" to…`, body: [h('p', { class: 'hint' }, 'Choose the destination collection or folder. The item is placed at the end.'), list],
        actions: [{ label: 'Cancel' }, {
          label: 'Move', primary: true,
          onClick: () => {
            if (!chosen) { toast('Choose a destination.', 'warn'); return false; }
            if (!S.moveNode(col.tree, hit.node.id, chosen)) { toast('That move is not allowed (nesting limit).', 'error'); return false; }
            expanded.add(chosen); mutated(); focusSel();
          },
        }],
      });
    },
    export() {
      const hit = sel(); if (!hit || hit.node.type !== 'collection') return toast('Select a collection to export.', 'info');
      openExport(hit.node);
    },
    async delete() {
      if (!guard()) return;
      const hit = sel(); if (!hit) return;
      const n = subtreeIds(hit.node).size - 1;
      const msg = S.isContainer(hit.node) ? `Delete "${hit.node.name}" and everything inside it (${n} item${n === 1 ? '' : 's'})? This cannot be undone.` : `Delete the request "${hit.node.name}"? This cannot be undone.`;
      if (!(await confirmDialog('Delete', msg, 'Delete'))) return;
      const gone = subtreeIds(hit.node);
      const sib = hit.list[hit.index + 1] || hit.list[hit.index - 1] || hit.parent;
      S.deleteNode(col.tree, hit.node.id);
      selectedId = sib ? sib.id : null;
      onRemoved(gone); mutated(); if (selectedId) focusSel();
    },
  };
  for (const [k, b] of Object.entries(toolBtns)) b.addEventListener('click', () => actions[k]?.());

  // ---- export dialog ----
  function openExport(node) {
    const fmt = h('select', { class: 'select', 'aria-label': 'Export format' },
      h('option', { value: 'toolbox' }, 'Developer Toolbox JSON'), h('option', { value: 'postman' }, 'Postman Collection v2.1'));
    const inc = checkbox('Include secrets (auth values, sensitive headers, tokens)', false);
    const n = countSecrets(node);
    const info = h('p', { class: 'hint' }, n ? `${n} secret-looking value${n === 1 ? '' : 's'} found. They are removed unless you tick the box. {{variables}} are always kept as placeholders.` : 'No literal secrets were detected in this collection.');
    dialog({
      title: `Export "${node.name}"`, body: [h('label', { class: 'ac-field' }, 'Format', fmt), inc.label, info],
      actions: [{ label: 'Cancel' }, {
        label: 'Download', primary: true,
        onClick: () => {
          const src = inc.input.checked ? node : stripSecrets(node);
          let out, name;
          if (fmt.value === 'postman') { out = exportPostman(src, { includeSecrets: inc.input.checked }); name = `${fileSlug(node.name)}.postman_collection.json`; }
          else { out = S.exportCollection([src], src.id); name = `${fileSlug(node.name)}.toolbox-collection.json`; }
          downloadFile(name, JSON.stringify(out, null, 2), 'application/json');
          toast(inc.input.checked ? 'Exported with secrets: keep the file private' : 'Exported without secrets', inc.input.checked ? 'warn' : 'success');
        },
      }],
    });
  }

  return {
    render,
    select(id) { selectedId = id; for (let p = S.findNode(col.tree, id)?.parent; p; p = S.findNode(col.tree, p.id)?.parent) expanded.add(p.id); render(); },
    async newCollection() {
      if (!guard()) return;
      const name = await askText({ title: 'New collection', label: 'Collection name', value: 'New collection', confirmLabel: 'Create' }); if (!name) return;
      const n = S.addContainer(col.tree, null, name);
      if (!n) return toast('Could not add the collection (size limit reached).', 'error');
      expanded.add(n.id); selectedId = n.id; mutated(); focusSel();
    },
    add(node) { col.tree.push(node); expanded.add(node.id); selectedId = node.id; mutated(); },
    selectedContainer: () => targetContainer(),
    selectedId: () => selectedId,
  };
}
