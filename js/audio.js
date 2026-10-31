// Audio decoding + offline mixing (used for export and for captions).
import { mediaBlob } from './db.js';
import { layout, projectDuration } from './compositor.js';
const cache = new Map();
export async function decode(mediaId) {
  if (cache.has(mediaId)) return cache.get(mediaId);
  const p = (async () => {
    const b = await mediaBlob(mediaId); if (!b) return null;
    try { return await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await b.arrayBuffer()); }
    catch { return null; } // video with no audio track, or unsupported codec
  })();
  cache.set(mediaId, p); return p;
}
export const forget = (id) => cache.delete(id);

// Render the project's sound to one AudioBuffer.
// opts.speechOnly: only clip sound + voiceover (for captions). opts.rate / opts.channels.
export async function mix(project, { rate = 48000, channels = 2, speechOnly = false, duration } = {}) {
  const dur = Math.max(0.1, duration ?? projectDuration(project));
  const ctx = new OfflineAudioContext(channels, Math.ceil(dur * rate), rate);
  const sched = async (mediaId, when, offset, len, speed = 1, vol = 1, fadeOut = 0) => {
    const buf = await decode(mediaId); if (!buf || len <= 0) return;
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = speed;
    const g = ctx.createGain(); g.gain.value = vol; src.connect(g).connect(ctx.destination);
    const end = when + len / speed;
    if (fadeOut > 0 && end - fadeOut > when) { g.gain.setValueAtTime(vol, end - fadeOut); g.gain.linearRampToValueAtTime(0, end); }
    src.start(when, Math.max(0, offset), len);
  };
  for (const { clip, start } of layout(project)) {
    if (clip.type !== 'video' || clip.muted) continue;
    await sched(clip.mediaId, start, clip.in, clip.out - clip.in, clip.speed, clip.volume ?? 1);
  }
  for (const o of project.overlays) if (o.kind === 'video' && !o.muted && o.mediaId) await sched(o.mediaId, o.start, o.in || 0, o.dur, 1, o.volume ?? 1);
  for (const a of project.audio) {
    if (speechOnly && a.kind !== 'voice') continue;
    const len = Math.min(a.dur, dur - a.start); if (len <= 0) continue;
    await sched(a.mediaId, a.start, a.in || 0, len, 1, a.volume ?? 1, a.kind === 'music' ? (a.fadeOut ?? 1.5) : 0);
  }
  return ctx.startRendering();
}
