// Draws one frame of a project at time t. Shared by the live preview and the exporter,
// so what you see is what you export.
export const TRANSITION_SEC = 0.5;
export const FILTERS = {
  none: '', vivid: 'saturate(1.45) contrast(1.1)', warm: 'sepia(.25) saturate(1.25) hue-rotate(-8deg)',
  cool: 'hue-rotate(12deg) saturate(1.05) brightness(1.03)', bw: 'grayscale(1) contrast(1.15)',
  fade: 'contrast(.85) brightness(1.08) saturate(.8)', vintage: 'sepia(.45) contrast(.95) brightness(1.05) saturate(.9)',
  noir: 'grayscale(1) contrast(1.6) brightness(.9)', punch: 'contrast(1.3) saturate(1.3)', dream: 'brightness(1.1) saturate(1.2) blur(.6px)',
};
export const FILTER_NAMES = { none: 'None', vivid: 'Vivid', warm: 'Warm', cool: 'Cool', bw: 'B&W', fade: 'Faded', vintage: 'Vintage', noir: 'Noir', punch: 'Punch', dream: 'Dreamy' };
export const TRANSITIONS = { none: 'None', fade: 'Fade', slide: 'Slide', zoom: 'Zoom', wipe: 'Wipe', blur: 'Blur', flash: 'Flash' };

export const clipDur = (c) => c.type === 'image' ? c.dur : (c.out - c.in) / c.speed;
export function layout(project) { // start time of each main clip
  let t = 0; return project.clips.map(c => { const s = t; t += clipDur(c); return { clip: c, start: s, end: t }; });
}
export function projectDuration(p) {
  let d = 0; for (const c of p.clips) d += clipDur(c);
  for (const o of p.overlays) d = Math.max(d, o.start + o.dur);
  for (const a of p.audio) if (a.kind !== 'music') d = Math.max(d, a.start + a.dur);
  return d;
}
export function clipAt(project, t) {
  const L = layout(project);
  for (let i = 0; i < L.length; i++) if (t < L[i].end || i === L.length - 1) return { ...L[i], index: i, local: t - L[i].start };
  return null;
}
export function filterCSS(c) {
  const a = c.adj || {}; let f = FILTERS[c.filter || 'none'] || '';
  if (a.b != null && a.b !== 1) f += ` brightness(${a.b})`;
  if (a.c != null && a.c !== 1) f += ` contrast(${a.c})`;
  if (a.s != null && a.s !== 1) f += ` saturate(${a.s})`;
  return f.trim() || 'none';
}
function hash(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }
function srcSize(d) { return [d.videoWidth || d.naturalWidth || d.displayWidth || d.width, d.videoHeight || d.naturalHeight || d.displayHeight || d.height]; }

// Draw a source to fill (cover) or fit (contain) the frame, with optional Ken Burns progress kb in [0,1].
export function drawFit(ctx, d, W, H, fit = 'cover', kb = null, seed = 0) {
  const [sw, sh] = srcSize(d); if (!sw || !sh) return;
  let s = fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  let dx = 0, dy = 0;
  if (kb != null) {
    const zoomIn = seed % 2 === 0, z = zoomIn ? 1 + 0.18 * kb : 1.18 - 0.18 * kb;
    s *= z; const dir = (seed >> 1) % 4, pan = 0.06 * (kb - 0.5);
    dx = (dir === 0 ? pan : dir === 1 ? -pan : 0) * W; dy = (dir === 2 ? pan : dir === 3 ? -pan : 0) * H;
  }
  const w = sw * s, h = sh * s;
  if (kb != null && fit !== 'contain') { const mx = Math.max(0, (w - W) / 2), my = Math.max(0, (h - H) / 2); dx = Math.max(-mx, Math.min(mx, dx)); dy = Math.max(-my, Math.min(my, dy)); } // never pan past the photo's edge
  if (fit === 'contain' && kb == null) { ctx.save(); ctx.filter = 'blur(30px) brightness(.6)'; const s2 = Math.max(W / sw, H / sh); ctx.drawImage(d, (W - sw * s2) / 2, (H - sh * s2) / 2, sw * s2, sh * s2); ctx.restore(); }
  ctx.drawImage(d, (W - w) / 2 + dx, (H - h) / 2 + dy, w, h);
}

function drawClip(ctx, clip, d, W, H, localT) {
  if (!d) return;
  ctx.save(); ctx.filter = filterCSS(clip);
  const kb = clip.type === 'image' && clip.kenBurns ? Math.min(1, localT / Math.max(0.1, clipDur(clip))) : null;
  drawFit(ctx, d, W, H, clip.fit || 'cover', kb, hash(clip.id));
  ctx.restore();
}

export function drawFrame(ctx, project, t, frames, opts = {}) {
  const W = ctx.canvas.width, H = ctx.canvas.height, k = W / 1080; // k scales px sizes designed at 1080 wide
  ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const cur = frames.main; // {clip, drawable, local}
  if (cur && cur.clip) {
    const tr = cur.clip.transition || 'none', TD = Math.min(TRANSITION_SEC, clipDur(cur.clip) / 2);
    const prev = frames.prev;
    if (tr !== 'none' && prev && prev.drawable && cur.local < TD) {
      const p = cur.local / TD, e = p * p * (3 - 2 * p);
      const drawPrev = () => drawClip(ctx, prev.clip, prev.drawable, W, H, clipDur(prev.clip));
      const drawCur = () => drawClip(ctx, cur.clip, cur.drawable, W, H, cur.local);
      if (tr === 'fade') { drawPrev(); ctx.globalAlpha = e; drawCur(); ctx.globalAlpha = 1; }
      else if (tr === 'slide') { ctx.save(); ctx.translate(-e * W, 0); drawPrev(); ctx.translate(W, 0); drawCur(); ctx.restore(); }
      else if (tr === 'zoom') { ctx.save(); const z = 1 + e * 0.5; ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2); ctx.globalAlpha = 1 - e; drawPrev(); ctx.restore(); ctx.globalAlpha = e; drawCur(); ctx.globalAlpha = 1; }
      else if (tr === 'wipe') { drawPrev(); ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * e, H); ctx.clip(); drawCur(); ctx.restore(); }
      else if (tr === 'blur') { ctx.save(); ctx.filter = `blur(${(e * 24 * k).toFixed(1)}px)`; ctx.globalAlpha = 1 - e; drawPrev(); ctx.restore(); ctx.save(); ctx.globalAlpha = e; drawCur(); ctx.restore(); }
      else if (tr === 'flash') { if (p < .5) drawPrev(); else drawCur(); ctx.fillStyle = `rgba(255,255,255,${1 - Math.abs(p - .5) * 2})`; ctx.fillRect(0, 0, W, H); }
      else drawCur();
    } else drawClip(ctx, cur.clip, cur.drawable, W, H, cur.local);
  }
  // Overlays in list order (later = on top)
  for (const o of project.overlays) {
    if (t < o.start || t >= o.start + o.dur) continue;
    drawOverlay(ctx, o, frames.overlays?.get(o.id), t - o.start, W, H, k, opts.still);
  }
  if (project.captions?.items?.length && project.captions.show !== false) drawCaptions(ctx, project.captions, t, W, H, k);
  if (opts.safeZone) drawSafeZone(ctx, W, H);
  ctx.restore();
}

function animState(o, lt, still) { // still: paused preview shows the settled look
  const a = o.anim || 'none', d = 0.3, outD = Math.min(0.25, o.dur / 4);
  let s = 1, al = 1, dy = 0;
  if (!still && a !== 'none' && lt < d) { const p = lt / d; if (a === 'pop') { s = 0.6 + 0.4 * (1 - Math.pow(1 - p, 3)) + Math.sin(p * Math.PI) * 0.08; al = p; } if (a === 'fade') al = p; if (a === 'up') { dy = (1 - p) * 0.08; al = p; } }
  if (!still && a !== 'none' && o.dur - lt < outD) al *= Math.max(0, (o.dur - lt) / outD);
  return { s, al, dy };
}

export function overlayBox(o, d, W, H) { // centre, size in frame px
  if (o.kind === 'text' || o.kind === 'sticker') return null;
  const [sw, sh] = d ? srcSize(d) : [1, 1]; const w = o.scale * W, h = w * (sh / sw || 1);
  return { cx: o.x * W, cy: o.y * H, w, h };
}

function drawOverlay(ctx, o, d, lt, W, H, k, still) {
  const { s, al, dy } = animState(o, lt, still);
  ctx.save(); ctx.globalAlpha = (o.opacity ?? 1) * al;
  ctx.translate(o.x * W, (o.y + dy) * H); ctx.rotate((o.rot || 0) * Math.PI / 180); ctx.scale(s, s);
  if (o.kind === 'text') drawTextBlock(ctx, o.text, o.style, k);
  else if (o.kind === 'sticker' && o.emoji) { ctx.font = `${Math.round(o.size * k)}px ${EMOJI_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(o.emoji, 0, 0); }
  else if (d) {
    const [sw, sh] = srcSize(d); if (sw) { const w = o.scale * W, h = w * sh / sw;
      if (o.shadow) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 24 * k; ctx.shadowOffsetY = 8 * k; }
      if (o.border) { ctx.fillStyle = '#fff'; const b = 10 * k; ctx.fillRect(-w / 2 - b, -h / 2 - b, w + 2 * b, h + 2 * b); ctx.shadowColor = 'transparent'; }
      ctx.drawImage(d, -w / 2, -h / 2, w, h); }
  }
  ctx.restore();
}

export function fontStr(st, k) { return `${st.weight || 800} ${Math.round((st.size || 72) * k)}px "${st.font || 'Montserrat'}", sans-serif`; }
export function drawTextBlock(ctx, text, st = {}, k = 1) {
  const lines = String(text || '').split('\n'); const size = (st.size || 72) * k, lh = size * 1.15;
  ctx.font = fontStr(st, k); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const y0 = -((lines.length - 1) * lh) / 2;
  if (st.bg) { const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + size * 0.8, h = lines.length * lh + size * 0.4; ctx.fillStyle = st.bg; roundRect(ctx, -w / 2, -h / 2, w, h, size * 0.25); ctx.fill(); }
  lines.forEach((l, i) => {
    const y = y0 + i * lh;
    if (st.strokeW) { ctx.strokeStyle = st.stroke || '#000'; ctx.lineWidth = st.strokeW * k * 2; ctx.strokeText(l, 0, y); }
    if (st.shadow) { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 12 * k; ctx.shadowOffsetY = 4 * k; }
    ctx.fillStyle = st.color || '#fff'; ctx.fillText(l, 0, y); ctx.shadowColor = 'transparent';
  });
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

// Captions: one short line group at a time; optional word-by-word highlight.
export function drawCaptions(ctx, cap, t, W, H, k) {
  const item = cap.items.find(c => t >= c.start && t < c.end); if (!item) return;
  const st = cap.style || {}; const size = (st.size || 66) * k;
  ctx.save(); ctx.font = fontStr(st, k); ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.lineJoin = 'round';
  const words = (item.words?.length ? item.words : [{ text: item.text, start: item.start, end: item.end }]).map(w => ({ ...w, text: st.upper ? w.text.toUpperCase() : w.text }));
  // Condensed fonts have a thin space and the popped word grows 12%, so keep a wider gap between words.
  const space = Math.max(ctx.measureText(' ').width, size * 0.28) + (st.hiPop ? size * 0.12 : 0) + (st.outlineW || 0) * k, maxW = W * 0.84; const lines = [[]]; let lw = 0;
  for (const w of words) { const ww = ctx.measureText(w.text).width; if (lw + ww > maxW && lines.at(-1).length) { lines.push([]); lw = 0; } lines.at(-1).push({ ...w, ww }); lw += ww + space; }
  const lh = size * 1.2, y0 = (st.y ?? 0.68) * H - ((lines.length - 1) * lh) / 2;
  if (st.bg) { const bw = Math.max(...lines.map(L => L.reduce((a, w) => a + w.ww + space, -space))) + size * 0.7; const bh = lines.length * lh + size * 0.35; ctx.fillStyle = st.bg; roundRect(ctx, (W - bw) / 2, y0 - lh / 2 - size * 0.17, bw, bh, size * 0.25); ctx.fill(); }
  lines.forEach((L, i) => {
    const total = L.reduce((a, w) => a + w.ww + space, -space); let x = (W - total) / 2; const y = y0 + i * lh;
    for (const w of L) {
      const active = st.highlight && t >= w.start && t < w.end + 0.05;
      if (st.outlineW) { ctx.strokeStyle = st.outline || '#000'; ctx.lineWidth = st.outlineW * k * 2; ctx.strokeText(w.text, x, y); }
      ctx.fillStyle = active ? (st.hiColor || '#ffd43b') : (st.color || '#fff');
      if (active && st.hiPop) { ctx.save(); ctx.translate(x + w.ww / 2, y); ctx.scale(1.12, 1.12); ctx.fillText(w.text, -w.ww / 2, 0); ctx.restore(); } else ctx.fillText(w.text, x, y);
      x += w.ww + space;
    }
  });
  ctx.restore();
}

// Guide for where short-video apps usually put their buttons and captions. Margins are an estimate.
export function drawSafeZone(ctx, W, H) {
  ctx.save(); ctx.fillStyle = 'rgba(255,60,90,.18)';
  const top = H * 0.09, bot = H * 0.21, right = W * 0.14, left = W * 0.05;
  ctx.fillRect(0, 0, W, top); ctx.fillRect(0, H - bot, W, bot); ctx.fillRect(W - right, top, right, H - top - bot); ctx.fillRect(0, top, left, H - top - bot);
  ctx.setLineDash([12, 8]); ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 2; ctx.strokeRect(left, top, W - left - right, H - top - bot);
  ctx.fillStyle = '#fff'; ctx.font = `${Math.round(W * 0.03)}px Inter, sans-serif`; ctx.fillText('Safe zone (estimate)', left + 8, top + W * 0.04);
  ctx.restore();
}

// Canvas text only uses a web font once the browser has loaded it (and, for emoji, the slice
// of the font that holds that character). Call before drawing or exporting.
export async function ensureFonts(p) {
  if (typeof document === 'undefined' || !document.fonts) return;
  const jobs = [];
  const add = (st, text) => { jobs.push(document.fonts.load(fontStr(st || {}, 1), text || 'A')); if (/\p{Extended_Pictographic}/u.test(text || '')) jobs.push(document.fonts.load('64px ' + EMOJI_FONT, text)); };
  for (const o of p.overlays || []) { if (o.kind === 'text') add(o.style, o.text); if (o.kind === 'sticker' && o.emoji) jobs.push(document.fonts.load('64px ' + EMOJI_FONT, o.emoji)); }
  const cs = p.captions?.style; if (cs && p.captions.items?.length) add(cs, p.captions.items.map(i => i.text).join(' '));
  await Promise.allSettled(jobs);
}

// Emoji come from the phone's own colour-emoji font (Android ships Noto Color Emoji).
export const EMOJI_FONT = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
