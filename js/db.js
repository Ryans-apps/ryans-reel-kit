// Local-only storage: IndexedDB for projects, photo docs, caption styles, and media blobs.
const DB_NAME = 'ryans-reel-kit', VERSION = 1;
export const STORES = ['projects', 'photos', 'media', 'styles', 'kv'];
let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: s === 'kv' ? undefined : 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
function req(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store); const r = fn(s);
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
}
export const get = (store, id) => req(store, 'readonly', s => s.get(id));
export const put = (store, val, key) => req(store, 'readwrite', s => key === undefined ? s.put(val) : s.put(val, key));
export const del = (store, id) => req(store, 'readwrite', s => s.delete(id));
export const all = (store) => req(store, 'readonly', s => s.getAll());
export const keys = (store) => req(store, 'readonly', s => s.getAllKeys());
export const clearAll = async () => { for (const s of STORES) await req(s, 'readwrite', st => st.clear()); };
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

// Media: blobs stored once, referenced by id everywhere.
const urlCache = new Map();
export async function addMedia(blob, name = 'file', extra = {}) {
  const id = uid('m_');
  await put('media', { id, name, type: blob.type, size: blob.size, blob, added: Date.now(), ...extra });
  return id;
}
export async function mediaBlob(id) { const m = await get('media', id); return m && m.blob; }
export async function mediaURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const b = await mediaBlob(id); if (!b) return null;
  const u = URL.createObjectURL(b); urlCache.set(id, u); return u;
}
export function forgetURL(id) { const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u); urlCache.delete(id); } }
export async function replaceMedia(id, blob) {
  const m = await get('media', id); if (!m) return; m.blob = blob; m.type = blob.type; m.size = blob.size; await put('media', m); forgetURL(id);
}
