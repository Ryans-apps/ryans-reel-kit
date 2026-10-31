// Export: draws every frame with the shared compositor and encodes with WebCodecs via Mediabunny.
import { Input, BlobSource, ALL_FORMATS, CanvasSink, Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource, AudioBufferSource, canEncodeVideo, canEncodeAudio } from '../vendor/mediabunny.min.mjs';
import { mediaBlob } from './db.js';
import { drawFrame, ensureFonts, layout, projectDuration, clipDur, touching } from './compositor.js';
import { mix } from './audio.js';
import { loadImage, canvas } from './util.js';
import { mediaURL } from './db.js';

export const PRESETS = {
  social: { label: 'Vertical 9:16 (1080×1920, 30 fps)', w: 1080, h: 1920, fps: 30, vbr: 10_000_000 },
  fast: { label: 'Quick share (720×1280, 30 fps)', w: 720, h: 1280, fps: 30, vbr: 5_000_000 },
};

export async function pickCodecs(w, h, bitrate) {
  if (await canEncodeVideo('avc', { width: w, height: h, bitrate })) {
    return { fmt: 'mp4', v: 'avc', a: (await canEncodeAudio('aac')) ? 'aac' : 'opus' };
  }
  if (await canEncodeVideo('vp9', { width: w, height: h, bitrate })) return { fmt: 'webm', v: 'vp9', a: 'opus' };
  return null;
}

async function openVideo(mediaId, maxDim) {
  const input = new Input({ source: new BlobSource(await mediaBlob(mediaId)), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) throw new Error('This phone cannot decode one of the videos.');
  const dw = track.displayWidth, dh = track.displayHeight, s = Math.min(1, maxDim / Math.max(dw, dh));
  const sink = new CanvasSink(track, { width: Math.round(dw * s / 2) * 2, height: Math.round(dh * s / 2) * 2, fit: 'fill' });
  const first = await track.getFirstTimestamp();
  return { input, sink, first };
}

export async function exportProject(project, presetKey = 'social', onProgress = () => {}, signal) {
  const P = PRESETS[presetKey], { w: W, h: H, fps } = P;
  const codecs = await pickCodecs(W, H, P.vbr); if (!codecs) throw new Error('Video encoding is not available in this browser.');
  const dur = projectDuration(project); if (dur <= 0) throw new Error('Add a clip first.');
  const N = Math.max(1, Math.round(dur * fps));
  onProgress(0, 'Mixing sound…');
  const audio = await mix(project, { rate: 48000, channels: 2, duration: N / fps });
  const cv = canvas(W, H), ctx = cv.getContext('2d', { alpha: false });
  const target = new BufferTarget();
  const output = new Output({ format: codecs.fmt === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target });
  const vsrc = new CanvasSource(cv, { codec: codecs.v, bitrate: P.vbr, keyFrameInterval: 2, latencyMode: 'quality' });
  const asrc = new AudioBufferSource({ codec: codecs.a, bitrate: 192_000 });
  output.addVideoTrack(vsrc, { frameRate: fps }); output.addAudioTrack(asrc);
  await output.start();
  await asrc.add(audio); asrc.close();

  await ensureFonts(project);
  const L = layout(project), images = new Map();
  const getImage = async (id) => { if (!images.has(id)) images.set(id, await loadImage(await mediaURL(id))); return images.get(id); };
  for (const { clip } of L) if (clip.type === 'image') await getImage(clip.mediaId);
  for (const o of project.overlays) if ((o.kind === 'image') && o.mediaId) await getImage(o.mediaId);

  // Lazy frame iterators: one per main video clip and per video overlay.
  const iters = new Map();
  const startIter = async (key, mediaId, times) => { const v = await openVideo(mediaId, Math.max(W, H)); const it = v.sink.canvasesAtTimestamps(times.map(t => t + v.first)); iters.set(key, { it, v }); };
  const nextFrame = async (key) => { const r = await iters.get(key).it.next(); return r.value?.canvas || null; };
  const stopIter = async (key) => { const x = iters.get(key); if (x) { await x.it.return?.(); x.v.input.dispose?.(); iters.delete(key); } };

  let curIdx = -1, lastMain = null, prev = null;
  const ovLast = new Map();
  try {
    for (let n = 0; n < N; n++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const t = n / fps;
      const idx = L.findIndex(x => t >= x.start - 1e-6 && t < x.end); // -1 in a gap (black, overlays still drawn)
      const seg = idx >= 0 ? L[idx] : null;
      if (idx !== curIdx) {
        // freeze the last frame of the previous clip for a transition, only if the two clips touch
        prev = seg && curIdx >= 0 && lastMain && touching(L[curIdx].clip, seg.clip) ? { clip: L[curIdx].clip, drawable: snapshot(lastMain) } : null;
        await stopIter('main');
        curIdx = idx;
        if (seg && seg.clip.type === 'video') {
          const times = []; for (let m = n; m < N && (m / fps) < seg.end; m++) times.push(seg.clip.in + (m / fps - seg.start) * seg.clip.speed);
          await startIter('main', seg.clip.mediaId, times);
        }
      }
      let drawable;
      if (!seg) drawable = null;
      else if (seg.clip.type === 'video') { drawable = (await nextFrame('main')) || lastMain; }
      else drawable = images.get(seg.clip.mediaId);
      lastMain = drawable;
      const ovFrames = new Map();
      for (const o of project.overlays) {
        const active = t >= o.start && t < o.start + o.dur;
        if (o.kind === 'image' && o.mediaId) ovFrames.set(o.id, images.get(o.mediaId));
        if (o.kind === 'video' && o.mediaId) {
          if (active) {
            if (!iters.has(o.id)) { const times = []; for (let m = n; m < N && m / fps < o.start + o.dur; m++) times.push((o.in || 0) + (m / fps - o.start)); await startIter(o.id, o.mediaId, times); }
            const f = (await nextFrame(o.id)) || ovLast.get(o.id); ovLast.set(o.id, f); ovFrames.set(o.id, f);
          } else if (iters.has(o.id)) await stopIter(o.id);
        }
      }
      drawFrame(ctx, project, t, { main: seg ? { clip: seg.clip, drawable, local: t - seg.start } : null, prev, overlays: ovFrames });
      await vsrc.add(t, 1 / fps);
      if (n % 5 === 0) onProgress((n + 1) / N, `Frame ${n + 1} of ${N}`);
    }
    vsrc.close();
    onProgress(1, 'Finishing…');
    await output.finalize();
  } catch (e) { for (const k of [...iters.keys()]) await stopIter(k); try { await output.cancel(); } catch {} throw e; }
  for (const k of [...iters.keys()]) await stopIter(k);
  const type = codecs.fmt === 'mp4' ? 'video/mp4' : 'video/webm';
  return { blob: new Blob([target.buffer], { type }), codecs, frames: N, duration: N / fps };
}
function snapshot(src) { // copy a pooled canvas so it survives reuse
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight; const c = canvas(w, h); c.getContext('2d').drawImage(src, 0, 0); return c;
}
