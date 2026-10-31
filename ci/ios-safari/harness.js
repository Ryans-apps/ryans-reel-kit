// Drives the real app (served from main) inside a same-origin iframe in Mobile Safari, and reports to server.py.
const f = document.getElementById('f'), bar = document.getElementById('bar');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (path, body) => fetch(path, { method: 'POST', body }).catch(() => {});
const errors = [];
async function step(name, ok, detail) { bar.textContent = (ok ? '✓ ' : '✗ ') + name + ' ' + (detail ? JSON.stringify(detail).slice(0, 120) : ''); await post('/ci/log', JSON.stringify({ step: name, ok, detail })); }
const shot = async (name) => { await sleep(1200); await post('/ci/shot?name=' + name); };
const W = () => f.contentWindow, D = () => f.contentWindow.document;
async function until(fn, ms, label) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } throw new Error('timeout: ' + label); }
function hook() { const w = W(); if (w.__ciHooked) return; w.__ciHooked = true;
  w.addEventListener('error', e => errors.push('error: ' + (e.message || e.target?.src || e.type)), true);
  w.addEventListener('unhandledrejection', e => errors.push('rejection: ' + (e.reason?.message || e.reason)));
  for (const k of ['error', 'warn']) { const o = w.console[k].bind(w.console); w.console[k] = (...a) => { errors.push(k + ': ' + a.map(x => x?.message || String(x)).join(' ')); o(...a); }; } }
async function ready(ms = 60000) { await until(() => { hook(); return D().body?.dataset.ready === '1' && W().__rrk; }, ms, 'app ready'); }
const q = s => D().querySelector(s);
const btnByText = (t) => [...D().querySelectorAll('button')].find(b => b.textContent.includes(t));
async function file(path, name, type) { const b = await (await fetch(path)).blob(); return new File([b], name, { type }); }
(async () => {
  try {
    await step('ua', true, { ua: navigator.userAgent, VideoEncoder: 'VideoEncoder' in self, AudioEncoder: 'AudioEncoder' in self, VideoDecoder: 'VideoDecoder' in self });
    f.src = '/ryans-reel-kit/';
    await ready(); await step('load', true, { title: D().title, home: !!q('#home.active') });
    const reg = await Promise.race([W().navigator.serviceWorker.ready, sleep(30000).then(() => null)]);
    await sleep(3000); await ready(); // the app may reload itself once when the worker takes over
    await until(() => W().navigator.serviceWorker.controller, 20000, 'sw controller').catch(() => {});
    const keys = await W().caches.keys(); let core = 0; for (const k of keys) if (k.includes('core')) core = (await (await W().caches.open(k)).keys()).length;
    await step('service-worker', !!(reg && W().navigator.serviceWorker.controller), { registered: !!reg, controlled: !!W().navigator.serviceWorker.controller, caches: keys, coreFiles: core, isolated: W().crossOriginIsolated });
    await shot('01-home');
    q('#newVideo').click(); await until(() => q('#video.active'), 10000, 'video screen');
    const V = W().__rrk.V; const clip = await file('/ci/media/test-clip.mp4', 'test-clip.mp4', 'video/mp4'), png = await file('/ci/media/test-photo.png', 'test-photo.png', 'image/png');
    const n = await V.addMediaFiles([clip, png]); const P = V.currentProject();
    await step('import', n === 2 && P.clips.length === 2, { added: n, clips: P.clips.map(c => c.type + ':' + (c.srcDur || c.dur)) });
    await shot('02-video-imported');
    btnByText('Text').click(); await sleep(800); const tb = [...D().querySelectorAll('#sheetBody button')].find(b => b.textContent.includes('Title')); tb?.click(); await sleep(800);
    V._test.addSticker('🔥'); V._test.seek(1.5); V.draw(); await sleep(500);
    V._test.select('clip', P.clips[0].id); V._test.split(); await sleep(800);
    const P2 = V.currentProject();
    await step('edit', P2.overlays.length >= 2 && P2.clips.length === 3, { overlays: P2.overlays.map(o => o.kind), clips: P2.clips.length });
    await shot('03-edited');
    q('#vExport').click(); await sleep(800); btnByText('Quick export').click();
    const t0 = Date.now();
    const res = await until(() => W().__lastExport || (D().querySelector('#sheetBody')?.textContent.includes('Export failed') && 'failed'), 300000, 'export');
    await shot('04-export');
    if (res === 'failed') await step('export', false, { msg: q('#sheetBody').textContent.slice(0, 300) });
    else {
      await step('export', res.blob.size > 10000, { codecs: res.codecs, size: res.blob.size, frames: res.frames, secs: res.secs, ms: Date.now() - t0 });
      await post('/ci/upload?name=export-' + res.codecs.fmt + '.' + res.codecs.fmt, res.blob);
      try { const ac = new (self.AudioContext || self.webkitAudioContext)(); const ab = await ac.decodeAudioData(await res.blob.arrayBuffer());
        const d = ab.getChannelData(0); let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
        await step('export-audio', Math.sqrt(s / d.length) > 0.005, { duration: ab.duration, channels: ab.numberOfChannels, rms: Math.sqrt(s / d.length) });
      } catch (e) { await step('export-audio', false, { error: String(e) }); }
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(res.blob);
      const meta = await Promise.race([new Promise(r => { v.onloadedmetadata = () => r({ w: v.videoWidth, h: v.videoHeight, dur: v.duration }); v.onerror = () => r({ error: v.error?.code }); }), sleep(15000).then(() => ({ error: 'timeout' }))]);
      await step('export-plays', !meta.error && meta.w > 0, meta);
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
  await step('console', errors.length === 0, { errors: errors.slice(0, 40) });
  await post('/ci/done');
})();
