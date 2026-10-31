// Video editor: timeline, inspector, tools, live preview, export.
import * as db from './db.js';
import { $, $$, el, toast, fmt, clamp, slider, chips, pickFiles, openSheet, loadImage, canvas, canvasToBlob, sleep } from './util.js';
import { drawFrame, ensureFonts, layout, projectDuration, clipAt, clipDur, clipEnd, clipsEnd, touching, settleClips, migrateClips, FILTER_NAMES, TRANSITIONS, TRANSITION_SEC } from './compositor.js';
import { exportProject, PRESETS } from './exporter.js';
import { mix, forget as forgetAudio } from './audio.js';
import { transcribe, wordsToCaptions, retime, personMask } from './ml.js';
import { FONTS, CAPTION_PRESETS, TEXT_PRESETS } from './styles.js';
import { EMOJI, BOT_STICKERS, stickerPng } from './stickers.js';
import { textStyleControls, createDocFromCanvas } from './photo.js';

let P = null, selected = null, pps = 60, t = 0, playing = false, undoStack = [], saveT, hooks = {};
const els = new Map(), imgs = new Map(); // media elements for preview
const pv = () => $('#preview'), pctx = () => pv().getContext('2d');

export function newProject(name = 'My video') {
  return { id: db.uid('v_'), kind: 'video', name, width: 1080, height: 1920, fps: 30, clips: [], overlays: [], audio: [], captions: { items: [], style: structuredClone(CAPTION_PRESETS[0].style), show: true }, updated: Date.now() };
}
export const currentProject = () => P;
export function initVideoUI(h) {
  hooks = h;
  $('#vBack').onclick = async () => { stop(); await saveNow(); hooks.home(); };
  $('#vUndo').onclick = undo;
  $('#vName').oninput = () => { P.name = $('#vName').value; save(); };
  $('#vPlay').onclick = () => playing ? stop() : play();
  $('#vSplit').onclick = split;
  $('#vZoomIn').onclick = () => { pps = clamp(pps * 1.5, 10, 400); renderTimeline(); };
  $('#vZoomOut').onclick = () => { pps = clamp(pps / 1.5, 10, 400); renderTimeline(); };
  $('#safeZone').onchange = () => draw();
  $('#vExport').onclick = exportSheet;
  const sn = $('#snap'); sn.checked = localStorage.getItem('snap') !== '0'; sn.onchange = () => localStorage.setItem('snap', sn.checked ? '1' : '0');
  $('#vCloseGaps').onclick = closeGaps;
  const tl = $('#timeline');
  tl.addEventListener('scroll', () => { if (tl._prog) { tl._prog = false; return; } if (playing) stop(); seek(tl.scrollLeft / pps, false); }, { passive: true });
  tl.addEventListener('click', (e) => { if (e.target === tl || e.target.id === 'tlInner' || e.target.classList.contains('lane')) { selected = null; renderTimeline(); renderInspector(); } });
  $$('[data-tool]').forEach(b => b.onclick = () => TOOLS[b.dataset.tool]());
  addEventListener('resize', () => P && renderTimeline());
}
export async function openProject(p) {
  P = p; selected = null; undoStack = []; t = 0; stop(); if (migrateClips(P)) save(); // old projects: keep the back-to-back layout
  for (const e of els.values()) { e.pause(); e.removeAttribute('src'); } els.clear(); imgs.clear();
  $('#vName').value = P.name; await prepareMedia(); await ensureFonts(P); renderTimeline(); renderInspector(); seek(0);
}
// ---------- persistence & undo ----------
function commit() { undoStack.push(JSON.stringify(P)); if (undoStack.length > 40) undoStack.shift(); }
function changed(opts = {}) { if (opts.timeline !== false) renderTimeline(); if (opts.inspector) renderInspector(); draw(); save(); fontsThenDraw(); }
function fontsThenDraw() { ensureFonts(P).then(() => { if (!playing) draw(); }); }
function save() { clearTimeout(saveT); saveT = setTimeout(saveNow, 500); }
export async function saveNow() { if (!P) return; clearTimeout(saveT); P.updated = Date.now(); await db.put('projects', structuredClone(P)); }
async function undo() { const s = undoStack.pop(); if (!s) return toast('Nothing to undo'); const keep = selected; P = JSON.parse(s); selected = keep; await prepareMedia(); changed({ inspector: true }); }

// ---------- media for preview ----------
async function videoEl(key, mediaId) {
  let v = els.get(key); if (v && v._mid === mediaId) return v;
  v = document.createElement('video'); v.playsInline = true; v.preload = 'auto'; v._mid = mediaId; v.crossOrigin = 'anonymous';
  v.src = await db.mediaURL(mediaId); els.set(key, v);
  await new Promise(r => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 4000); });
  return v;
}
async function audioEl(key, mediaId) { let a = els.get(key); if (a && a._mid === mediaId) return a; a = new Audio(); a._mid = mediaId; a.preload = 'auto'; a.src = await db.mediaURL(mediaId); els.set(key, a); return a; }
async function imageEl(mediaId, force) { if (!force && imgs.has(mediaId)) return imgs.get(mediaId); const i = await loadImage(await db.mediaURL(mediaId)); imgs.set(mediaId, i); return i; }
async function prepareMedia() {
  for (const c of P.clips) c.type === 'video' ? await videoEl('clip:' + c.id, c.mediaId) : await imageEl(c.mediaId);
  for (const o of P.overlays) { if (o.kind === 'image') await imageEl(o.mediaId); if (o.kind === 'video') await videoEl('ov:' + o.id, o.mediaId); }
  for (const a of P.audio) await audioEl('au:' + a.id, a.mediaId);
}
export async function reloadImage(mediaId) { db.forgetURL(mediaId); await imageEl(mediaId, true); draw(); renderTimeline(); }

// ---------- preview drawing ----------
function seekEl(v, time) { if (!v) return; time = clamp(time, 0, (v.duration || 1e9) - 0.03); if (Math.abs(v.currentTime - time) > 0.03) { v.currentTime = time; v.addEventListener('seeked', draw, { once: true }); } }
function frameSet(time, live) {
  const ca = clipAt(P, time); const fr = { main: null, prev: null, overlays: new Map() };
  if (ca) {
    const c = ca.clip; let d;
    if (c.type === 'video') { d = els.get('clip:' + c.id); if (!live) seekEl(d, c.in + ca.local * c.speed); } else d = imgs.get(c.mediaId);
    fr.main = { clip: c, drawable: d, local: ca.local };
    if (ca.index > 0 && (c.transition || 'none') !== 'none' && ca.local < TRANSITION_SEC && touching(P.clips[ca.index - 1], c)) {
      const pc = P.clips[ca.index - 1]; let pd;
      if (pc.type === 'video') { pd = els.get('clip:' + pc.id); seekEl(pd, pc.out - 0.05); if (live && !pd.paused) pd.pause(); } else pd = imgs.get(pc.mediaId);
      fr.prev = { clip: pc, drawable: pd };
    }
  }
  for (const o of P.overlays) {
    if (o.kind === 'image') fr.overlays.set(o.id, imgs.get(o.mediaId));
    if (o.kind === 'video') { const v = els.get('ov:' + o.id); fr.overlays.set(o.id, v); if (!live && time >= o.start && time < o.start + o.dur) seekEl(v, (o.in || 0) + time - o.start); }
  }
  return fr;
}
export function draw() {
  if (!P) return; const ctx = pctx();
  drawFrame(ctx, P, t, frameSet(t, playing), { safeZone: $('#safeZone').checked, still: !playing });
  $('#dropHint').hidden = P.clips.length > 0 || P.overlays.length > 0;
  $('#vTime').textContent = `${fmt(t)} / ${fmt(projectDuration(P))}`;
}
function seek(time, scroll = true) { t = clamp(time, 0, projectDuration(P)); if (scroll) { const tl = $('#timeline'); tl._prog = true; tl.scrollLeft = t * pps; } draw(); }

// ---------- playback ----------
let raf, wall0, t0;
function play() {
  if (!P.clips.length && !P.overlays.length) return; if (t >= projectDuration(P) - 0.05) t = 0;
  playing = true; $('#vPlay').textContent = '❚❚'; $('#vPlay').setAttribute('aria-label', 'Pause'); wall0 = performance.now(); t0 = t; tick();
}
export function stop() {
  playing = false; cancelAnimationFrame(raf); if ($('#vPlay')) { $('#vPlay').textContent = '▶'; $('#vPlay').setAttribute('aria-label', 'Play'); }
  for (const e of els.values()) e.pause(); if (P) draw();
}
function syncEl(e, active, want, rate, vol) {
  if (!e) return;
  if (!active) { if (!e.paused) e.pause(); return; }
  e.playbackRate = rate; e.volume = clamp(vol, 0, 1);
  if (Math.abs(e.currentTime - want) > 0.25) e.currentTime = want;
  if (e.paused) e.play().catch(() => {});
}
function tick() {
  if (!playing) return; t = t0 + (performance.now() - wall0) / 1000; const dur = projectDuration(P);
  if (t >= dur) { t = dur; stop(); seek(dur); return; }
  const ca = clipAt(P, t);
  for (const c of P.clips) { if (c.type !== 'video') continue; const v = els.get('clip:' + c.id); const act = ca && ca.clip === c; v.muted = !!c.muted; syncEl(v, act, act ? c.in + ca.local * c.speed : 0, c.speed, c.volume ?? 1); }
  for (const o of P.overlays) if (o.kind === 'video') { const v = els.get('ov:' + o.id); v.muted = !!o.muted; syncEl(v, t >= o.start && t < o.start + o.dur, (o.in || 0) + t - o.start, 1, o.volume ?? 1); }
  for (const a of P.audio) { const e = els.get('au:' + a.id); const act = t >= a.start && t < a.start + a.dur; let vol = a.volume ?? 1; const fo = a.kind === 'music' ? (a.fadeOut ?? 1.5) : 0; const end = Math.min(a.start + a.dur, dur); if (fo && end - t < fo) vol *= Math.max(0, (end - t) / fo); syncEl(e, act, (a.in || 0) + t - a.start, 1, vol); }
  draw(); const tl = $('#timeline'); tl._prog = true; tl.scrollLeft = t * pps;
  raf = requestAnimationFrame(tick);
}

// ---------- timeline ----------
function lanes(items) { const ends = []; return items.map(it => { let l = ends.findIndex(e => e <= it.start + 0.001); if (l < 0) { l = ends.length; ends.push(0); } ends[l] = it.start + it.dur; return l; }); }
function renderTimeline() {
  if (!P) return; const tl = $('#timeline'), inner = $('#tlInner'); const pad = tl.clientWidth / 2; const dur = Math.max(projectDuration(P), 1);
  inner.innerHTML = ''; inner.style.width = (pad * 2 + dur * pps) + 'px';
  let y = 22; const H_MAIN = 52, H = 30, GAP = 4;
  // ruler
  const step = pps > 120 ? 0.5 : pps > 40 ? 1 : pps > 15 ? 5 : 10;
  for (let s = 0; s <= dur + 0.001; s += step) inner.append(el('div', { class: 'tick', style: `left:${pad + s * pps}px` }, Number.isInteger(s) ? fmt(s).replace(/\.0$/, '') : ''));
  const item = (kind, sel, x, w, top, h, label, onTap, extra = {}) => {
    const d = el('div', { class: `item k-${kind}${sel ? ' sel' : ''}`, style: `left:${x}px;width:${Math.max(18, w)}px;top:${top}px;height:${h}px;${extra.bg ? `background-image:url(${extra.bg});` : ''}`, role: 'button', 'aria-label': label }, label);
    d.addEventListener('click', (e) => { e.stopPropagation(); onTap(); });
    if (extra.drag) dragX(d, extra.drag); inner.append(d); return d;
  };
  layout(P).forEach(({ clip, start, end }, i) => {
    const d = item(clip.type === 'video' ? 'clip' : 'photo', selected?.id === clip.id, pad + start * pps, (end - start) * pps - 2, y, H_MAIN, `${clip.type === 'video' ? '🎞' : '🖼'} ${clip.name}${clip.speed !== 1 && clip.type === 'video' ? ' ×' + clip.speed : ''}`, () => select('clip', clip.id), { bg: clip.thumb, drag: { obj: clip, main: true } });
    d.dataset.clip = clip.id;
    if ((clip.transition || 'none') !== 'none' && touching(P.clips[i - 1], clip)) d.append(el('span', { class: 'tr' }, '⇄ ' + TRANSITIONS[clip.transition]));
  });
  $('#vCloseGaps').hidden = !hasGaps();
  y += H_MAIN + GAP;
  const ovL = lanes(P.overlays); const nOv = Math.max(0, ...ovL.map(l => l + 1));
  P.overlays.forEach((o, i) => item(o.kind, selected?.id === o.id, pad + o.start * pps, o.dur * pps, y + ovL[i] * (H + GAP), H,
    o.kind === 'text' ? 'T ' + o.text.split('\n')[0] : o.kind === 'sticker' ? (o.emoji || '★') + ' sticker' : (o.kind === 'video' ? '🎞 ' : '🖼 ') + (o.name || 'overlay'), () => select('overlay', o.id), { drag: { obj: o } }));
  y += nOv * (H + GAP);
  const auL = lanes(P.audio); const nAu = Math.max(0, ...auL.map(l => l + 1));
  P.audio.forEach((a, i) => item(a.kind, selected?.id === a.id, pad + a.start * pps, a.dur * pps, y + auL[i] * (H + GAP), H, (a.kind === 'voice' ? '🎙 ' : a.kind === 'sfx' ? '💥 ' : '♫ ') + a.name, () => select('audio', a.id), { drag: { obj: a } }));
  y += nAu * (H + GAP);
  if (P.captions.items.length) { const s = P.captions.items[0].start, e = P.captions.items.at(-1).end; item('caption', selected?.type === 'captions', pad + s * pps, (e - s) * pps, y, H, `CC ${P.captions.items.length} lines`, () => select('captions', 'captions')); y += H + GAP; }
  inner.style.height = Math.max(y + 8, tl.clientHeight - 2) + 'px';
  tl._prog = true; tl.scrollLeft = t * pps;
}
// Press and drag a selected item along time. Main clips push later clips along instead of overlapping.
const SNAP_PX = 10;
function snapTargets(obj) {
  const xs = [0, t];
  for (const c of P.clips) if (c !== obj) xs.push(c.start, clipEnd(c));
  for (const o of [...P.overlays, ...P.audio]) if (o !== obj) xs.push(o.start, o.start + o.dur);
  for (const it of P.captions.items) xs.push(it.start, it.end);
  return xs;
}
function snapStart(obj, start, len, targets) { // returns [start, snapX or null]
  if (!$('#snap').checked) return [start, null];
  let best = SNAP_PX / pps, out = [start, null];
  for (const x of targets) for (const [edge, off] of [[start, 0], [start + len, len]]) { const dd = Math.abs(edge - x); if (dd < best) { best = dd; out = [x - off, x]; } }
  return out;
}
function showSnapLine(x) {
  let ln = $('#snapLine'); if (x == null) { ln?.remove(); return; }
  if (!ln) { ln = el('div', { id: 'snapLine', class: 'snapline', 'aria-hidden': 'true' }); $('#tlInner').append(ln); }
  ln.style.left = ($('#timeline').clientWidth / 2 + x * pps) + 'px';
}
function dragX(d, { obj, main }) {
  let x0, s0, sc0, moved, orig, targets, len;
  const tl = () => $('#timeline');
  d.addEventListener('pointerdown', (e) => { if (selected?.id !== obj.id) return; x0 = e.clientX; s0 = obj.start; sc0 = tl().scrollLeft; moved = false; d.setPointerCapture(e.pointerId); e.stopPropagation(); });
  d.addEventListener('pointermove', (e) => {
    if (x0 == null) return; const T = tl(), r = T.getBoundingClientRect();
    if (moved) { if (e.clientX < r.left + 28) T.scrollLeft -= 8; else if (e.clientX > r.right - 28) T.scrollLeft += 8; } // auto-scroll near the edges
    const dx = e.clientX - x0 + (T.scrollLeft - sc0); if (!moved && Math.abs(dx) < 6) return;
    if (!moved) { commit(); moved = true; d.classList.add('dragging'); orig = new Map(P.clips.map(c => [c, c.start])); targets = snapTargets(obj); len = main ? clipDur(obj) : obj.dur; }
    let [ns, sx] = snapStart(obj, Math.max(0, s0 + dx / pps), len, targets); ns = Math.max(0, +ns.toFixed(3));
    const pad = T.clientWidth / 2;
    if (main) { for (const [c, st] of orig) c.start = st; obj.start = ns; settleClips(P); for (const c of P.clips) { const n = $(`#tlInner [data-clip="${c.id}"]`); if (n) n.style.left = (pad + c.start * pps) + 'px'; } }
    else { obj.start = ns; d.style.left = (pad + obj.start * pps) + 'px'; }
    showSnapLine(sx); draw();
  });
  const end = () => { if (x0 == null) return; x0 = null; showSnapLine(null); d.classList.remove('dragging'); if (moved) { if (main) settleClips(P); changed(); renderInspector(); } };
  d.addEventListener('pointerup', end); d.addEventListener('pointercancel', end);
}
// ◀ ▶ swap a clip with its neighbour and keep the gap between them.
function swapClips(i) {
  const A = P.clips[i], B = P.clips[i + 1]; if (!A || !B) return; commit();
  const gap = B.start - clipEnd(A), s = A.start; B.start = s; A.start = s + clipDur(B) + gap; settleClips(P); changed();
}
function hasGaps() { let end = 0; for (const c of [...P.clips].sort((a, b) => a.start - b.start)) { if (c.start > end + 0.02) return true; end = clipEnd(c); } return false; }
function closeGaps() { if (!hasGaps()) return toast('No gaps'); commit(); settleClips(P); let end = 0; for (const c of P.clips) { c.start = end; end = clipEnd(c); } changed({ inspector: true }); toast('Gaps closed'); }
// Trim, speed or length changes move the clips after it by the same amount, so gaps and touching clips stay as they were.
function ripple(c, fn) { const oldEnd = clipEnd(c); fn(); const dl = clipEnd(c) - oldEnd; if (Math.abs(dl) > 1e-6) for (const o of P.clips) if (o !== c && o.start >= oldEnd - 0.02) o.start += dl; settleClips(P); }
function select(type, id) { selected = { type, id }; renderTimeline(); renderInspector(); }
const findSel = () => !selected ? null : selected.type === 'clip' ? P.clips.find(c => c.id === selected.id) : selected.type === 'overlay' ? P.overlays.find(o => o.id === selected.id) : selected.type === 'audio' ? P.audio.find(a => a.id === selected.id) : selected.type === 'captions' ? P.captions : null;

// ---------- inspector ----------
const live = (fn) => (v) => { fn(v); draw(); save(); };
let commitT = 0; const cm = () => { if (Date.now() - commitT > 800) commit(); commitT = Date.now(); }; // one undo step per slider gesture
const sl = (label, v, min, max, step, fn, f) => slider(label, v, min, max, step, (x) => { cm(); fn(x); draw(); save(); clearTimeout(sl.t); sl.t = setTimeout(() => renderTimeline(), 250); }, f);
function head(title, ...btns) { return el('h3', {}, title, el('span', { class: 'row' }, ...btns)); }
const btn = (txt, fn, cls = 'small ghost') => el('button', { class: cls, onclick: fn }, txt);
function renderInspector() {
  const box = $('#inspector'); box.innerHTML = ''; const s = findSel(); box.hidden = !s; if (!s) return;
  const close = el('button', { class: 'icon', 'aria-label': 'Close panel', onclick: () => { selected = null; renderTimeline(); renderInspector(); } }, '✕');
  if (selected.type === 'clip') clipPanel(box, s, close);
  else if (selected.type === 'overlay') overlayPanel(box, s, close);
  else if (selected.type === 'audio') audioPanel(box, s, close);
  else captionsPanel(box, close);
}
function clipPanel(box, c, close) {
  const i = P.clips.indexOf(c);
  box.append(head(c.type === 'video' ? 'Video clip' : 'Photo clip', btn('◀', () => { if (i > 0) { swapClips(i - 1); renderInspector(); } }), btn('▶', () => { if (i < P.clips.length - 1) { swapClips(i); renderInspector(); } }),
    btn('Copy', () => { commit(); const d = { ...structuredClone(c), id: db.uid('c_'), start: clipEnd(c) }; P.clips.splice(i + 1, 0, d); settleClips(P); prepareMedia().then(() => changed()); }), btn('Delete', () => { commit(); P.clips.splice(i, 1); selected = null; changed({ inspector: true }); }), close));
  if (c.type === 'video') {
    box.append(sl('Start (trim)', c.in, 0, c.srcDur, 0.05, v => ripple(c, () => { c.in = Math.min(v, c.out - 0.2); }), v => fmt(v)));
    box.append(sl('End (trim)', c.out, 0, c.srcDur, 0.05, v => ripple(c, () => { c.out = Math.max(v, c.in + 0.2); }), v => fmt(v)));
    box.append(el('div', { class: 'field' }, el('span', {}, 'Speed'), chips([[0.25, '0.25×'], [0.5, '0.5×'], [1, '1×'], [1.5, '1.5×'], [2, '2×'], [3, '3×']].map(([v, l]) => [String(v), l]), String(c.speed), v => { commit(); ripple(c, () => c.speed = +v); changed(); }), el('span')));
    box.append(sl('Volume', c.volume ?? 1, 0, 1.5, 0.05, v => c.volume = v, v => Math.round(v * 100) + '%'));
    const m = el('input', { type: 'checkbox', checked: !!c.muted }); m.onchange = () => { commit(); c.muted = m.checked; save(); }; box.append(el('label', {}, m, ' Mute clip sound'));
  } else {
    box.append(sl('Length', c.dur, 0.5, 15, 0.1, v => ripple(c, () => c.dur = v), v => v.toFixed(1) + ' s'));
    const kb = el('input', { type: 'checkbox', checked: !!c.kenBurns }); kb.onchange = () => { commit(); c.kenBurns = kb.checked; draw(); save(); }; box.append(el('label', {}, kb, ' Ken Burns (slow pan & zoom)'));
  }
  box.append(el('div', { class: 'field' }, el('span', {}, 'Fit'), chips([['cover', 'Fill 9:16'], ['contain', 'Fit + blur']], c.fit || 'cover', v => { commit(); c.fit = v; draw(); save(); }), el('span')));
  box.append(el('h3', {}, 'Filter'), chips(Object.entries(FILTER_NAMES), c.filter || 'none', v => { commit(); c.filter = v; draw(); save(); }));
  const a = c.adj || (c.adj = {});
  box.append(sl('Brightness', a.b ?? 1, 0.5, 1.6, 0.01, v => a.b = v, v => v.toFixed(2)), sl('Contrast', a.c ?? 1, 0.5, 1.6, 0.01, v => a.c = v, v => v.toFixed(2)), sl('Saturation', a.s ?? 1, 0, 2, 0.01, v => a.s = v, v => v.toFixed(2)));
  if (i > 0 && touching(P.clips[i - 1], c)) box.append(el('h3', {}, 'Transition into this clip'), chips(Object.entries(TRANSITIONS), c.transition || 'none', v => { commit(); c.transition = v; changed(); seek(c.start + 0.2); }));
  else if (i > 0) box.append(el('p', { class: 'hint' }, 'Transitions work between clips that touch. Drag this clip against the one before it, or tap Close gaps.'));
}
function overlayPanel(box, o, close) {
  const title = { text: 'Text', sticker: 'Sticker', image: 'Photo overlay', video: 'Video overlay' }[o.kind];
  const i = P.overlays.indexOf(o);
  box.append(head(title, btn('Front', () => { commit(); P.overlays.splice(i, 1); P.overlays.push(o); changed(); }), btn('Copy', () => { commit(); const d = { ...structuredClone(o), id: db.uid('o_'), start: o.start + 0.5 }; P.overlays.push(d); prepareMedia().then(() => select('overlay', d.id)); save(); }), btn('Delete', () => { commit(); P.overlays.splice(i, 1); selected = null; changed({ inspector: true }); }), close));
  if (o.kind === 'image' && o.photoDocId) box.append(el('p', {}, btn('✎ Edit photo (layers)', () => hooks.editPhoto(o.photoDocId, o.id), 'small')));
  else if (o.kind === 'image') box.append(el('p', {}, btn('✎ Open in photo editor', () => hooks.photoFromOverlay(o), 'small ghost')));
  if (o.kind === 'text') {
    const ta = el('textarea', { rows: 2, 'aria-label': 'Text' }, o.text); ta.oninput = () => { cm(); o.text = ta.value; draw(); save(); };
    box.append(ta, chips(TEXT_PRESETS.map((p, k) => [String(k), p.name]), '', v => { commit(); Object.assign(o.style, structuredClone(TEXT_PRESETS[+v].style)); draw(); save(); renderInspector(); }), ...textStyleControls(o.style, () => { draw(); save(); }));
  }
  box.append(sl('Starts at', o.start, 0, Math.max(projectDuration(P), o.start + o.dur), 0.05, v => o.start = v, v => fmt(v)));
  box.append(sl('Duration', o.dur, 0.2, Math.max(20, projectDuration(P)), 0.05, v => o.dur = v, v => v.toFixed(1) + ' s'));
  box.append(btn('Make it last to the end', () => { commit(); o.dur = Math.max(0.2, clipsEnd(P) - o.start); changed({ inspector: true }); }));
  box.append(sl('Left ↔ right', o.x, 0, 1, 0.005, v => o.x = v, v => Math.round(v * 100) + '%'), sl('Up ↕ down', o.y, 0, 1, 0.005, v => o.y = v, v => Math.round(v * 100) + '%'));
  if (o.kind === 'sticker') box.append(sl('Size', o.size, 40, 900, 1, v => o.size = v));
  if (o.kind === 'image' || o.kind === 'video') box.append(sl('Size', o.scale, 0.05, 1.5, 0.01, v => o.scale = v, v => Math.round(v * 100) + '%'));
  box.append(sl('Rotate', o.rot || 0, -180, 180, 1, v => o.rot = v, v => v + '°'), sl('Opacity', o.opacity ?? 1, 0, 1, 0.01, v => o.opacity = v, v => Math.round(v * 100) + '%'));
  box.append(el('div', { class: 'field' }, el('span', {}, 'Animation'), chips([['none', 'None'], ['pop', 'Pop'], ['fade', 'Fade'], ['up', 'Slide up']], o.anim || 'none', v => { commit(); o.anim = v; save(); seek(o.start); }), el('span')));
  if (o.kind === 'image' || o.kind === 'video') {
    const sh = el('input', { type: 'checkbox', checked: !!o.shadow }); sh.onchange = () => { o.shadow = sh.checked; draw(); save(); };
    const bd = el('input', { type: 'checkbox', checked: !!o.border }); bd.onchange = () => { o.border = bd.checked; draw(); save(); };
    box.append(el('div', { class: 'row' }, el('label', {}, sh, ' Shadow'), el('label', {}, bd, ' White border')));
  }
  if (o.kind === 'video') { box.append(sl('Volume', o.volume ?? 1, 0, 1.5, 0.05, v => o.volume = v, v => Math.round(v * 100) + '%')); const m = el('input', { type: 'checkbox', checked: !!o.muted }); m.onchange = () => { o.muted = m.checked; save(); }; box.append(el('label', {}, m, ' Mute')); }
}
function audioPanel(box, a, close) {
  box.append(head({ music: 'Music', voice: 'Voiceover', sfx: 'Sound effect' }[a.kind] + ': ' + a.name, btn('Delete', () => { commit(); P.audio = P.audio.filter(x => x !== a); selected = null; changed({ inspector: true }); }), close));
  box.append(sl('Starts at', a.start, 0, Math.max(projectDuration(P), a.start + 1), 0.05, v => a.start = v, v => fmt(v)));
  box.append(sl('Skip into track', a.in || 0, 0, Math.max(0, (a.srcDur || a.dur) - 0.5), 0.1, v => a.in = v, v => fmt(v)));
  box.append(sl('Length', a.dur, 0.2, a.srcDur || 300, 0.1, v => a.dur = v, v => v.toFixed(1) + ' s'));
  box.append(sl('Volume', a.volume ?? 1, 0, 1.5, 0.05, v => a.volume = v, v => Math.round(v * 100) + '%'));
  if (a.kind === 'music') box.append(sl('Fade out', a.fadeOut ?? 1.5, 0, 6, 0.1, v => a.fadeOut = v, v => v.toFixed(1) + ' s'), btn('Fit to video length', () => { commit(); a.start = 0; a.dur = Math.min(a.srcDur || 1e9, clipsEnd(P)); changed({ inspector: true }); }));
}

// ---------- captions ----------
function captionsPanel(box, close) {
  const C = P.captions, st = C.style; const re = () => { draw(); save(); };
  const show = el('input', { type: 'checkbox', checked: C.show !== false }); show.onchange = () => { C.show = show.checked; re(); };
  box.append(head('Captions', btn('Redo', makeCaptions), btn('Remove all', () => { commit(); C.items = []; selected = null; changed({ inspector: true }); }), close), el('label', {}, show, ' Show on video'));
  box.append(el('h3', {}, 'Style'));
  const styleRow = el('div', { class: 'chips' }); box.append(styleRow);
  db.all('styles').then(saved => { styleRow.replaceWith(chips([...CAPTION_PRESETS, ...saved].map(s => [s.id, (s.preset ? '' : '★ ') + s.name]), '', async id => { const s = CAPTION_PRESETS.find(x => x.id === id) || saved.find(x => x.id === id); commit(); C.style = structuredClone(s.style); re(); renderInspector(); })); });
  box.append(btn('★ Save this style', async () => { const name = prompt('Name this caption style', 'My style'); if (!name) return; await db.put('styles', { id: db.uid('s_'), name, style: structuredClone(st) }); toast('Saved'); renderInspector(); }));
  const f = el('select', { 'aria-label': 'Caption font' }, FONTS.map(([v, l]) => el('option', { value: v, selected: v === st.font }, l))); f.onchange = () => { st.font = f.value; st.weight = FONTS.find(x => x[0] === f.value)[2]; re(); };
  box.append(el('div', { class: 'field' }, el('span', {}, 'Font'), f, el('span')), sl('Size', st.size, 30, 140, 1, v => st.size = v), sl('Height', st.y ?? 0.68, 0.1, 0.9, 0.01, v => st.y = v, v => Math.round(v * 100) + '%'), sl('Outline', st.outlineW || 0, 0, 14, 1, v => st.outlineW = v));
  const col = el('input', { type: 'color', value: st.color, 'aria-label': 'Caption colour' }); col.oninput = () => { st.color = col.value; re(); };
  const hc = el('input', { type: 'color', value: st.hiColor || '#ffd43b', 'aria-label': 'Highlight colour' }); hc.oninput = () => { st.hiColor = hc.value; re(); };
  const cb = (k, label) => { const x = el('input', { type: 'checkbox', checked: !!st[k] }); x.onchange = () => { st[k] = x.checked; re(); }; return el('label', {}, x, ' ' + label); };
  const bgOn = el('input', { type: 'checkbox', checked: !!st.bg }); bgOn.onchange = () => { st.bg = bgOn.checked ? '#000000b3' : ''; re(); };
  box.append(el('div', { class: 'row' }, el('label', {}, 'Colour ', col), cb('upper', 'CAPS'), el('label', {}, bgOn, ' Box'), cb('highlight', 'Word-by-word highlight'), el('label', {}, 'Highlight ', hc), cb('hiPop', 'Pop active word')));
  box.append(el('h3', {}, 'Lines (tap a time to jump there)'));
  C.items.forEach((it, k) => {
    const inp = el('input', { value: it.text, 'aria-label': 'Caption line ' + (k + 1) }); inp.onchange = () => { commit(); retime(it, inp.value); re(); };
    box.append(el('div', { class: 'caption-row' }, el('button', { class: 'small ghost', onclick: () => seek(it.start + 0.01) }, fmt(it.start)), inp, el('button', { class: 'icon', 'aria-label': 'Delete line', onclick: () => { commit(); C.items.splice(k, 1); changed({ inspector: true }); } }, '✕')));
  });
}
async function makeCaptions() {
  if (!P.clips.length && !P.audio.some(a => a.kind === 'voice')) return toast('Add a video with talking first.');
  const model = document.querySelector('input[name=asrModel]:checked')?.value || 'whisper-tiny.en_timestamped';
  const prog = el('progress', { class: 'progress', max: 1, value: 0 }); const msg = el('p', { class: 'hint' }, 'Getting the sound ready…');
  let closeIt; openSheet((b, close) => { closeIt = close; b.append(el('h2', {}, 'Making captions'), el('p', {}, 'This runs on your phone. The first time it loads the speech model (stored in the app).'), prog, msg); });
  try {
    const buf = await mix(P, { rate: 16000, channels: 1, speechOnly: true });
    const audio = new Float32Array(buf.getChannelData(0));
    const res = await transcribe(audio, model, (p) => { msg.textContent = p.stage + (p.value ? ` ${Math.round(p.value * 100)}%` : '…'); prog.value = p.value || 0; });
    const items = wordsToCaptions(res.chunks || []);
    if (!items.length) { closeIt(); return toast('No speech found.', 4000); }
    commit(); P.captions.items = items; P.captions.lastRun = { model, ms: Math.round(res.ms), threads: res.threads, words: res.chunks.length };
    closeIt(); select('captions', 'captions'); save(); toast(`${items.length} caption lines from ${res.chunks.length} words. Tap any line to fix it.`, 4000);
    return res;
  } catch (e) { console.error(e); msg.textContent = 'Could not make captions: ' + e.message; throw e; }
}

// ---------- adding things ----------
function probeVideo(url) { return new Promise((res, rej) => { const v = document.createElement('video'); v.preload = 'auto'; v.muted = true; v.playsInline = true; v.onloadeddata = () => res(v); v.onerror = () => rej(new Error('This video format cannot be played here.')); v.src = url; }); }
async function thumbOf(src) { const c = canvas(48, 85); const ctx = c.getContext('2d'); const sw = src.videoWidth || src.naturalWidth, sh = src.videoHeight || src.naturalHeight; const s = Math.max(48 / sw, 85 / sh); ctx.drawImage(src, (48 - sw * s) / 2, (85 - sh * s) / 2, sw * s, sh * s); return c.toDataURL('image/jpeg', 0.6); }
export async function addMediaFiles(files) {
  commit(); let n = 0;
  for (const f of files) {
    const id = await db.addMedia(f, f.name); const name = f.name.replace(/\.[^.]+$/, '').slice(0, 20);
    if (f.type.startsWith('video')) {
      try { const v = await probeVideo(await db.mediaURL(id)); await new Promise(r => { v.currentTime = Math.min(0.2, v.duration / 2); v.onseeked = r; setTimeout(r, 1500); });
        P.clips.push({ id: db.uid('c_'), start: clipsEnd(P), mediaId: id, type: 'video', name, in: 0, out: v.duration, srcDur: v.duration, speed: 1, volume: 1, muted: false, filter: 'none', adj: {}, transition: P.clips.length ? 'fade' : 'none', fit: 'cover', thumb: await thumbOf(v) }); n++;
      } catch (e) { toast(e.message, 4000); }
    } else if (f.type.startsWith('image')) {
      const img = await imageEl(id); P.clips.push({ id: db.uid('c_'), start: clipsEnd(P), mediaId: id, type: 'image', name, dur: 3, kenBurns: true, filter: 'none', adj: {}, transition: P.clips.length ? 'fade' : 'none', fit: (img.naturalWidth > img.naturalHeight ? 'contain' : 'cover'), thumb: await thumbOf(img) }); n++;
    }
  }
  await prepareMedia(); changed(); toast(n + ' added'); return n;
}
export async function addImageOverlay(blob, extra = {}) {
  commit(); const mediaId = await db.addMedia(blob, extra.name || 'overlay.png'); const img = await imageEl(mediaId);
  const ar = img.naturalWidth / img.naturalHeight, full = Math.abs(ar - 9 / 16) < 0.02 && !extra.scale; // a whole 9:16 photo fills the frame
  const o = { id: db.uid('o_'), kind: 'image', mediaId, name: extra.name || 'Photo', start: extra.start ?? t, dur: extra.dur ?? 3, x: 0.5, y: extra.y ?? 0.5, scale: full ? 1 : extra.scale ?? Math.min(0.7, 0.7 * (img.naturalWidth / img.naturalHeight) / (9 / 16) > 1 ? 0.8 : 0.6), rot: 0, opacity: 1, anim: full ? 'fade' : 'pop', shadow: !!extra.shadow, photoDocId: extra.photoDocId || null, photoLayerId: extra.photoLayerId || null };
  P.overlays.push(o); selected = { type: 'overlay', id: o.id }; changed({ inspector: true }); return o;
}
export async function replaceOverlayImage(o, blob) { await db.replaceMedia(o.mediaId, blob); await reloadImage(o.mediaId); save(); }
function addText(style) { commit(); const o = { id: db.uid('o_'), kind: 'text', text: 'Tap to edit', style: structuredClone(style), start: t, dur: 3, x: 0.5, y: 0.35, scale: 1, rot: 0, opacity: 1, anim: 'pop' }; P.overlays.push(o); select('overlay', o.id); draw(); save(); fontsThenDraw(); }
function addSticker(emoji) { commit(); const o = { id: db.uid('o_'), kind: 'sticker', emoji, size: 220, start: t, dur: 2.5, x: 0.5, y: 0.3, scale: 1, rot: 0, opacity: 1, anim: 'pop' }; P.overlays.push(o); select('overlay', o.id); draw(); save(); fontsThenDraw(); }
async function addAudio(kind, blob, name) {
  const mediaId = await db.addMedia(blob, name); const a = await audioEl('tmp', mediaId); els.delete('tmp');
  await new Promise(r => { if (a.readyState >= 1) r(); a.onloadedmetadata = r; a.onerror = r; setTimeout(r, 3000); });
  const srcDur = isFinite(a.duration) ? a.duration : 30; commit();
  const vidLen = clipsEnd(P) || srcDur;
  const item = { id: db.uid('a_'), kind, mediaId, name, start: kind === 'music' ? 0 : t, in: 0, dur: kind === 'music' ? Math.min(srcDur, vidLen) : srcDur, srcDur, volume: kind === 'music' ? 0.6 : 1, fadeOut: 1.5 };
  P.audio.push(item); await audioEl('au:' + item.id, mediaId); select('audio', item.id); save(); return item;
}
function split() {
  const s = findSel(); const ca = clipAt(P, t);
  if (selected?.type === 'overlay' || selected?.type === 'audio') { if (t <= s.start + 0.1 || t >= s.start + s.dur - 0.1) return toast('Move the playhead inside the item'); commit(); const b = { ...structuredClone(s), id: db.uid(selected.type === 'audio' ? 'a_' : 'o_'), start: t, dur: s.start + s.dur - t, in: (s.in || 0) + (t - s.start) }; s.dur = t - s.start; (selected.type === 'audio' ? P.audio : P.overlays).push(b); prepareMedia().then(() => changed()); return; }
  if (!ca) return toast('Move the playhead inside a clip'); const c = ca.clip; if (ca.local < 0.1 || clipDur(c) - ca.local < 0.1) return toast('Move the playhead inside a clip');
  commit(); const b = { ...structuredClone(c), id: db.uid('c_'), transition: 'none', start: c.start + ca.local };
  if (c.type === 'video') { const cut = c.in + ca.local * c.speed; b.in = cut; c.out = cut; } else { b.dur = c.dur - ca.local; c.dur = ca.local; }
  P.clips.splice(ca.index + 1, 0, b); prepareMedia().then(() => { selected = { type: 'clip', id: b.id }; changed({ inspector: true }); }); toast('Split');
}
const TOOLS = {
  media: async () => { const fs = await pickFiles('video/*,image/*', true); if (fs.length) await addMediaFiles(fs); },
  text: () => openSheet((b, close) => { b.append(el('h2', {}, 'Add text'), el('div', { class: 'list' }, TEXT_PRESETS.map(p => el('button', { onclick: () => { close(); addText(p.style); }, style: `font-family:'${p.style.font}';font-weight:${p.style.weight}` }, p.name, el('span', {}, '＋')))), btn('Cancel', close)); }),
  sticker: () => openSheet((b, close) => {
    b.append(el('h2', {}, 'Stickers'), el('div', { class: 'grid' }, EMOJI.map(e => el('button', { class: 'emoji', 'aria-label': 'Sticker ' + e, onclick: () => { close(); addSticker(e); } }, e))));
    b.append(el('h3', {}, 'Shapes (made by your bot)'), el('div', { class: 'grid' }, BOT_STICKERS.map(s => { const img = el('img', { alt: s.name, src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.svg), width: 48, height: 48 }); return el('button', { 'aria-label': s.name, onclick: async () => { close(); await addImageOverlay(await stickerPng(s), { name: s.name, scale: 0.35, dur: 2.5 }); } }, img); })), btn('Cancel', close));
  }),
  overlay: () => openSheet(async (b, close) => {
    const docs = (await db.all('photos')).sort((a, c) => c.updated - a.updated);
    b.append(el('h2', {}, 'Add an overlay'), el('div', { class: 'list' },
      el('button', { onclick: async () => { close(); const [f] = await pickFiles('image/*', false); if (f) addImageOverlay(f, { name: f.name.replace(/\.[^.]+$/, '').slice(0, 20) }); } }, 'Photo from phone', el('span', {}, '🖼')),
      el('button', { onclick: async () => { close(); const [f] = await pickFiles('video/*', false); if (f) addVideoOverlay(f); } }, 'Video (picture-in-picture)', el('span', {}, '🎞')),
      el('button', { onclick: () => { close(); hooks.newPhotoForVideo(); } }, 'New layered photo…', el('span', {}, '✎'))));
    if (docs.length) b.append(el('h3', {}, 'From my photos'), el('div', { class: 'grid' }, docs.map(d => el('button', { 'aria-label': d.name, onclick: () => { close(); hooks.sendDoc(d.id); } }, el('img', { src: d.thumb, alt: '', width: 48 })))));
    b.append(btn('Cancel', close));
  }),
  cutout: async () => {
    const [f] = await pickFiles('image/*', false); if (!f) return; toast('Cutting out the person…', 5000);
    try {
      const img = await loadImage(URL.createObjectURL(f)); const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)); const cv = canvas(img.naturalWidth * s, img.naturalHeight * s); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const alpha = await personMask(cv); const name = f.name.replace(/\.[^.]+$/, '').slice(0, 16) + ' cutout';
      const { doc, layerId, runtime } = await createDocFromCanvas(cv, alpha, name);
      const { flatten } = await import('./photo.js'); const out = flatten(doc, runtime, layerId);
      return addImageOverlay(await canvasToBlob(out), { name, photoDocId: doc.id, photoLayerId: layerId, shadow: true, scale: 0.6, y: 0.55 });
    } catch (e) { console.error(e); toast('Cutout failed: ' + e.message, 5000); }
  },
  audio: () => openSheet((b, close) => {
    const pre = new Audio(); const stopPre = () => pre.pause();
    const row = (label, url, kind) => el('div', { class: 'row' }, el('button', { class: 'icon', 'aria-label': 'Preview ' + label, onclick: () => { if (!pre.paused && pre._u === url) return stopPre(); pre.src = url; pre._u = url; pre.play(); } }, '▶'), el('span', { style: 'flex:1' }, label), el('button', { class: 'small', onclick: async () => { stopPre(); close(); const blob = await (await fetch(url)).blob(); addAudio(kind, blob, label); } }, 'Add'));
    b.append(el('h2', {}, 'Audio'), el('h3', {}, 'Voiceover'), el('p', {}, btn('🎙 Record voiceover at playhead', () => { stopPre(); close(); recordVoice(); }, 'small'), ' ', btn('Import audio file', async () => { close(); const [f] = await pickFiles('audio/*', false); if (f) addAudio('music', f, f.name.replace(/\.[^.]+$/, '').slice(0, 20)); })));
    b.append(el('h3', {}, 'Music (free CC0 tracks)'), ...MUSIC.map(([f, n]) => row(n, 'media/music/' + f, 'music')));
    b.append(el('h3', {}, 'Sound effects (CC0)'), ...SFX.map(([f, n]) => row(n, 'media/sfx/' + f, 'sfx')), btn('Close', () => { stopPre(); close(); }));
    $('#sheet').addEventListener('close', stopPre, { once: true });
  }),
  captions: () => { if (P.captions.items.length) return select('captions', 'captions'); openSheet((b, close) => b.append(el('h2', {}, 'Auto captions'), el('p', {}, 'Listens to your clips and voiceover on this phone and writes word-timed captions you can edit.'), el('p', { class: 'hint' }, 'English. Change Fast/Better in Settings.'), btn('Make captions', () => { close(); makeCaptions(); }, 'accent'), ' ', btn('Cancel', close))); },
};
export const MUSIC = [['forward-momentum.mp3', 'Forward Momentum'], ['sunlit-groove.mp3', 'Sunlit Groove'], ['quick-spark.mp3', 'Quick Spark'], ['mini-glow.mp3', 'Mini Glow'], ['splash-splash.mp3', 'Splash Splash']];
export const SFX = [['click_002.ogg', 'Click'], ['pluck_001.ogg', 'Pluck'], ['bong_001.ogg', 'Bong'], ['confirmation_001.ogg', 'Ding'], ['drop_002.ogg', 'Drop'], ['glass_001.ogg', 'Glass'], ['maximize_006.ogg', 'Whoosh up'], ['switch_002.ogg', 'Switch'], ['scratch_002.ogg', 'Scratch'], ['impactBell_heavy_000.ogg', 'Bell hit'], ['impactGeneric_light_002.ogg', 'Tap'], ['impactPunch_medium_000.ogg', 'Punch'], ['footstep_concrete_001.ogg', 'Step']];
async function addVideoOverlay(f) {
  commit(); const mediaId = await db.addMedia(f, f.name); let v; try { v = await probeVideo(await db.mediaURL(mediaId)); } catch (e) { return toast(e.message); }
  const o = { id: db.uid('o_'), kind: 'video', mediaId, name: f.name.replace(/\.[^.]+$/, '').slice(0, 20), start: t, dur: Math.min(v.duration, 10), in: 0, x: 0.72, y: 0.3, scale: 0.42, rot: 0, opacity: 1, anim: 'pop', border: true, volume: 1, muted: true };
  P.overlays.push(o); await prepareMedia(); select('overlay', o.id); draw(); save();
}
async function recordVoice() {
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { return toast('Microphone not allowed.', 4000); }
  const rec = new MediaRecorder(stream); const chunks = []; rec.ondataavailable = e => chunks.push(e.data); const startAt = t;
  openSheet((b, close) => {
    const timer = el('p', { class: 'time' }, '0:00.0'); const t0 = performance.now(); const h = setInterval(() => timer.textContent = fmt((performance.now() - t0) / 1000), 100);
    b.append(el('h2', {}, '🎙 Recording…'), el('p', { class: 'hint' }, 'The video plays muted so you can talk over it.'), timer, btn('■ Stop', () => { clearInterval(h); rec.stop(); close(); }, 'accent'));
    rec.onstop = async () => { stream.getTracks().forEach(x => x.stop()); stop(); t = startAt; const blob = new Blob(chunks, { type: rec.mimeType }); await addAudio('voice', blob, 'Voiceover'); seek(startAt); };
    rec.start(); for (const e of els.values()) e.muted = true; play();
  });
}

// ---------- export ----------
function exportSheet() {
  stop(); if (!P.clips.length && !P.overlays.length) return toast('Add something first.');
  openSheet((b, close) => {
    b.append(el('h2', {}, 'Export'), el('p', {}, `Length ${fmt(projectDuration(P))}. Keep the app open while it works.`),
      el('div', { class: 'list' }, el('button', { class: 'accent', id: 'exportSocial', onclick: () => runExport('social', b, close) }, '⚡ Export 9:16 (full quality)', el('span', {}, '1080×1920 MP4')),
        el('button', { onclick: () => runExport('fast', b, close) }, 'Quick export (smaller file)', el('span', {}, '720×1280'))), btn('Cancel', close));
  });
}
export async function runExport(preset, b, close) {
  b.innerHTML = ''; const prog = el('progress', { class: 'progress', max: 1, value: 0 }); const msg = el('p', { class: 'hint' }, 'Starting…'); const ac = new AbortController();
  b.append(el('h2', {}, 'Exporting…'), prog, msg, btn('Cancel', () => ac.abort()));
  let lock; try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  const t0 = performance.now();
  try {
    const r = await exportProject(P, preset, (p, m) => { prog.value = p; msg.textContent = m; }, ac.signal);
    const secs = ((performance.now() - t0) / 1000).toFixed(1); const name = (P.name || 'video').replace(/[^\w\- ]+/g, '').trim() + (r.codecs.fmt === 'mp4' ? '.mp4' : '.webm');
    const file = new File([r.blob], name, { type: r.blob.type }); window.__lastExport = { ...r, secs, name };
    const url = URL.createObjectURL(r.blob);
    b.innerHTML = '';
    b.append(el('h2', {}, 'Done ✓'), el('video', { src: url, controls: true, playsinline: true, class: 'export-preview' }), el('p', { class: 'hint' }, `${(r.blob.size / 1e6).toFixed(1)} MB · ${r.codecs.v.toUpperCase()}/${r.codecs.a.toUpperCase()} ${r.codecs.fmt.toUpperCase()} · made in ${secs} s`),
      el('div', { class: 'row' }, navigator.canShare?.({ files: [file] }) ? btn('Share…', () => navigator.share({ files: [file], title: P.name }).catch(() => {}), 'accent') : null, btn('Save to phone', () => hooks.saveFile(r.blob, name), 'accent'), btn('Close', close)));
    if (r.codecs.fmt !== 'mp4') b.append(el('p', { class: 'hint' }, 'This browser could not make MP4 here, so it saved WebM. Most apps accept it, but MP4 is safer.'));
    return r;
  } catch (e) { if (e.name === 'AbortError') { close(); toast('Export cancelled'); } else { console.error(e); msg.textContent = 'Export failed: ' + e.message; } }
  finally { lock?.release?.(); }
}
export const _test = { makeCaptions, split, undo, swapClips, closeGaps, hasGaps, get pps() { return pps; }, seek: (x) => seek(x), select, addText, addSticker, addAudio, get t() { return t; } };
