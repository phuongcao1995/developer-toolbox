// Thin, failure-tolerant wrapper around localStorage (private mode / blocked storage safe).
const PREFIX = 'devtoolbox:';

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
  },
  /** Remove every key owned by this app whose name starts with one of `prefixes` (all keys if omitted). */
  clear(prefixes) {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(PREFIX))
        .filter(k => !prefixes || prefixes.some(p => k.slice(PREFIX.length).startsWith(p)))
        .forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};

export const DEFAULT_SETTINGS = { theme: null, fontSize: 13, indent: '2' };

/** App settings with change notification. `indent` is '2' | '4' | 'tab'. */
export const settings = {
  _listeners: new Set(),
  get() { return { ...DEFAULT_SETTINGS, ...(storage.get('settings', {}) || {}) }; },
  set(patch) {
    storage.set('settings', { ...this.get(), ...patch });
    this._listeners.forEach(fn => fn(this.get()));
  },
  reset() { storage.remove('settings'); this._listeners.forEach(fn => fn(this.get())); },
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  /** Indent string usable with JSON.stringify / formatters: number of spaces or '\t'. */
  indentUnit() { const i = this.get().indent; return i === 'tab' ? '\t' : ' '.repeat(Number(i) || 2); },
};
