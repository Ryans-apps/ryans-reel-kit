// App shell: screens, drafts, settings, backup, offline packs, and the photo↔video hand-off.
import * as db from './db.js';
import { $, el, toast, openSheet, download, canvasToBlob } from './util.js';
import * as V from './video.js';
import * as Ph from './photo.js';
import { CREDITS } from './credits.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../vendor/fflate.mjs';

export const PACK_FILES = [
  'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm', 'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', 'vendor/transformers.min.js',
  'vendor/mediapipe/vision_bundle.mjs', 'vendor/mediapipe/wasm/vision_wasm_internal.js', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm', 'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js', 'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  'models/mediapipe/selfie_segmenter.tflite', 'models/modnet/config.json', 'models/modnet/preprocessor_config.json', 'models/modnet/onnx/model_quantized.onnx',
  ...['whisper-tiny.en_timestamped', 'whisper-base.en_timestamped'].flatMap(m => ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'].map(f => `models/${m}/${f}`)),
];

function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id)); }
async function goHome() { V.stop(); show('home'); await renderDrafts(); }

async function renderDrafts() {
  const ul = $('#draftList'); ul.innerHTML = '';
  const items = [...(await db.all('projects')), ...(await db.all('photos'))].sort((a, b) => b.updated - a.updated);
  if (!items.length) ul.append(el('li', {}, el('span', { class: 'grow hint' }, 'No drafts yet. Drafts save automatically.')));
  for (const d of items) {
    const isV = d.kind === 'video'; const thumb = isV ? d.clips[0]?.thumb : d.thumb;
    ul.append(el('li', {},
      thumb ? el('img', { src: thumb, alt: '', width: 40, height: 71, style: 'object-fit:cover;border-radius:6px' }) : el('span', { style: 'font-size:28px' }, isV ? '🎬' : '🖼️'),
      el('div', { class: 'grow', onclick: () => isV ? openVideo(d.id) : openPhotoDoc(d.id, {}) }, el('b', {}, d.name || 'Untitled'), el('small', { class: 'hint' }, (isV ? `Video · ${d.clips.length} clips` : `Photo · ${d.layers.length} layers`) + ' · ' + new Date(d.updated).toLocaleString())),
      el('button', { class: 'small', onclick: () => isV ? openVideo(d.id) : openPhotoDoc(d.id, {}) }, 'Open'),
      el('button', { class: 'icon', 'aria-label': 'Delete draft ' + (d.name || ''), onclick: async () => { if (!confirm(`Delete “${d.name}”?`)) return; await db.del(isV ? 'projects' : 'photos', d.id); renderDrafts(); } }, '🗑')));
  }
}
async function openVideo(id) { const p = await db.get('projects', id); show('video'); await V.openProject(p); }

// ----- photo editor hand-off -----
let photoCtx = {}; // { projectId, overlayId }
async function openPhotoDoc(id, ctx) { const d = typeof id === 'string' ? await db.get('photos', id) : id; photoCtx = ctx || {}; show('photo'); await Ph.openPhoto(d, onPhotoExit); }
async function backToProject(projectId) {
  const P = V.currentProject();
  if (P && P.id === projectId) { show('video'); V.draw(); return P; }
  await openVideo(projectId); return V.currentProject();
}
async function refreshLinked(P, doc, rt) {
  for (const o of P.overlays) if (o.photoDocId === doc.id) {
    if (o.photoLayerId && !doc.layers.find(L => L.id === o.photoLayerId)) continue;
    await V.replaceOverlayImage(o, await canvasToBlob(Ph.flatten(doc, rt, o.photoLayerId)));
  }
}
async function onPhotoExit(doc, rt, send) {
  const ctx = photoCtx;
  if (!send) { if (ctx.projectId) { const P = await backToProject(ctx.projectId); await refreshLinked(P, doc, rt); } else goHome(); return; }
  const blob = await canvasToBlob(Ph.flatten(doc, rt, send.layerId));
  const name = send.layerId ? doc.layers.find(L => L.id === send.layerId)?.name : doc.name;
  const addTo = async (projectId) => {
    const P = await backToProject(projectId); await refreshLinked(P, doc, rt);
    const existing = ctx.overlayId && P.overlays.find(o => o.id === ctx.overlayId);
    if (existing) { existing.photoLayerId = send.layerId; await V.replaceOverlayImage(existing, blob); toast('Overlay updated'); }
    else { await V.addImageOverlay(blob, { name, photoDocId: doc.id, photoLayerId: send.layerId }); toast('Added to video at the playhead'); }
  };
  if (ctx.projectId) return addTo(ctx.projectId);
  const projects = (await db.all('projects')).sort((a, b) => b.updated - a.updated);
  openSheet((b, close) => b.append(el('h2', {}, 'Which video?'), el('div', { class: 'list' },
    el('button', { onclick: async () => { close(); const p = V.newProject(); await db.put('projects', p); addTo(p.id); } }, '＋ New video', el('span', {}, '→')),
    ...projects.map(p => el('button', { onclick: () => { close(); addTo(p.id); } }, p.name, el('span', {}, '→')))), el('button', { class: 'ghost', onclick: close }, 'Cancel')));
}

// ----- settings, storage, backup -----
async function storageInfo() {
  const e = await navigator.storage?.estimate?.(); const persisted = await navigator.storage?.persisted?.();
  $('#storageInfo').textContent = e ? `Using ${(e.usage / 1e6).toFixed(0)} MB of about ${(e.quota / 1e9).toFixed(1)} GB available.${persisted ? ' Storage is protected from automatic clean-up.' : ''}` : '';
}
export async function exportBackup() {
  const files = {}; const meta = { app: 'ryans-reel-kit', version: 1, exported: new Date().toISOString(), projects: await db.all('projects'), photos: await db.all('photos'), styles: await db.all('styles'), media: [] };
  for (const m of await db.all('media')) { meta.media.push({ id: m.id, name: m.name, type: m.type, role: m.role || null, added: m.added }); files['media/' + m.id] = [new Uint8Array(await m.blob.arrayBuffer()), { level: 0 }]; }
  files['backup.json'] = strToU8(JSON.stringify(meta));
  const zip = zipSync(files); return new Blob([zip], { type: 'application/zip' });
}
export async function importBackup(file, { replace = true } = {}) {
  const z = unzipSync(new Uint8Array(await file.arrayBuffer())); if (!z['backup.json']) throw new Error('Not a Reel Kit backup');
  const meta = JSON.parse(strFromU8(z['backup.json'])); if (meta.app !== 'ryans-reel-kit') throw new Error('Not a Reel Kit backup');
  if (replace) await db.clearAll();
  for (const m of meta.media) { const data = z['media/' + m.id]; if (data) await db.put('media', { ...m, blob: new Blob([data], { type: m.type }), size: data.length }); }
  for (const p of meta.projects) await db.put('projects', p); for (const p of meta.photos) await db.put('photos', p); for (const s of meta.styles) await db.put('styles', s);
  return { projects: meta.projects.length, photos: meta.photos.length, media: meta.media.length };
}
const PACKS_CACHE = 'ryans-reel-kit::packs-v1'; // must match PACKS in sw.js
async function offlineStatus() {
  if (!('caches' in self)) return; const c = await caches.open(PACKS_CACHE); let have = 0; for (const f of PACK_FILES) if (await c.match(new URL(f, location.href).href)) have++;
  $('#offlineInfo').textContent = have === PACK_FILES.length ? 'Caption + cutout packs are saved for offline use.' : `Packs saved: ${have} of ${PACK_FILES.length} files. Without them, captions and cutouts need internet the first time.`;
}
export async function downloadPacks(onProg) {
  const c = await caches.open(PACKS_CACHE); let i = 0;
  for (const f of PACK_FILES) { const u = new URL(f, location.href).href; if (!(await c.match(u))) { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error('Missing ' + f); await c.put(u, r); } onProg?.(++i / PACK_FILES.length, f); }
}
function initSettings() {
  $('#openSettings').onclick = () => { storageInfo(); offlineStatus(); $('#settings').showModal(); };
  $('#closeSettings').onclick = () => $('#settings').close();
  const saved = localStorage.getItem('asrModel'); if (saved) { const r = document.querySelector(`input[name=asrModel][value="${saved}"]`); if (r) r.checked = true; }
  document.querySelectorAll('input[name=asrModel]').forEach(r => r.onchange = () => localStorage.setItem('asrModel', r.value));
  $('#exportAll').onclick = async () => { toast('Making backup…'); const b = await exportBackup(); saveFile(b, `reel-kit-backup-${new Date().toISOString().slice(0, 10)}.zip`); };
  $('#importFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; if (!confirm('Replace everything in the app with this backup?')) return; try { const r = await importBackup(f); toast(`Restored ${r.projects} videos, ${r.photos} photos`); renderDrafts(); } catch (err) { toast('Import failed: ' + err.message, 5000); } };
  $('#offlinePacks').onclick = async () => { const b = $('#offlinePacks'); b.disabled = true; try { await downloadPacks((p) => $('#offlineInfo').textContent = `Saving packs… ${Math.round(p * 100)}%`); } catch (e) { toast(e.message, 5000); } b.disabled = false; offlineStatus(); };
  $('#credits').append(el('ul', { class: 'credits-list' }, CREDITS.map(([n, l, u]) => el('li', {}, u ? el('a', { href: u, target: '_blank', rel: 'noopener' }, n) : n, ' — ', el('small', {}, l)))), el('p', { class: 'hint' }, 'Full license texts: LICENSES.md and vendor/*LICENSE*.txt in the app folder.'));
}
function saveFile(blob, name) { download(blob, name); }

async function init() {
  await db.open?.(); navigator.storage?.persist?.().catch(() => {});
  V.initVideoUI({
    home: goHome, saveFile,
    editPhoto: async (docId, overlayId) => { await V.saveNow(); openPhotoDoc(docId, { projectId: V.currentProject().id, overlayId }); },
    photoFromOverlay: async (o) => { await V.saveNow(); const blob = await db.mediaBlob(o.mediaId); const d = Ph.newDoc(o.name || 'Photo'); await db.put('photos', d); await openPhotoDoc(d, { projectId: V.currentProject().id, overlayId: o.id }); const L = await Ph.addImageLayer(new File([blob], (o.name || 'photo') + '.png', { type: blob.type })); o.photoDocId = d.id; o.photoLayerId = null; V.saveNow(); },
    newPhotoForVideo: async () => { await V.saveNow(); const d = Ph.newDoc('Photo for video'); await db.put('photos', d); openPhotoDoc(d, { projectId: V.currentProject().id }); },
    sendDoc: async (docId) => { const d = await db.get('photos', docId); const rt = await Ph.loadDocRuntime(d); await V.addImageOverlay(await canvasToBlob(Ph.flatten(d, rt)), { name: d.name, photoDocId: d.id, photoLayerId: null }); },
  });
  Ph.initPhotoUI({ saveFile });
  $('#newVideo').onclick = async () => { const p = V.newProject(); await db.put('projects', p); show('video'); await V.openProject(p); };
  $('#newPhoto').onclick = async () => { const d = Ph.newDoc('New photo'); await db.put('photos', d); openPhotoDoc(d, {}); };
  initSettings(); await renderDrafts();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
    // The first visit isn't served by the offline helper yet, so captions would run on one CPU thread.
    // Reload once (only if nothing is open) so the app runs in the faster, isolated mode.
    const maybeReload = () => { if (!self.crossOriginIsolated && navigator.serviceWorker.controller && !sessionStorage.getItem('rrkReloaded') && document.querySelector('#home.active')) { sessionStorage.setItem('rrkReloaded', '1'); location.reload(); } };
    navigator.serviceWorker.addEventListener('controllerchange', maybeReload); maybeReload();
  }
  document.body.dataset.ready = '1';
}
// Debug/test hooks (used by the automated checks; harmless in normal use).
window.__rrk = { db, V, Ph, exportBackup, importBackup, downloadPacks, openVideo, openPhotoDoc, goHome };
init();
