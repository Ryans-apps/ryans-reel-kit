// Layered photo editor (Konva for the stage + handles; pixels, masks and healing are our own code).
import * as db from './db.js';
import { $, el, toast, slider, chips, pickFiles, loadImage, canvas, canvasToBlob, openSheet } from './util.js';
import { drawTextBlock } from './compositor.js';
import { cloneDab, spotHeal } from './heal.js';
import { personMask, fineMatte } from './ml.js';
import { FONTS } from './styles.js';
const Konva = window.Konva;
export const BLENDS = [['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['soft-light', 'Soft light'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'Dodge'], ['difference', 'Difference'], ['luminosity', 'Luminosity']];

let doc = null, rt = new Map(), stage, klayer, tr, sel = null, tool = 'move', undo = [], saveTimer, onExit = null;
const opts = { brush: 60, hard: 0.5, maskMode: 'hide', selShape: 'rect', cloneSrc: null };
let selection = null; // polygon in doc coords

export function newDoc(name = 'Photo', w = 1080, h = 1920) { return { id: db.uid('p_'), name, w, h, layers: [], updated: Date.now(), kind: 'photo' }; }

// ---------- runtime per layer ----------
function adjFilter(a = {}) { let f = ''; if (a.b != null && a.b !== 1) f += `brightness(${a.b}) `; if (a.c != null && a.c !== 1) f += `contrast(${a.c}) `; if (a.s != null && a.s !== 1) f += `saturate(${a.s}) `; if (a.h) f += `hue-rotate(${a.h}deg) `; if (a.blur) f += `blur(${a.blur}px) `; return f.trim() || 'none'; }
export function renderLayer(L, r) {
  if (L.type === 'text') {
    const c = r.out || (r.out = canvas(2, 2)); const ctx0 = c.getContext('2d'); const st = L.style;
    ctx0.font = `${st.weight || 800} ${st.size}px "${st.font}"`; const lines = L.text.split('\n');
    const w = Math.max(...lines.map(l => ctx0.measureText(l).width)) + st.size * 1.2 + (st.strokeW || 0) * 4, h = lines.length * st.size * 1.15 + st.size * 0.8;
    c.width = Math.ceil(w); c.height = Math.ceil(h); const ctx = c.getContext('2d'); ctx.translate(c.width / 2, c.height / 2); drawTextBlock(ctx, L.text, st, 1);
    L.w = c.width; L.h = c.height; return c;
  }
  const out = r.out || (r.out = canvas(L.w, L.h)); out.width = L.w; out.height = L.h;
  const ctx = out.getContext('2d'); ctx.clearRect(0, 0, L.w, L.h);
  ctx.filter = adjFilter(L.adj); ctx.drawImage(r.pix, 0, 0); ctx.filter = 'none';
  const warm = L.adj?.warm || 0; if (warm) { ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = warm > 0 ? `rgba(255,140,0,${warm})` : `rgba(0,120,255,${-warm})`; ctx.fillRect(0, 0, L.w, L.h); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(r.pix, 0, 0); ctx.globalCompositeOperation = 'source-over'; }
  if (r.mask) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(r.mask, 0, 0); ctx.globalCompositeOperation = 'source-over'; }
  return out;
}
async function loadRuntime(L) {
  const r = { dirtyPix: false, dirtyMask: false };
  if (L.type === 'image') {
    const img = await loadImage(await db.mediaURL(L.pixId)); r.pix = canvas(L.w, L.h); r.pix.getContext('2d').drawImage(img, 0, 0);
    if (L.maskId) { const m = await loadImage(await db.mediaURL(L.maskId)); r.mask = canvas(L.w, L.h); r.mask.getContext('2d').drawImage(m, 0, 0); }
  }
  rt.set(L.id, r); return r;
}
export async function loadDocRuntime(d) { const m = new Map(); const keep = rt; rt = m; for (const L of d.layers) await loadRuntime(L); const out = rt; rt = keep; return out; }

// Flatten whole doc, or one layer (trimmed to its visible pixels).
export function flatten(d, runtime, onlyLayerId = null) {
  const c = canvas(d.w, d.h), ctx = c.getContext('2d');
  for (const L of d.layers) {
    if (onlyLayerId ? L.id !== onlyLayerId : !L.visible) continue;
    const r = runtime.get(L.id); const out = renderLayer(L, r);
    ctx.save(); ctx.globalAlpha = L.opacity ?? 1; ctx.globalCompositeOperation = onlyLayerId ? 'source-over' : (L.blend || 'source-over');
    ctx.translate(L.x, L.y); ctx.rotate((L.rot || 0) * Math.PI / 180); ctx.scale(L.sx ?? L.scale ?? 1, L.scale ?? 1); ctx.drawImage(out, -L.w / 2, -L.h / 2); ctx.restore();
  }
  return onlyLayerId ? trim(c) : c;
}
export function trim(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return c; const o = canvas(x1 - x0 + 1, y1 - y0 + 1); o.getContext('2d').drawImage(c, -x0, -y0); return o;
}

// ---------- editor ----------
export async function openPhoto(d, exitCb) {
  doc = d; onExit = exitCb; undo = []; selection = null; opts.cloneSrc = null;
  rt = new Map(); for (const L of doc.layers) await loadRuntime(L);
  $('#pName').value = doc.name; $('#pName').oninput = () => { doc.name = $('#pName').value; scheduleSave(); };
  buildStage(); sel = doc.layers.at(-1)?.id || null; refreshAll(); setTool('move');
}
export const currentDoc = () => doc; export const currentRuntime = () => rt;

function buildStage() {
  const wrap = $('#stageWrap'); const box = $('#stage'); box.innerHTML = '';
  const W = wrap.clientWidth || 400, H = wrap.clientHeight || 400; const s = Math.min(W / doc.w, H / doc.h) * 0.96;
  stage?.destroy(); stage = new Konva.Stage({ container: box, width: doc.w * s, height: doc.h * s });
  klayer = new Konva.Layer({ scaleX: s, scaleY: s, clip: { x: 0, y: 0, width: doc.w, height: doc.h } }); stage.add(klayer);
  stage.fitScale = s;
  tr = new Konva.Transformer({ rotateEnabled: true, keepRatio: true, anchorSize: 22, borderStroke: '#ff4f7b', anchorStroke: '#ff4f7b', rotateAnchorOffset: 36, enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'] });
  klayer.add(tr); const over = new Konva.Layer({ scaleX: s, scaleY: s, listening: false }); stage.add(over); stage.overlay = over;
  stage.on('pointerdown', down); stage.on('pointermove', move); stage.on('pointerup pointerleave', up);
}
function node(L) {
  let n = klayer.findOne('#' + L.id);
  if (!n) { n = new Konva.Image({ id: L.id, draggable: true }); n.on('dragstart transformstart', () => pushUndo('state')); n.on('dragend transformend', () => { syncFromNode(L, n); scheduleSave(); }); n.on('pointerdown', () => { if (tool === 'move') { sel = L.id; refreshList(); refreshProps(); attachTr(); } }); klayer.add(n); }
  return n;
}
function syncFromNode(L, n) { L.x = n.x(); L.y = n.y(); L.scale = n.scaleY(); L.sx = n.scaleX(); L.rot = n.rotation(); }
function drawLayerNode(L) {
  const r = rt.get(L.id); const out = renderLayer(L, r); const n = node(L);
  n.image(out); n.width(L.w); n.height(L.h); n.offsetX(L.w / 2); n.offsetY(L.h / 2);
  n.x(L.x); n.y(L.y); n.scaleX(L.sx ?? L.scale); n.scaleY(L.scale); n.rotation(L.rot || 0); n.opacity(L.opacity ?? 1); n.visible(L.visible !== false);
  n.globalCompositeOperation(L.blend || 'source-over'); n.draggable(tool === 'move');
}
function refreshAll() {
  klayer.find('Image').forEach(n => { if (!doc.layers.find(L => L.id === n.id())) n.destroy(); });
  doc.layers.forEach((L, i) => { drawLayerNode(L); node(L).zIndex(i); });
  tr.moveToTop(); attachTr(); klayer.batchDraw(); refreshList(); refreshProps(); drawOverlay();
}
function attachTr() { const n = sel && tool === 'move' ? klayer.findOne('#' + sel) : null; tr.nodes(n ? [n] : []); klayer.batchDraw(); }
const selL = () => doc.layers.find(L => L.id === sel);

function refreshList() {
  const ul = $('#layerList'); ul.innerHTML = '';
  if (!doc.layers.length) ul.append(el('li', {}, el('span', { class: 'name hint' }, 'Add a photo or text to start.')));
  [...doc.layers].reverse().forEach(L => {
    const r = rt.get(L.id); const thumb = el('img', { alt: '' }); try { thumb.src = r.out.toDataURL('image/png', 0.3); } catch {}
    ul.append(el('li', { class: L.id === sel ? 'sel' : '' },
      el('button', { class: 'icon', 'aria-label': L.visible === false ? 'Show layer' : 'Hide layer', onclick: () => { pushUndo('state'); L.visible = L.visible === false; refreshAll(); scheduleSave(); } }, L.visible === false ? '◌' : '👁'),
      thumb,
      el('span', { class: 'name', onclick: () => { sel = L.id; refreshAll(); } }, L.name + (rt.get(L.id)?.mask ? ' · mask' : '')),
      el('button', { class: 'icon', 'aria-label': 'Move layer up', onclick: () => moveLayer(L, 1) }, '▲'),
      el('button', { class: 'icon', 'aria-label': 'Move layer down', onclick: () => moveLayer(L, -1) }, '▼')));
  });
}
function moveLayer(L, d) { const i = doc.layers.indexOf(L), j = i + d; if (j < 0 || j >= doc.layers.length) return; pushUndo('state'); doc.layers.splice(i, 1); doc.layers.splice(j, 0, L); refreshAll(); scheduleSave(); }

function refreshProps() {
  const box = $('#layerProps'); box.innerHTML = ''; const L = selL(); if (!L) return;
  const re = () => { drawLayerNode(L); klayer.batchDraw(); scheduleSave(); };
  const name = el('input', { value: L.name, 'aria-label': 'Layer name' }); name.oninput = () => { L.name = name.value; scheduleSave(); };
  box.append(el('div', { class: 'row' }, name,
    el('button', { class: 'small ghost', onclick: () => duplicate(L) }, 'Duplicate'),
    el('button', { class: 'small ghost', onclick: () => { pushUndo('state'); doc.layers = doc.layers.filter(x => x !== L); sel = doc.layers.at(-1)?.id; refreshAll(); scheduleSave(); } }, 'Delete')));
  box.append(slider('Opacity', L.opacity ?? 1, 0, 1, 0.01, v => { L.opacity = v; re(); }, v => Math.round(v * 100) + '%'));
  const bl = el('select', { 'aria-label': 'Blend mode' }, BLENDS.map(([v, t]) => el('option', { value: v, selected: v === (L.blend || 'source-over') }, t))); bl.onchange = () => { L.blend = bl.value; re(); };
  box.append(el('div', { class: 'field' }, el('span', {}, 'Blend'), bl, el('span')));
  if (L.type === 'image') {
    const a = L.adj || (L.adj = {});
    box.append(el('h3', {}, 'Colour & tone'));
    box.append(slider('Brightness', a.b ?? 1, 0.3, 1.8, 0.01, v => { a.b = v; re(); }, v => v.toFixed(2)));
    box.append(slider('Contrast', a.c ?? 1, 0.3, 1.8, 0.01, v => { a.c = v; re(); }, v => v.toFixed(2)));
    box.append(slider('Saturation', a.s ?? 1, 0, 2.5, 0.01, v => { a.s = v; re(); }, v => v.toFixed(2)));
    box.append(slider('Hue', a.h ?? 0, -180, 180, 1, v => { a.h = v; re(); }, v => v + '°'));
    box.append(slider('Warmth', a.warm ?? 0, -0.6, 0.6, 0.01, v => { a.warm = v; re(); }, v => v.toFixed(2)));
    box.append(el('h3', {}, 'Background & mask'));
    box.append(el('div', { class: 'row' },
      el('button', { class: 'small', id: 'rmPeople', onclick: () => removeBg(L, 'people') }, 'Remove background (people)'),
      el('button', { class: 'small ghost', onclick: () => removeBg(L, 'fine') }, 'Fine edges (portrait)'),
      el('button', { class: 'small ghost', onclick: () => maskOp(L, 'invert') }, 'Invert mask'),
      el('button', { class: 'small ghost', onclick: () => maskOp(L, 'clear') }, 'Clear mask'),
      el('button', { class: 'small ghost', onclick: () => { pushUndo('state'); L.sx = -(L.sx ?? L.scale); re(); } }, 'Flip')));
  } else {
    const st = L.style; const ta = el('textarea', { rows: 2, 'aria-label': 'Text' }, L.text); ta.oninput = () => { L.text = ta.value || ' '; re(); refreshListSoon(); };
    box.append(ta, ...textStyleControls(st, re));
  }
}
let listT; function refreshListSoon() { clearTimeout(listT); listT = setTimeout(refreshList, 400); }
export function textStyleControls(st, re) {
  const f = el('select', { 'aria-label': 'Font' }, FONTS.map(([v, t]) => el('option', { value: v, selected: v === st.font }, t))); f.onchange = () => { st.font = f.value; st.weight = FONTS.find(x => x[0] === f.value)[2]; re(); };
  const col = el('input', { type: 'color', value: st.color || '#ffffff', 'aria-label': 'Text colour' }); col.oninput = () => { st.color = col.value; re(); };
  const sc = el('input', { type: 'color', value: st.stroke || '#000000', 'aria-label': 'Outline colour' }); sc.oninput = () => { st.stroke = sc.value; re(); };
  const bgc = el('input', { type: 'color', value: st.bg || '#000000', 'aria-label': 'Box colour' }); const bgOn = el('input', { type: 'checkbox', checked: !!st.bg }); const upd = () => { st.bg = bgOn.checked ? bgc.value + 'cc' : ''; re(); }; bgc.oninput = upd; bgOn.onchange = upd;
  const sh = el('input', { type: 'checkbox', checked: !!st.shadow }); sh.onchange = () => { st.shadow = sh.checked; re(); };
  return [el('div', { class: 'field' }, el('span', {}, 'Font'), f, el('span')),
    slider('Size', st.size, 20, 260, 1, v => { st.size = v; re(); }),
    slider('Outline', st.strokeW || 0, 0, 16, 1, v => { st.strokeW = v; re(); }),
    el('div', { class: 'row' }, el('label', {}, 'Colour ', col), el('label', {}, 'Outline ', sc), el('label', {}, bgOn, 'Box ', bgc), el('label', {}, sh, 'Shadow'))];
}

async function duplicate(L) {
  pushUndo('state'); const r = rt.get(L.id); const C = structuredClone(L); C.id = db.uid('l_'); C.name = L.name + ' copy'; C.x += 30; C.y += 30;
  const r2 = { dirtyPix: true, dirtyMask: !!r.mask };
  if (L.type === 'image') { r2.pix = canvas(L.w, L.h); r2.pix.getContext('2d').drawImage(r.pix, 0, 0); if (r.mask) { r2.mask = canvas(L.w, L.h); r2.mask.getContext('2d').drawImage(r.mask, 0, 0); } C.pixId = null; C.maskId = null; }
  rt.set(C.id, r2); doc.layers.splice(doc.layers.indexOf(L) + 1, 0, C); sel = C.id; refreshAll(); scheduleSave();
}

export async function addImageLayer(file, name) {
  const img = await loadImage(URL.createObjectURL(file)); const max = 2048, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
  const r = { pix: canvas(w, h), dirtyPix: true }; r.pix.getContext('2d').drawImage(img, 0, 0, w, h);
  if (!doc.layers.length && name !== 'keep-size') { doc.w = w; doc.h = h; buildStage(); }
  const fit = Math.min(doc.w / w, doc.h / h); const L = { id: db.uid('l_'), type: 'image', name: name && name !== 'keep-size' ? name : (file.name || 'Photo').replace(/\.[^.]+$/, '').slice(0, 24), visible: true, opacity: 1, blend: 'source-over', x: doc.w / 2, y: doc.h / 2, scale: Math.min(1, fit), rot: 0, w, h, adj: {}, pixId: null, maskId: null };
  rt.set(L.id, r); pushUndo('state'); doc.layers.push(L); sel = L.id; refreshAll(); scheduleSave(); return L;
}
function addTextLayer() {
  const L = { id: db.uid('l_'), type: 'text', name: 'Text', text: 'Your text', style: { font: 'Anton', weight: 400, size: Math.round(doc.w / 9), color: '#ffffff', stroke: '#000000', strokeW: 4, shadow: true, bg: '' }, visible: true, opacity: 1, blend: 'source-over', x: doc.w / 2, y: doc.h / 2, scale: 1, rot: 0, w: 10, h: 10 };
  rt.set(L.id, {}); pushUndo('state'); doc.layers.push(L); sel = L.id; refreshAll(); scheduleSave();
}

// ---------- masks & background removal ----------
function ensureMask(L) { const r = rt.get(L.id); if (!r.mask) { r.mask = canvas(L.w, L.h); const c = r.mask.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, L.w, L.h); } return r.mask; }
function setMaskAlpha(L, alpha) {
  const m = ensureMask(L); const c = m.getContext('2d'); const id = c.createImageData(L.w, L.h);
  for (let i = 0; i < alpha.length; i++) { id.data[i * 4 + 3] = alpha[i]; }
  c.putImageData(id, 0, 0); rt.get(L.id).dirtyMask = true;
}
async function removeBg(L, mode) {
  const r = rt.get(L.id); pushUndo('mask', L); toast(mode === 'fine' ? 'Finding fine edges… (first time loads a 6.6 MB model)' : 'Finding the person…', 4000);
  try {
    let alpha;
    if (mode === 'fine') { const d = r.pix.getContext('2d').getImageData(0, 0, L.w, L.h); const res = await fineMatte(d); alpha = res.alpha; }
    else alpha = await personMask(r.pix);
    setMaskAlpha(L, alpha); drawLayerNode(L); klayer.batchDraw(); refreshList(); scheduleSave(); toast('Background removed. Paint with Mask to fix edges.');
  } catch (e) { console.error(e); toast('Could not remove background: ' + e.message, 5000); }
}
function maskOp(L, op) {
  const r = rt.get(L.id); if (!r.mask && op !== 'clear') return toast('This layer has no mask yet.');
  pushUndo('mask', L);
  if (op === 'clear') r.mask = null;
  else { const c = r.mask.getContext('2d'); const d = c.getImageData(0, 0, L.w, L.h); for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255 - d.data[i]; c.putImageData(d, 0, 0); }
  r.dirtyMask = true; drawLayerNode(L); klayer.batchDraw(); refreshList(); scheduleSave();
}

// ---------- tools ----------
export function setTool(t) {
  tool = t; document.querySelectorAll('[data-ptool]').forEach(b => b.classList.toggle('on', b.dataset.ptool === t));
  doc?.layers.forEach(L => klayer?.findOne('#' + L.id)?.draggable(t === 'move')); attachTr();
  const o = $('#ptoolOpts'); o.innerHTML = '';
  const brush = () => [slider('Brush', opts.brush, 4, 300, 1, v => opts.brush = v), slider('Softness', 1 - opts.hard, 0, 1, 0.05, v => opts.hard = 1 - v, v => Math.round(v * 100) + '%')];
  if (t === 'mask') o.append(chips([['hide', 'Hide (erase)'], ['reveal', 'Reveal (restore)']], opts.maskMode, v => opts.maskMode = v), ...brush());
  if (t === 'clone') o.append(el('p', { class: 'hint' }, 'Tap once to pick the source spot, then paint where you want it copied.'), el('button', { class: 'small ghost', onclick: () => { opts.cloneSrc = null; toast('Tap to pick a new source'); } }, 'New source'), ...brush());
  if (t === 'heal') o.append(el('p', { class: 'hint' }, 'Paint over a spot or small object; it is filled from nearby texture when you lift your finger.'), ...brush());
  if (t === 'select') {
    o.append(chips([['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['lasso', 'Lasso']], opts.selShape, v => opts.selShape = v));
    o.append(el('div', { class: 'row' },
      el('button', { class: 'small', onclick: () => applySel('keep') }, 'Keep inside'),
      el('button', { class: 'small ghost', onclick: () => applySel('erase') }, 'Erase inside'),
      el('button', { class: 'small ghost', onclick: () => applySel('copy') }, 'Copy to new layer'),
      el('button', { class: 'small ghost', onclick: () => { selection = null; drawOverlay(); } }, 'Deselect')));
  }
  drawOverlay();
}
const docPt = () => { const p = stage.getPointerPosition(); return { x: p.x / stage.fitScale, y: p.y / stage.fitScale }; };
function toLocal(L, p) { const n = klayer.findOne('#' + L.id); const m = n.getTransform().copy().invert(); const q = m.point(p); return { x: q.x, y: q.y }; } // node transform is in layer (doc) coords
let stroke = null;
function down() {
  if (tool === 'move') return; const L = selL(); const p = docPt();
  if (tool === 'select') { stroke = { pts: [p], start: p }; return; }
  if (!L || L.type !== 'image') return toast('Pick a photo layer first.');
  const r = rt.get(L.id); const lp = toLocal(L, p); const rad = opts.brush / 2 / Math.abs(L.scale || 1);
  if (tool === 'clone' && !opts.cloneSrc) { opts.cloneSrc = lp; toast('Source set. Now paint.'); drawOverlay(); return; }
  if (tool === 'mask') { pushUndo('mask', L); ensureMask(L); }
  if (tool === 'clone') { pushUndo('pix', L); const snap = canvas(L.w, L.h); snap.getContext('2d').drawImage(r.pix, 0, 0); stroke = { snap, off: { x: opts.cloneSrc.x - lp.x, y: opts.cloneSrc.y - lp.y } }; }
  if (tool === 'heal') { pushUndo('pix', L); stroke = { m: canvas(L.w, L.h) }; }
  stroke = { ...(stroke || {}), L, rad, last: lp }; dab(lp);
}
function move() {
  if (!stroke) return; const p = docPt();
  if (tool === 'select') { stroke.pts.push(p); selection = selPoly(stroke.start, p, stroke.pts); drawOverlay(); return; }
  const lp = toLocal(stroke.L, p); const d = Math.hypot(lp.x - stroke.last.x, lp.y - stroke.last.y), step = Math.max(1, stroke.rad / 4);
  for (let s = step; s <= d; s += step) dab({ x: stroke.last.x + (lp.x - stroke.last.x) * s / d, y: stroke.last.y + (lp.y - stroke.last.y) * s / d });
  stroke.last = lp;
}
function up() {
  if (!stroke) return; const s = stroke; stroke = null;
  if (tool === 'select') { if (s.pts.length < 2) selection = null; drawOverlay(); return; }
  const r = rt.get(s.L.id);
  if (tool === 'heal') { const ok = spotHeal(r.pix, s.m); r.dirtyPix = true; if (!ok) toast('Nothing to heal'); drawOverlay(); }
  if (tool === 'mask') r.dirtyMask = true; if (tool === 'clone') r.dirtyPix = true;
  drawLayerNode(s.L); klayer.batchDraw(); refreshList(); scheduleSave();
}
function dab(lp) {
  const s = stroke, r = rt.get(s.L.id);
  if (tool === 'mask') { const c = r.mask.getContext('2d'); c.save(); c.globalCompositeOperation = opts.maskMode === 'hide' ? 'destination-out' : 'source-over'; const g = c.createRadialGradient(lp.x, lp.y, s.rad * opts.hard, lp.x, lp.y, s.rad); g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.beginPath(); c.arc(lp.x, lp.y, s.rad, 0, 7); c.fill(); c.restore(); }
  if (tool === 'clone') cloneDab(r.pix.getContext('2d'), s.snap, lp.x + s.off.x, lp.y + s.off.y, lp.x, lp.y, s.rad, opts.hard);
  if (tool === 'heal') { const c = s.m.getContext('2d'); c.fillStyle = '#f00'; c.beginPath(); c.arc(lp.x, lp.y, s.rad, 0, 7); c.fill(); }
  if (tool !== 'heal') drawLayerNode(s.L); else drawHealPreview(s); klayer.batchDraw();
}
function drawHealPreview(s) { const ov = stage.overlay; ov.destroyChildren(); const n = klayer.findOne('#' + s.L.id); ov.add(new Konva.Image({ image: s.m, width: s.L.w, height: s.L.h, offsetX: s.L.w / 2, offsetY: s.L.h / 2, x: n.x(), y: n.y(), scaleX: n.scaleX(), scaleY: n.scaleY(), rotation: n.rotation(), opacity: 0.45 })); ov.batchDraw(); }
function selPoly(a, b, pts) {
  if (opts.selShape === 'lasso') return pts.slice();
  if (opts.selShape === 'rect') return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2; return Array.from({ length: 72 }, (_, i) => ({ x: cx + rx * Math.cos(i / 72 * Math.PI * 2), y: cy + ry * Math.sin(i / 72 * Math.PI * 2) }));
}
function drawOverlay() {
  if (!stage) return; const ov = stage.overlay; ov.destroyChildren();
  if (selection && tool === 'select') ov.add(new Konva.Line({ points: selection.flatMap(p => [p.x, p.y]), closed: true, stroke: '#fff', strokeWidth: 3 / stage.fitScale, dash: [10 / stage.fitScale, 8 / stage.fitScale], fill: 'rgba(255,79,123,.15)' }));
  if (tool === 'clone' && opts.cloneSrc && selL()) { const n = klayer.findOne('#' + sel); const p = n.getTransform().point(opts.cloneSrc); ov.add(new Konva.Circle({ x: p.x, y: p.y, radius: 14 / stage.fitScale, stroke: '#fff', strokeWidth: 3 / stage.fitScale })); }
  ov.batchDraw();
}
async function applySel(mode) {
  const L = selL(); if (!selection) return toast('Drag on the photo to select an area first.'); if (!L || L.type !== 'image') return toast('Pick a photo layer.');
  const r = rt.get(L.id); const poly = selection.map(p => toLocal(L, p));
  const pathOn = (c) => { c.beginPath(); poly.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); };
  if (mode === 'copy') {
    const C = canvas(L.w, L.h), c = C.getContext('2d'); pathOn(c); c.clip(); c.drawImage(renderLayer(L, r), 0, 0);
    pushUndo('state'); const N = { ...structuredClone(L), id: db.uid('l_'), name: L.name + ' piece', adj: {}, pixId: null, maskId: null };
    rt.set(N.id, { pix: C, dirtyPix: true }); doc.layers.splice(doc.layers.indexOf(L) + 1, 0, N); sel = N.id;
  } else {
    pushUndo('mask', L); const m = ensureMask(L), c = m.getContext('2d'); c.save();
    if (mode === 'erase') { c.globalCompositeOperation = 'destination-out'; pathOn(c); c.fillStyle = '#000'; c.fill(); }
    else { c.globalCompositeOperation = 'destination-in'; pathOn(c); c.fillStyle = '#000'; c.fill(); }
    c.restore(); r.dirtyMask = true;
  }
  selection = null; refreshAll(); scheduleSave();
}

// ---------- undo & save ----------
function pushUndo(kind, L) {
  const e = { kind, state: JSON.stringify(doc.layers) };
  if (L && (kind === 'pix' || kind === 'mask')) { const r = rt.get(L.id); e.id = L.id; const src = kind === 'pix' ? r.pix : r.mask; if (src) { e.canvas = canvas(L.w, L.h); e.canvas.getContext('2d').drawImage(src, 0, 0); } else e.canvas = null; }
  undo.push(e); if (undo.length > 15) undo.shift();
}
export function undoPhoto() {
  const e = undo.pop(); if (!e) return toast('Nothing to undo');
  doc.layers = JSON.parse(e.state);
  if (e.id) { const r = rt.get(e.id); if (e.kind === 'pix') { r.pix.getContext('2d').clearRect(0, 0, r.pix.width, r.pix.height); r.pix.getContext('2d').drawImage(e.canvas, 0, 0); r.dirtyPix = true; } else { r.mask = e.canvas; r.dirtyMask = true; } }
  if (!doc.layers.find(L => L.id === sel)) sel = doc.layers.at(-1)?.id; refreshAll(); scheduleSave();
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(savePhoto, 700); }
export async function savePhoto() {
  if (!doc) return; clearTimeout(saveTimer);
  for (const L of doc.layers) {
    const r = rt.get(L.id); if (!r || L.type !== 'image') continue;
    if (r.dirtyPix || !L.pixId) { const b = await canvasToBlob(r.pix); if (L.pixId) await db.replaceMedia(L.pixId, b); else L.pixId = await db.addMedia(b, L.name + '.png', { role: 'layer' }); r.dirtyPix = false; }
    if (r.dirtyMask) { if (r.mask) { const b = await canvasToBlob(r.mask); if (L.maskId) await db.replaceMedia(L.maskId, b); else L.maskId = await db.addMedia(b, L.name + '-mask.png', { role: 'mask' }); } else L.maskId = null; r.dirtyMask = false; }
  }
  const flat = flatten(doc, rt); const th = canvas(120, 120 * doc.h / doc.w); th.getContext('2d').drawImage(flat, 0, 0, th.width, th.height);
  doc.thumb = th.toDataURL('image/jpeg', 0.7); doc.updated = Date.now(); await db.put('photos', structuredClone(doc));
}

export function initPhotoUI(handlers) {
  document.querySelectorAll('[data-ptool]').forEach(b => b.onclick = () => setTool(b.dataset.ptool));
  $('#pAddImage').onclick = async () => { const [f] = await pickFiles('image/*', false); if (f) addImageLayer(f); };
  $('#pAddText').onclick = () => addTextLayer();
  $('#pUndo').onclick = undoPhoto;
  $('#pSavePng').onclick = async () => { await savePhoto(); const b = await canvasToBlob(flatten(doc, rt)); handlers.saveFile(b, (doc.name || 'photo') + '.png'); };
  $('#pBack').onclick = async () => { await savePhoto(); onExit?.(doc, rt, false); };
  $('#pSend').onclick = async () => {
    await savePhoto(); const L = selL();
    openSheet((body, close) => {
      body.append(el('h2', {}, 'Send to video'), el('p', { class: 'hint' }, 'Adds a see-through overlay at the playhead. Tap “Edit photo” on it later to come back to these layers.'),
        el('div', { class: 'list' },
          el('button', { onclick: () => { close(); onExit?.(doc, rt, { layerId: null }); } }, 'Whole photo (all visible layers)', el('span', {}, '→')),
          L ? el('button', { onclick: () => { close(); onExit?.(doc, rt, { layerId: L.id }); } }, `Only “${L.name}” (keeps transparency)`, el('span', {}, '→')) : null),
        el('p', {}, el('button', { class: 'ghost', onclick: close }, 'Cancel')));
    });
  };
  addEventListener('resize', () => { if (doc && $('#photo').classList.contains('active')) { buildStage(); refreshAll(); } });
}
export { addTextLayer };

// Make a saved photo doc from a canvas (+ optional alpha mask), without opening the editor.
export async function createDocFromCanvas(cv, alpha, name = 'Cutout') {
  const d = newDoc(name, cv.width, cv.height);
  const pixId = await db.addMedia(await canvasToBlob(cv), name + '.png', { role: 'layer' });
  let maskId = null;
  if (alpha) { const m = canvas(cv.width, cv.height), c = m.getContext('2d'), id = c.createImageData(cv.width, cv.height); for (let i = 0; i < alpha.length; i++) id.data[i * 4 + 3] = alpha[i]; c.putImageData(id, 0, 0); maskId = await db.addMedia(await canvasToBlob(m), name + '-mask.png', { role: 'mask' }); }
  const L = { id: db.uid('l_'), type: 'image', name, visible: true, opacity: 1, blend: 'source-over', x: cv.width / 2, y: cv.height / 2, scale: 1, rot: 0, w: cv.width, h: cv.height, adj: {}, pixId, maskId };
  d.layers.push(L); const rtm = await loadDocRuntime(d); const flat = flatten(d, rtm); const th = canvas(120, 120 * d.h / d.w); th.getContext('2d').drawImage(flat, 0, 0, th.width, th.height); d.thumb = th.toDataURL('image/jpeg', 0.7);
  await db.put('photos', d); return { doc: d, layerId: L.id, runtime: rtm };
}
