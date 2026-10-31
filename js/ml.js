// Main-thread side of the AI worker + MediaPipe person segmentation.
let worker, seq = 0; const pending = new Map();
function w() {
  if (!worker) {
    worker = new Worker(new URL('./ml-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; if (data.type === 'progress') p.onProgress?.(data); else { pending.delete(data.id); data.type === 'done' ? p.res(data.result) : p.rej(new Error(data.error)); } };
    worker.onerror = (e) => { for (const p of pending.values()) p.rej(new Error(e.message || 'AI worker failed')); pending.clear(); };
  }
  return worker;
}
function call(msg, onProgress, transfer = []) { const id = ++seq; return new Promise((res, rej) => { pending.set(id, { res, rej, onProgress }); w().postMessage({ ...msg, id }, transfer); }); }
export const transcribe = (audio, model, onProgress) => call({ cmd: 'asr', audio, model }, onProgress, [audio.buffer]);
export async function fineMatte(imageData, onProgress) {
  const copy = new Uint8ClampedArray(imageData.data);
  return call({ cmd: 'matte', rgba: copy.buffer, width: imageData.width, height: imageData.height }, onProgress, [copy.buffer]);
}

// Group word timings into short caption lines.
export function wordsToCaptions(chunks, offset = 0, { maxWords = 4, maxChars = 22, gap = 0.6 } = {}) {
  const words = chunks.map(c => ({ text: c.text.trim(), start: (c.timestamp[0] ?? 0) + offset, end: (c.timestamp[1] ?? c.timestamp[0] + 0.3) + offset })).filter(w => w.text);
  const items = []; let cur = null;
  for (const wd of words) {
    const chars = cur ? cur.words.reduce((a, x) => a + x.text.length + 1, 0) : 0;
    if (!cur || cur.words.length >= maxWords || chars + wd.text.length > maxChars || wd.start - cur.end > gap || /[.!?]$/.test(cur.words.at(-1).text)) {
      cur = { id: 'c' + Math.random().toString(36).slice(2, 8), start: wd.start, end: wd.end, words: [] }; items.push(cur);
    }
    cur.words.push(wd); cur.end = Math.max(cur.end, wd.end);
  }
  for (let i = 0; i < items.length; i++) { const it = items[i]; it.text = it.words.map(x => x.text).join(' '); const nx = items[i + 1]; it.end = nx ? Math.min(Math.max(it.end, it.start + 0.4), nx.start) : Math.max(it.end, it.start + 0.6); }
  return items;
}
// After a manual text edit, keep the line's timing and share it across the new words.
export function retime(item, newText) {
  const ws = newText.trim().split(/\s+/).filter(Boolean); const d = (item.end - item.start) / Math.max(1, ws.length);
  item.text = ws.join(' '); item.words = ws.map((t, i) => ({ text: t, start: item.start + i * d, end: item.start + (i + 1) * d }));
}

// --- Person cut-out with MediaPipe selfie segmenter (fast, 250 KB model) ---
let segP;
async function segmenter() {
  if (!segP) segP = (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
    return ImageSegmenter.createFromOptions(fileset, { baseOptions: { modelAssetPath: new URL('../models/mediapipe/selfie_segmenter.tflite', import.meta.url).href, delegate: 'CPU' }, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false });
  })();
  return segP;
}
// Returns Uint8ClampedArray alpha (w*h) for a canvas.
export async function personMask(cv) {
  const seg = await segmenter();
  const res = seg.segment(cv);
  const m = res.confidenceMasks[0]; const f = m.getAsFloat32Array(); const mw = m.width, mh = m.height;
  const small = new ImageData(mw, mh);
  for (let i = 0; i < f.length; i++) { const v = Math.min(1, Math.max(0, (f[i] - 0.25) / 0.5)); small.data[i * 4 + 3] = v * 255; }
  res.close?.();
  // scale the mask to the image size with smoothing
  const a = document.createElement('canvas'); a.width = mw; a.height = mh; a.getContext('2d').putImageData(small, 0, 0);
  const b = document.createElement('canvas'); b.width = cv.width; b.height = cv.height; const bc = b.getContext('2d'); bc.imageSmoothingQuality = 'high'; bc.filter = 'blur(1px)'; bc.drawImage(a, 0, 0, cv.width, cv.height);
  const d = bc.getImageData(0, 0, cv.width, cv.height).data; const out = new Uint8ClampedArray(cv.width * cv.height); for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}
