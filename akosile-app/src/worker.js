import { pipeline, env } from '@huggingface/transformers';
let asr = null, loadedKey = null, loadedModel = null, loadedDevice = null, stopRequested = false;
const SR = 16000;

async function gpuInfo() {
  try {
    if (!('gpu' in navigator)) return { ok: false };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { ok: false };
    return { ok: true, f16: a.features.has('shader-f16') };
  } catch (e) { return { ok: false }; }
}

// Reports which models are already saved in this browser's model cache.
async function savedModels() {
  try {
    if (typeof caches === 'undefined') return { available: false, models: [] };
    const c = await caches.open('transformers-cache');
    const keys = await c.keys();
    const models = new Set();
    for (const r of keys) { const m = /huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/onnx\//.exec(r.url); if (m) models.add(m[1]); }
    return { available: true, models: [...models] };
  } catch (e) { return { available: false, models: [] }; }
}

const progress_callback = (p) => {
  if (p.status === 'progress_total') postMessage({ type: 'load', progress: p.progress, loaded: p.loaded, total: p.total });
};

async function loadOn(model, device, gpu) {
  const key = model + '|' + device;
  if (asr && loadedKey === key) return device;
  if (asr && asr.dispose) { try { await asr.dispose(); } catch (e) {} }
  asr = null;
  const big = /large/.test(model);
  const dtype = device === 'webgpu'
    ? { encoder_model: gpu && gpu.f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' }
    : { encoder_model: big ? 'q8' : 'fp32', decoder_model_merged: 'q8' };
  asr = await pipeline('automatic-speech-recognition', model, { device, dtype, progress_callback });
  loadedKey = key; loadedModel = model; loadedDevice = device;
  return device;
}

async function load(model) {
  env.allowLocalModels = false;
  const gpu = await gpuInfo();
  if (!gpu.ok) return loadOn(model, 'wasm');
  try { return await loadOn(model, 'webgpu', gpu); }
  catch (err) {
    postMessage({ type: 'note', text: 'The graphics card could not load this model, so Akosile is using the processor instead.' });
    return loadOn(model, 'wasm');
  }
}

// Measure loudness in 50 ms frames, used to find pauses and true silence.
function frames(audio) {
  const F = 800, n = Math.floor(audio.length / F);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * F; j < (i + 1) * F; j++) s += audio[j] * audio[j]; rms[i] = Math.sqrt(s / F); }
  return { rms, F };
}

// Bring each section up to a consistent speaking level, so a quiet speaker later in the
// recording is as clear to Whisper as a loud speaker at the start.
function levelled(chunk, rms, F, a, b) {
  const vals = []; for (let i = Math.floor(a / F); i < Math.floor(b / F); i++) vals.push(rms[i] || 0);
  vals.sort((x, y) => x - y);
  const loud = vals[Math.floor(vals.length * 0.95)] || 0;
  let peak = 0; for (let i = 0; i < chunk.length; i++) { const v = Math.abs(chunk[i]); if (v > peak) peak = v; }
  if (!loud || !peak) return chunk;
  const gain = Math.min(0.1 / loud, 0.99 / peak, 200);
  if (gain > 1.05) for (let i = 0; i < chunk.length; i++) chunk[i] *= gain;
  return chunk;
}

// Split audio into windows of at most 30 seconds, cutting at the quietest moment between 20 and 29.5 seconds.
function plan(audio, rms, F, startSample) {
  const n = rms.length;
  const out = []; let s = startSample; const N = audio.length;
  while (s < N) {
    if (N - s <= 30 * SR) { out.push([s, N]); break; }
    const lo = Math.floor((s + 20 * SR) / F), hi = Math.min(n, Math.floor((s + 29.5 * SR) / F));
    let best = lo; for (let i = lo; i < hi; i++) if (rms[i] < rms[best]) best = i;
    const cut = best * F + F / 2; out.push([s, cut]); s = cut;
  }
  return out;
}

const FILLER = /^\s*(thank you\.?|thanks for watching!?|you|\.+|subtitles by .*)\s*$/i;

async function runWindow(chunk, gen, model) {
  try { return await asr(chunk, gen); }
  catch (err) {
    // A graphics card error usually affects every later section too, so switch to the processor and try once more.
    if (loadedDevice === 'webgpu') {
      postMessage({ type: 'note', text: 'The graphics card hit an error, so Akosile switched to the processor and is carrying on.' });
      await loadOn(model, 'wasm');
      return await asr(chunk, gen);
    }
    throw err;
  }
}

async function transcribe(audio, opts, model) {
  const { rms, F } = frames(audio);
  const startSample = Math.max(0, Math.floor((opts.startAt || 0) * SR));
  const windows = plan(audio, rms, F, startSample);
  postMessage({ type: 'plan', total: windows.length });
  let lastText = '', repeats = 0, silent = 0, failed = 0, failStreak = 0;
  for (let w = 0; w < windows.length; w++) {
    const [a, b] = windows[w];
    if (stopRequested) { postMessage({ type: 'stopped', done: w, resumeAt: a / SR, silent, failed }); return; }
    let peak = 0, mean = 0, cnt = 0;
    for (let i = Math.floor(a / F); i < Math.floor(b / F); i++) { peak = Math.max(peak, rms[i] || 0); mean += rms[i] || 0; cnt++; }
    mean = cnt ? mean / cnt : 0;
    const items = [];
    // Only near digital silence (below about -70 dB) is skipped. Quiet speech is levelled up and transcribed.
    if (peak < 0.0003) { silent++; }
    else {
      const gen = { return_timestamps: true, task: opts.task };
      if (opts.language) gen.language = opts.language;
      let res = null;
      try { res = await runWindow(levelled(audio.slice(a, b), rms, F, a, b), gen, model); failStreak = 0; }
      catch (err) {
        failed++; failStreak++;
        postMessage({ type: 'note', text: `Akosile could not transcribe the section at ${Math.floor(a / SR / 60)} min and moved on.` });
        if (failStreak >= 3) { postMessage({ type: 'error', text: String(err && err.message || err), resumeAt: a / SR }); return; }
      }
      if (res) {
        const off = a / SR, dur = (b - a) / SR;
        for (const c of (res.chunks || [{ timestamp: [0, dur], text: res.text }])) {
          const text = (c.text || '').trim();
          if (!text) continue;
          if (mean < peak * 0.15 && FILLER.test(text)) continue; // A section that is mostly pause often makes Whisper invent a lone "Thank you".
          if (text === lastText) { if (++repeats >= 2) continue; } else { repeats = 0; lastText = text; }
          const st = c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0;
          const en = c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : dur;
          items.push({ start: +(off + Math.min(st, dur)).toFixed(2), end: +(off + Math.min(Math.max(en, st), dur)).toFixed(2), text });
        }
      }
    }
    postMessage({ type: 'segments', items, done: w + 1, total: windows.length, audioDone: b / SR });
  }
  postMessage({ type: 'complete', total: windows.length, silent, failed });
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'probe') { const g = await gpuInfo(); postMessage({ type: 'probe', gpu: g.ok, saved: await savedModels() }); return; }
  if (m.type === 'saved') { postMessage({ type: 'saved', saved: await savedModels() }); return; }
  if (m.type === 'stop') { stopRequested = true; return; }
  if (m.type === 'run') {
    stopRequested = false;
    try {
      const saved = await savedModels();
      postMessage({ type: 'loading', cached: saved.models.includes(m.model) });
      const device = await load(m.model);
      postMessage({ type: 'ready', device });
      postMessage({ type: 'saved', saved: await savedModels() });
      await transcribe(m.audio, m.opts, m.model);
    } catch (err) {
      postMessage({ type: 'error', text: String(err && err.message || err) });
    }
  }
};
