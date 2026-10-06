import { pipeline, env } from '@huggingface/transformers';
let asr = null, loadedKey = null, stopRequested = false;
const SR = 16000;

async function gpuInfo() {
  try {
    if (!('gpu' in navigator)) return { ok: false };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { ok: false };
    return { ok: true, f16: a.features.has('shader-f16') };
  } catch (e) { return { ok: false }; }
}

async function load(model) {
  env.allowLocalModels = false;
  const gpu = await gpuInfo();
  const device = gpu.ok ? 'webgpu' : 'wasm';
  const key = model + '|' + device;
  if (asr && loadedKey === key) return device;
  if (asr && asr.dispose) { try { await asr.dispose(); } catch (e) {} }
  asr = null;
  const big = /large/.test(model);
  const dtype = device === 'webgpu'
    ? { encoder_model: gpu.f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' }
    : { encoder_model: big ? 'q8' : 'fp32', decoder_model_merged: 'q8' };
  const progress_callback = (p) => {
    if (p.status === 'progress_total') postMessage({ type: 'load', progress: p.progress, loaded: p.loaded, total: p.total });
  };
  try {
    asr = await pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    postMessage({ type: 'note', text: 'The graphics card could not load this model, so Akosile is using the processor instead.' });
    asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: { encoder_model: big ? 'q8' : 'fp32', decoder_model_merged: 'q8' }, progress_callback });
    loadedKey = model + '|wasm';
    return 'wasm';
  }
  loadedKey = key;
  return device;
}

// Split audio into windows of at most 30 seconds, cutting at the quietest moment between 20 and 29.5 seconds.
function plan(audio) {
  const F = 800; // 50 ms frames
  const n = Math.floor(audio.length / F);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * F; j < (i + 1) * F; j++) s += audio[j] * audio[j]; rms[i] = Math.sqrt(s / F); }
  const out = []; let s = 0; const N = audio.length;
  while (s < N) {
    if (N - s <= 30 * SR) { out.push([s, N]); break; }
    const lo = Math.floor((s + 20 * SR) / F), hi = Math.min(n, Math.floor((s + 29.5 * SR) / F));
    let best = lo; for (let i = lo; i < hi; i++) if (rms[i] < rms[best]) best = i;
    const cut = best * F + F / 2; out.push([s, cut]); s = cut;
  }
  return { windows: out, rms, F };
}

const FILLER = /^\s*(thank you\.?|thanks for watching!?|you|\.+|subtitles by .*)\s*$/i;

async function transcribe(audio, opts) {
  const { windows, rms, F } = plan(audio);
  postMessage({ type: 'plan', total: windows.length });
  let lastText = '', repeats = 0;
  for (let w = 0; w < windows.length; w++) {
    if (stopRequested) { postMessage({ type: 'stopped', done: w }); return; }
    const [a, b] = windows[w];
    let peak = 0, mean = 0, cnt = 0;
    for (let i = Math.floor(a / F); i < Math.floor(b / F); i++) { peak = Math.max(peak, rms[i] || 0); mean += rms[i] || 0; cnt++; }
    mean = cnt ? mean / cnt : 0;
    const items = [];
    if (peak > 0.004) {
      const gen = { return_timestamps: true, task: opts.task };
      if (opts.language) gen.language = opts.language;
      const res = await asr(audio.slice(a, b), gen);
      const off = a / SR, dur = (b - a) / SR;
      for (const c of (res.chunks || [{ timestamp: [0, dur], text: res.text }])) {
        const text = (c.text || '').trim();
        if (!text) continue;
        if (mean < 0.012 && FILLER.test(text)) continue;
        if (text === lastText) { if (++repeats >= 2) continue; } else { repeats = 0; lastText = text; }
        const st = c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0;
        const en = c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : dur;
        items.push({ start: +(off + Math.min(st, dur)).toFixed(2), end: +(off + Math.min(Math.max(en, st), dur)).toFixed(2), text });
      }
    }
    postMessage({ type: 'segments', items, done: w + 1, total: windows.length, audioDone: b / SR });
  }
  postMessage({ type: 'complete' });
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'probe') { const g = await gpuInfo(); postMessage({ type: 'probe', gpu: g.ok }); return; }
  if (m.type === 'stop') { stopRequested = true; return; }
  if (m.type === 'run') {
    stopRequested = false;
    try {
      postMessage({ type: 'status', text: 'Loading the Whisper model' });
      const device = await load(m.model);
      postMessage({ type: 'ready', device });
      await transcribe(m.audio, m.opts);
    } catch (err) {
      postMessage({ type: 'error', text: String(err && err.message || err) });
    }
  }
};
