// On-device AI worker: captions (Whisper with word timings) and fine cut-outs (MODNet).
// Every file is loaded from this app's own folder; nothing is fetched from the internet.
import { env, pipeline, AutoModel, AutoProcessor, RawImage } from '../vendor/transformers.min.js';
const base = new URL('../', import.meta.url).href;
env.allowRemoteModels = false; env.allowLocalModels = true; // A path (not a full http URL): transformers.js only checks local files for paths, so this keeps it fully offline.
env.localModelPath = new URL('models/', base).pathname;
env.useBrowserCache = false; env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = { mjs: base + 'vendor/ort/ort-wasm-simd-threaded.asyncify.mjs', wasm: base + 'vendor/ort/ort-wasm-simd-threaded.asyncify.wasm' };
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

const asr = new Map(); let modnet = null;
const progress = (id) => (p) => { if (p.status === 'progress' && p.file?.endsWith('.onnx')) postMessage({ id, type: 'progress', stage: 'Loading model', value: (p.progress || 0) / 100 }); };

self.onmessage = async ({ data }) => {
  const { id, cmd } = data;
  try {
    if (cmd === 'asr') {
      const model = data.model || 'whisper-tiny.en_timestamped';
      if (!asr.has(model)) asr.set(model, pipeline('automatic-speech-recognition', model, { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, device: 'wasm', progress_callback: progress(id) }));
      const p = await asr.get(model);
      postMessage({ id, type: 'progress', stage: 'Listening', value: 0 });
      const t0 = performance.now();
      const out = await p(data.audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
      postMessage({ id, type: 'done', result: { text: out.text, chunks: out.chunks, ms: performance.now() - t0, threads: env.backends.onnx.wasm.numThreads } });
    } else if (cmd === 'matte') {
      if (!modnet) modnet = Promise.all([AutoModel.from_pretrained('modnet', { dtype: 'q8', device: 'wasm', progress_callback: progress(id) }), AutoProcessor.from_pretrained('modnet')]);
      const [model, processor] = await modnet;
      const img = new RawImage(new Uint8ClampedArray(data.rgba), data.width, data.height, 4);
      const { pixel_values } = await processor(img);
      const { output } = await model({ input: pixel_values });
      const mask = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(data.width, data.height);
      postMessage({ id, type: 'done', result: { alpha: mask.data, width: mask.width, height: mask.height } }, [mask.data.buffer]);
    }
  } catch (e) { postMessage({ id, type: 'error', error: String(e?.message || e) }); }
};
