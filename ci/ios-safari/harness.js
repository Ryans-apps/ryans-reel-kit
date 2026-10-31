// Drives the real app inside a same-origin iframe in Mobile Safari, and reports to server.py.
// The app at /ryans-reel-kit/ is either a byte-for-byte proxy of the live GitHub Pages build or a local checkout.
const f = document.getElementById('f'), bar = document.getElementById('bar');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (path, body) => fetch(path, { method: 'POST', body }).catch(() => {});
const errors = [], consoleLog = [], toasts = []; const T0 = Date.now(); const ts = () => ((Date.now() - T0) / 1000).toFixed(1);
async function step(name, ok, detail) { bar.textContent = (ok ? '✓ ' : '✗ ') + name + ' ' + (detail ? JSON.stringify(detail).slice(0, 120) : ''); await post('/ci/log', JSON.stringify({ t: ts(), step: name, ok, detail })); }
const shot = async (name, wait = 1200) => { await sleep(wait); await post('/ci/shot?name=' + name); };
const W = () => f.contentWindow, D = () => f.contentWindow.document;
async function until(fn, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } throw new Error('timeout: ' + label); }
const fmt = a => a.map(x => x?.stack || x?.message || (typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch { return String(x); } })() : String(x))).join(' ');
function hook() { const w = W(); if (w.__ciHooked) return; w.__ciHooked = true;
  w.addEventListener('error', e => { const m = 'error: ' + (e.message || e.target?.src || e.type); errors.push(m); consoleLog.push(ts() + ' ' + m); }, true);
  w.addEventListener('unhandledrejection', e => { const m = 'rejection: ' + (e.reason?.message || e.reason); errors.push(m); consoleLog.push(ts() + ' ' + m); });
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { const o = w.console[k].bind(w.console); w.console[k] = (...a) => { const m = k + ': ' + fmt(a); consoleLog.push(ts() + ' ' + m); if (k === 'error' || k === 'warn') errors.push(m); o(...a); }; }
  const t = w.document.getElementById('toast'); if (t) new w.MutationObserver(() => { if (t.textContent && toasts[toasts.length - 1] !== t.textContent) { toasts.push(t.textContent); consoleLog.push(ts() + ' toast: ' + t.textContent); } }).observe(t, { childList: true, characterData: true, subtree: true }); }
async function ready(ms = 60000) { await until(() => { hook(); return D().body?.dataset.ready === '1' && W().__rrk; }, ms, 'app ready'); }
const q = s => D().querySelector(s);
const btnByText = (t) => [...D().querySelectorAll('button')].find(b => b.textContent.includes(t));
async function file(path, name, type) { const b = await (await fetch(path)).blob(); return new File([b], name, { type }); }
const race = (pr, ms) => Promise.race([Promise.resolve(pr).then(v => ({ v }), e => ({ err: String(e && e.message || e) })), sleep(ms).then(() => ({ timeout: ms }))]);
// pixel stats of an image/canvas/video: mean luma and std dev (std > ~4 means a real picture, not a flat/black box)
function stats(src, w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(src, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data; let s = 0, s2 = 0, n = 0; for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; s += l; s2 += l * l; n++; } const m = s / n; return { mean: +m.toFixed(1), std: +Math.sqrt(Math.max(0, s2 / n - m * m)).toFixed(1) }; }
async function imgStats(url) { const i = new Image(); i.src = url; await i.decode(); return { w: i.naturalWidth, h: i.naturalHeight, ...stats(i, i.naturalWidth, i.naturalHeight) }; }
(async () => {
  try {
    await step('ua', true, { ua: navigator.userAgent, VideoEncoder: 'VideoEncoder' in self, AudioEncoder: 'AudioEncoder' in self, VideoDecoder: 'VideoDecoder' in self });
    const swText = await (await fetch('/ryans-reel-kit/sw.js')).text(); const core = (swText.match(/core-v\d+/) || [])[0];
    await step('build', core === 'core-v7', { swCore: core });
    f.src = '/ryans-reel-kit/';
    await ready(); await step('load', true, { title: D().title, home: !!q('#home.active') });
    const reg = await Promise.race([W().navigator.serviceWorker.ready, sleep(30000).then(() => null)]);
    await sleep(3000); await ready(); // the app may reload itself once when the worker takes over
    await until(() => W().navigator.serviceWorker.controller, 20000, 'sw controller').catch(() => {});
    const keys = await W().caches.keys(); let coreN = 0; for (const k of keys) if (k.includes('core')) coreN = (await (await W().caches.open(k)).keys()).length;
    await step('service-worker', !!(reg && W().navigator.serviceWorker.controller) && keys.some(k => k.includes('core-v7')), { registered: !!reg, controlled: !!W().navigator.serviceWorker.controller, caches: keys, coreFiles: coreN });
    await shot('01-home');
    q('#newVideo').click(); await until(() => q('#video.active'), 10000, 'video screen');
    await shot('01b-empty-editor', 600);
    const V = W().__rrk.V;
    const clip = await file('/ci/media/test-clip.mp4', 'test-clip.mp4', 'video/mp4'), png = await file('/ci/media/test-photo.png', 'test-photo.png', 'image/png');
    // 1) the exact call a real file pick makes (pickFiles -> addMediaFiles), video only
    let t1 = Date.now(); const r1 = await race(V.addMediaFiles([clip]), 30000); const ms1 = Date.now() - t1;
    let P = V.currentProject(); const c0 = P.clips[0];
    await step('import-video-no-hang', !!r1.v || r1.v === 0, { result: r1, ms: ms1, toasts: toasts.slice(-3) });
    await step('import-video-clip', r1.v === 1 && c0?.type === 'video' && Math.abs((c0.srcDur || 0) - 3) < 0.3, { added: r1.v, clips: P.clips.map(c => ({ type: c.type, srcDur: c.srcDur, name: c.name })) });
    let th = null; try { th = c0?.thumb ? await imgStats(c0.thumb) : null; } catch (e) { th = { error: String(e) }; }
    const tlItem = q('#timeline .item.k-clip'); const tlBg = tlItem ? getComputedStyle(tlItem).backgroundImage : null;
    await step('import-video-thumbnail', !!th && th.std > 4 && !!tlItem && /url\(/.test(tlBg || ''), { thumb: th, timelineItem: !!tlItem, timelineBg: (tlBg || '').slice(0, 40) });
    V._test.seek(1.0); V.draw(); await sleep(1500); V.draw(); await sleep(300);
    const pv = q('#preview'); const pvs = pv ? stats(pv, 108, 192) : null;
    await step('preview-frame', !!pvs && pvs.std > 4, { preview: pvs });
    await shot('02-video-imported', 500);

    // Diagnostics for black previews: how must a <video> be primed on iOS before drawImage gets a frame?
    { const db = W().__rrk.db; const id = P.clips[0].mediaId; const url = await db.mediaURL(id); const out = {};
      const mk = (o = {}) => { const v = D().createElement('video'); v.playsInline = true; v.preload = 'auto'; if (o.cors) v.crossOrigin = 'anonymous'; if (o.muted) v.muted = v.defaultMuted = true; v.src = url + (o.frag || ''); return v; };
      const meta = v => race(new Promise((r, j) => { if (v.readyState >= 1) r(); v.addEventListener('loadedmetadata', r, { once: true }); v.addEventListener('error', () => j(new Error('err ' + v.error?.code)), { once: true }); }), 8000);
      const frame = v => { try { return stats(v, 36, 64); } catch (e) { return String(e); } };
      const seekWait = (v, t) => race(new Promise(r => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; }), 4000);
      // A: what the editor does now (videoEl): unmuted, crossOrigin, seek 0.001, wait
      let v = mk({ cors: true }); await meta(v); await seekWait(v, 0.001); await sleep(1500); out.A_editor_seekOnly = { rs: v.readyState, frame: frame(v) };
      // B: same + muted play/pause (what probeVideo does)
      v = mk({ cors: true, muted: true }); await meta(v); out.B_play = await race(v.play().then(() => 'ok'), 4000); v.pause(); await seekWait(v, 1.0); await sleep(300); out.B_mutedPlayPause = { rs: v.readyState, frame: frame(v) };
      // C: B, then unmute afterwards (would let the same element carry sound when the user presses play)
      v.muted = false; await seekWait(v, 1.5); await sleep(300); out.C_unmutedAfterPrime = { rs: v.readyState, frame: frame(v) };
      // D: unmuted play without a gesture (expected to be refused on iOS)
      v = mk({ cors: true }); await meta(v); out.D_unmutedPlay = await race(v.play().then(() => 'ok'), 4000); v.pause();
      // E: media-fragment #t=0.1 (common iOS poster trick)
      v = mk({ frag: '#t=0.1' }); await meta(v); await sleep(2000); out.E_fragment = { rs: v.readyState, frame: frame(v) };
      await step('diag-ios-video-frames', true, out); }

    // 2) mixed batch: video + photo in one pick (the case that used to hang forever)
    t1 = Date.now(); const r2 = await race(V.addMediaFiles([clip, png]), 30000);
    P = V.currentProject();
    await step('import-video+photo-batch', r2.v === 2 && P.clips.length === 3, { result: r2, ms: Date.now() - t1, clips: P.clips.map(c => c.type + ':' + (c.srcDur || c.dur)) });
    await shot('02b-batch-imported');
    btnByText('Text').click(); await sleep(800); const tb = [...D().querySelectorAll('#sheetBody button')].find(b => b.textContent.includes('Title')); tb?.click(); await sleep(800);
    V._test.addSticker('🔥'); V._test.seek(1.5); V.draw(); await sleep(500);
    V._test.select('clip', P.clips[0].id); V._test.split(); await sleep(800);
    const P2 = V.currentProject(); const tx = P2.overlays.find(o => o.kind === 'text'), st = P2.overlays.find(o => o.kind === 'sticker');
    await step('edit', P2.overlays.length >= 2 && P2.clips.length === 4, { overlays: P2.overlays.map(o => o.kind + '@' + o.y.toFixed(2)), clips: P2.clips.length, textStickerApart: !!(tx && st && Math.abs(tx.y - st.y) > 0.05) });
    await shot('03-edited');
    q('#vExport').click(); await sleep(800);
    await step('export-sheet', true, { aacWarningShown: !!q('#aacWarn'), text: (q('#sheetBody')?.textContent || '').slice(0, 200) });
    btnByText('Quick export').click();
    const t0 = Date.now();
    const res = await until(() => W().__lastExport || (D().querySelector('#sheetBody')?.textContent.includes('Export failed') && 'failed'), 300000, 'export');
    await shot('04-export', 2000);
    if (res === 'failed') await step('export', false, { msg: q('#sheetBody').textContent.slice(0, 300) });
    else {
      await step('export', res.blob.size > 10000, { codecs: res.codecs, size: res.blob.size, frames: res.frames, secs: res.secs, ms: Date.now() - t0 });
      await post('/ci/upload?name=export-' + res.codecs.fmt + '.' + res.codecs.fmt, res.blob);
      try { const ac = new (self.AudioContext || self.webkitAudioContext)(); const ab = await ac.decodeAudioData(await res.blob.arrayBuffer());
        const d = ab.getChannelData(0); let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        await step('export-audio', Math.sqrt(s / d.length) > 0.005, { duration: ab.duration, channels: ab.numberOfChannels, rms: Math.sqrt(s / d.length) });
      } catch (e) { await step('export-audio', false, { error: String(e) }); }
      const pvEl = q('#sheetBody video'); let pvInfo = null;
      if (pvEl) { await until(() => pvEl.readyState >= 2 && pvEl.currentTime > 0, 8000, 'preview frame').catch(() => {}); await sleep(400);
        pvInfo = { readyState: pvEl.readyState, currentTime: pvEl.currentTime }; try { pvInfo.frame = stats(pvEl, 72, 128); } catch (e) { pvInfo.frameErr = String(e); } }
      if (pvEl && pvEl.readyState < 2) { const d = {}; pvEl.muted = true; d.play = await race(pvEl.play().then(() => 'ok'), 4000); pvEl.pause(); await sleep(500); d.rs = pvEl.readyState; try { d.frame = stats(pvEl, 72, 128); } catch (e) { d.frame = String(e); } await step('diag-export-preview-after-muted-play', true, d); }
      await step('export-preview-first-frame', !!pvInfo && pvInfo.readyState >= 2 && pvInfo.currentTime > 0 && (pvInfo.frame ? pvInfo.frame.mean > 8 : true), pvInfo);
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(res.blob);
      const meta = await Promise.race([new Promise(r => { v.onloadedmetadata = () => r({ w: v.videoWidth, h: v.videoHeight, dur: v.duration }); v.onerror = () => r({ error: v.error?.code }); }), sleep(15000).then(() => ({ error: 'timeout' }))]);
      await step('export-plays', !meta.error && meta.w > 0, meta);
      await step('export-audio-codec-note', res.codecs.a !== 'opus' || /Opus/.test(q('#sheetBody')?.textContent || ''), { audio: res.codecs.a, opusNoteShown: /sound in this MP4 is Opus/.test(q('#sheetBody')?.textContent || '') });
    }
    const close = btnByText('Close') || btnByText('Cancel'); close?.click(); await sleep(500);
    await W().__rrk.goHome(); await sleep(500);
    q('#newPhoto').click(); await until(() => q('#photo.active'), 10000, 'photo screen');
    await W().__rrk.Ph.addImageLayer(png); await sleep(800); q('#pAddText').click(); await sleep(1200);
    const doc = W().__rrk.Ph.currentDoc();
    await step('photo-edit', doc.layers.length >= 2, { layers: doc.layers.map(l => l.type || l.kind) });
    await shot('05-photo');
    q('#pBack').click(); await until(() => q('#home.active'), 10000, 'home'); await sleep(1500);
    const drafts = D().querySelectorAll('#draftList li').length;
    await post('/ci/offline?on=1');
    W().location.reload(); await sleep(1500); await ready(30000);
    const r404 = await W().fetch('README.md?x=' + Date.now()).then(r => r.status).catch(e => 'neterr');
    const d2 = D().querySelectorAll('#draftList li').length;
    await step('offline', !!q('#home.active') && d2 === drafts && d2 >= 2, { draftsBefore: drafts, draftsOffline: d2, uncachedFetchStatus: r404 });
    await shot('06-offline-home');
    q('#draftList li button.small')?.click(); await sleep(3000); await shot('07-offline-open-draft');
    await post('/ci/offline?on=0');
  } catch (e) { await step('harness-error', false, { error: String(e && e.stack || e) }); await shot('99-error'); }
  const benign = /interactive-widget/;
  await step('console', errors.filter(e => !benign.test(e)).length === 0, { errors: errors.slice(0, 40) });
  await post('/ci/upload?name=console.json', JSON.stringify({ console: consoleLog, toasts }, null, 1));
  await post('/ci/done');
})();
