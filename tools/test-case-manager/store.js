// Test Case Manager: persistence. IndexedDB (no 5 MB localStorage cap, batched writes) with an in-memory fallback
// for browsers that block it (private windows, some embedded views). Both expose the same async API:
//   all() -> cases[]   apply({ put: cases[], remove: ids[] })   clear()   persistent: boolean

const DB_NAME = 'devtoolbox-test-cases';
const STORE = 'cases';

export function createMemoryStore() {
  const map = new Map();
  return {
    persistent: false,
    async all() { return [...map.values()].map(c => structuredClone(c)); },
    async apply({ put = [], remove = [] } = {}) {
      for (const id of remove) map.delete(id);
      for (const c of put) map.set(c.id, structuredClone(c));
    },
    async clear() { map.clear(); },
    close() {},
  };
}

const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Transaction aborted')); });

/** Open the persistent store, or fall back to memory. Never throws. */
export async function openStore(factory = globalThis.indexedDB) {
  if (!factory) return createMemoryStore();
  try {
    const db = await new Promise((res, rej) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error('IndexedDB is blocked'));
    });
    return {
      persistent: true,
      async all() { return wrap(db.transaction(STORE).objectStore(STORE).getAll()); },
      async apply({ put = [], remove = [] } = {}) {
        const tx = db.transaction(STORE, 'readwrite'), os = tx.objectStore(STORE);
        for (const id of remove) os.delete(id);
        for (const c of put) os.put(c);
        await done(tx);
      },
      async clear() { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); await done(tx); },
      close() { db.close(); },
    };
  } catch { return createMemoryStore(); }
}
