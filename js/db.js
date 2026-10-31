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
// Some browsers (private browsing, WebKit ephemeral sessions) refuse to store Blobs in IndexedDB and abort with a null error.
// Then store the bytes as an ArrayBuffer instead; if that fails too, throw a readable message.
export const SAVE_FAIL = 'This file could not be saved on this device. Private browsing or full storage can block it; try a normal window or free some space.';
async function putMedia(rec, blob) {
  try { await put('media', { ...rec, blob, buf: undefined }); return; } catch (e) { console.warn('media blob store failed, trying bytes', e); }
  try { await put('media', { ...rec, blob: undefined, buf: await blob.arrayBuffer() }); } catch (e) { console.warn('media bytes store failed', e); throw new Error(SAVE_FAIL); }
}
export async function addMedia(blob, name = 'file', extra = {}) {
  const id = uid('m_');
  await putMedia({ id, name, type: blob.type, size: blob.size, added: Date.now(), ...extra }, blob);
  return id;
}
export const recBlob = (m) => m && (m.blob || (m.buf ? new Blob([m.buf], { type: m.type || '' }) : null));
export async function mediaBlob(id) { return recBlob(await get('media', id)); }
export async function mediaURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const b = await mediaBlob(id); if (!b) return null;
  const u = URL.createObjectURL(b); urlCache.set(id, u); return u;
}
export function forgetURL(id) { const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u); urlCache.delete(id); } }
export async function replaceMedia(id, blob) {
  const m = await get('media', id); if (!m) return; m.type = blob.type; m.size = blob.size; await putMedia(m, blob); forgetURL(id);
}
