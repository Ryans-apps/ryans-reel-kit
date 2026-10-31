export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
export function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
export function pickFiles(accept, multiple = true, capture) {
  return new Promise(res => {
    const i = $('#filePick'); i.value = ''; i.accept = accept; i.multiple = multiple; if (capture) i.setAttribute('capture', capture); else i.removeAttribute('capture');
    i.onchange = () => res([...i.files]); i.click();
  });
}
// A slider row: label, range, value readout.
export function slider(label, value, min, max, step, onInput, fmtv = v => v) {
  const out = el('output', {}, fmtv(value));
  const r = el('input', { type: 'range', min, max, step, value, 'aria-label': label });
  r.addEventListener('input', () => { out.textContent = fmtv(+r.value); onInput(+r.value); });
  return el('div', { class: 'field' }, el('span', {}, label), r, out);
}
export function chips(options, current, onPick) {
  const wrap = el('div', { class: 'chips' });
  for (const [val, text] of options) {
    const b = el('button', { class: val === current ? 'on' : '', onclick: () => { $$('button', wrap).forEach(x => x.classList.remove('on')); b.classList.add('on'); onPick(val); } }, text);
    wrap.append(b);
  }
  return wrap;
}
export function openSheet(build) {
  const d = $('#sheet'), body = $('#sheetBody'); body.innerHTML = '';
  const close = () => d.close();
  build(body, close); if (!d.open) d.showModal(); return close;
}
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
export function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
export function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
export const canvasToBlob = (c, type = 'image/png', q) => new Promise(r => c.toBlob(r, type, q));
