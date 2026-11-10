// Multiple CV versions persisted through the tool-scoped storage (ctx.storage). Storage is injected so it can be tested.
import { normalize, defaultCV, newId } from './model.js';

export function createStore(storage) {
  const readIndex = () => {
    const raw = storage.get('index', null);
    const list = Array.isArray(raw?.list) ? raw.list.filter(x => x && typeof x.id === 'string') : [];
    return { active: raw?.active, list };
  };
  let index = readIndex();
  const saveIndex = () => storage.set('index', index);

  function create(name, data) {
    const id = newId();
    index.list.push({ id, name: name || 'My CV', updated: Date.now() });
    index.active = id;
    storage.set('cv:' + id, data || defaultCV());
    saveIndex();
    return id;
  }
  if (!index.list.length) create('My CV');
  if (!index.list.some(x => x.id === index.active)) { index.active = index.list[0].id; saveIndex(); }

  return {
    list: () => index.list.map(x => ({ ...x })),
    get active() { return index.active; },
    load(id = index.active) { return normalize(storage.get('cv:' + id, null)); },
    // Returns false when storage refused the write (quota / private mode).
    save(data, id = index.active) {
      const ok = storage.set('cv:' + id, data);
      const e = index.list.find(x => x.id === id);
      if (e) { e.updated = Date.now(); saveIndex(); }
      return ok !== false;
    },
    select(id) { if (index.list.some(x => x.id === id)) { index.active = id; saveIndex(); } return index.active; },
    create,
    duplicate(id = index.active) {
      const src = index.list.find(x => x.id === id);
      return create((src?.name || 'CV') + ' (copy)', normalize(storage.get('cv:' + id, null)));
    },
    rename(id, name) { const e = index.list.find(x => x.id === id); if (e && name.trim()) { e.name = name.trim().slice(0, 60); saveIndex(); } },
    remove(id) {
      if (index.list.length <= 1) return false;
      index.list = index.list.filter(x => x.id !== id);
      storage.remove('cv:' + id);
      if (index.active === id) index.active = index.list[0].id;
      saveIndex();
      return true;
    },
  };
}
