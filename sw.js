// Offline support. Core files are saved on install; big AI packs are saved on first use
// or from Settings → "Download caption + cutout packs". Nothing is ever fetched from another site.
// Responses get COOP/COEP headers so the phone can use several CPU threads for captions.
// APP must be unique per app: every GitHub Pages site on one account shares the origin
// <user>.github.io, so caches are shared too. Only ever touch caches that start with APP + '::'.
// Bump the core version on every release. Keep PACKS in sync with PACKS_CACHE in js/main.js.
const APP = 'ryans-reel-kit';
const CACHE = APP + '::core-v7', PACKS = APP + '::packs-v1';
// Exact names this app used before it had a prefix (never hosted, local builds only).
const LEGACY = ['reelkit-v1', 'reelkit-v2', 'reelkit-v3', 'reelkit-v4', 'reelkit-packs-v1'];
const CORE = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'js/main.js', 'js/db.js', 'js/util.js', 'js/video.js', 'js/photo.js', 'js/heal.js', 'js/compositor.js', 'js/audio.js', 'js/exporter.js', 'js/ml.js', 'js/ml-worker.js', 'js/styles.js', 'js/stickers.js', 'js/credits.js',
  'vendor/konva.min.js', 'vendor/mediabunny.min.mjs', 'vendor/fflate.mjs', 'vendor/fonts/fonts.css',
  ...['inter-latin-400-normal', 'inter-latin-700-normal', 'anton-latin-400-normal', 'bebas-neue-latin-400-normal', 'poppins-latin-600-normal', 'poppins-latin-800-normal', 'montserrat-latin-800-normal', 'permanent-marker-latin-400-normal'].map(f => `vendor/fonts/${f}.woff2`),
  ...['forward-momentum', 'sunlit-groove', 'quick-spark', 'mini-glow', 'splash-splash'].map(f => `media/music/${f}.mp3`),
  ...['click_002', 'pluck_001', 'bong_001', 'confirmation_001', 'drop_002', 'glass_001', 'maximize_006', 'switch_002', 'scratch_002', 'impactBell_heavy_000', 'impactGeneric_light_002', 'impactPunch_medium_000', 'footstep_concrete_001'].map(f => `media/sfx/${f}.ogg`)];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if ((k.startsWith(APP + '::') && k !== CACHE && k !== PACKS) || LEGACY.includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers); h.set('Cross-Origin-Opener-Policy', 'same-origin'); h.set('Cross-Origin-Embedder-Policy', 'require-corp'); h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
const isPack = (p) => p.includes('/models/') || p.includes('/vendor/ort/') || p.includes('/vendor/mediapipe/') || p.endsWith('/vendor/transformers.min.js');
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) { e.respondWith(new Response('', { status: 204 })); return; } // the app never needs other sites
  e.respondWith((async () => {
    const key = e.request.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : url.href.split('#')[0];
    const hit = (await (await caches.open(CACHE)).match(key, { ignoreSearch: true })) || (await (await caches.open(PACKS)).match(key, { ignoreSearch: true })); // only our caches
    if (hit) return isolate(hit);
    try {
      const res = await fetch(e.request);
      if (res.ok && res.status === 200) { const c = await caches.open(isPack(url.pathname) ? PACKS : CACHE); c.put(key, res.clone()); }
      return isolate(res);
    } catch (err) { return new Response('Offline and not saved yet', { status: 503, headers: { 'Content-Type': 'text/plain' } }); }
  })());
});
