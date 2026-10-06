import './style.css';

(() => {
  const $ = (id) => document.getElementById(id);
  const SR = 16000;
  const store = {
    get(k, d) { try { const v = localStorage.getItem('akosile.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('akosile.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- state ----------
  const EXAMPLE = {
    id: 'example', name: 'Planning call sample', example: true, context: 'Weekly planning call',
    segments: [
      { start: 0.0, end: 6.4, text: "Good morning everyone. Let's start with the pipeline review for the Lagos cohort." },
      { start: 6.4, end: 14.9, text: 'We screened forty two applications last week, and eleven of them passed the first financial check.' },
      { start: 14.9, end: 22.1, text: 'Tunde, can you send the shortlist to the credit team by Thursday?' },
      { start: 22.1, end: 27.6, text: 'Yes, I will send it on Thursday morning, latest by noon.' },
      { start: 27.6, end: 36.3, text: 'Good. The other thing is the site visits in Ikeja. We still need a driver for the second week.' },
      { start: 36.3, end: 43.8, text: 'I can ask the logistics vendor, but I am not sure they have availability before the twentieth.' },
      { start: 43.8, end: 49.0, text: "Okay, let's decide that on Friday once we hear back." }
    ],
    summary: "### Summary\nThe team reviewed the Lagos cohort pipeline and planned the shortlist handover and the Ikeja site visits.\n\n### Action items\n- Tunde will send the shortlist to the credit team by Thursday noon `[00:14]`.\n- Someone on the team will ask the logistics vendor about a driver for week two `[00:36]`.\n\n### Decisions\n- The team will decide on the driver on Friday `[00:43]`.\n\n### Open questions\n- The team does not yet know if the vendor has availability before the twentieth."
  };

  let doc = structuredClone(EXAMPLE);
  let resumeAt = null, audioData = null, fileName = '', audioUrl = null, running = false, worker = null, runStart = 0;

  // ---------- helpers ----------
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  function clock(sec, withHours) {
    sec = Math.max(0, sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    return (h || withHours ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
  }
  function stamp(sec, sepMs) {
    const ms = Math.round(sec * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
    return pad(h) + ':' + pad(m) + ':' + pad(s) + sepMs + pad(ms % 1000, 3);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2200); }
  function setMsg(t, err) { $('msg').textContent = t; $('msg').classList.toggle('err', !!err); }
  function setBar(p) { $('barFill').style.width = Math.max(0, Math.min(100, p)) + '%'; }
  const hasHours = () => doc.segments.some((s) => s.end >= 3600);

  // ---------- vocabulary corrections ----------
  function parseVocab(text) {
    return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.split(/\s*(?:=>|->)\s*/);
      if (m.length >= 2 && m[0] && m[1]) return { from: m[0], to: m[1] };
      return { from: l, to: l };
    });
  }
  function applyVocab(text, rules) {
    for (const r of rules) {
      const pattern = r.from.split(/\s+/).map(reEsc).join('[\\s-]*');
      text = text.replace(new RegExp('(^|[^\\p{L}\\p{N}])(' + pattern + ')(?=$|[^\\p{L}\\p{N}])', 'giu'), (_, pre) => pre + r.to);
    }
    return text;
  }
  const rules = () => parseVocab($('vocab').value);

  // ---------- render ----------
  function renderTranscript() {
    const box = $('transcript');
    $('docTitle').textContent = doc.name;
    $('examplePill').hidden = !doc.example;
    if (!doc.segments.length) { box.innerHTML = '<p class="empty">Words will appear here as each section finishes.</p>'; return; }
    const H = hasHours();
    box.innerHTML = doc.segments.map((s, i) =>
      `<div class="seg" data-i="${i}"><button class="t" type="button" title="Play from here">${clock(s.start, H)}</button><div class="x" contenteditable="plaintext-only" spellcheck="true">${esc(s.text)}</div></div>`
    ).join('');
  }
  function appendSegments(items) {
    const box = $('transcript');
    if (!doc.segments.length) box.innerHTML = '';
    const H = hasHours();
    for (const s of items) {
      const i = doc.segments.push(s) - 1;
      box.insertAdjacentHTML('beforeend', `<div class="seg" data-i="${i}"><button class="t" type="button" title="Play from here">${clock(s.start, H)}</button><div class="x" contenteditable="plaintext-only" spellcheck="true">${esc(s.text)}</div></div>`);
    }
    if (!$('player').paused) return;
    box.scrollTop = box.scrollHeight;
  }
  function mdToHtml(md) {
    const lines = String(md).replace(/\r/g, '').split('\n'); let html = '', inList = false;
    const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    for (const raw of lines) {
      const l = raw.trim();
      const li = /^[-*]\s+(.*)/.exec(l);
      if (li) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(li[1]) + '</li>'; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      const h = /^#{1,4}\s+(.*)/.exec(l);
      if (h) html += '<h3>' + inline(h[1]) + '</h3>';
      else if (l) html += '<p>' + inline(l) + '</p>';
    }
    if (inList) html += '</ul>';
    return html;
  }
  function renderSummary() { $('summary').innerHTML = doc.summary ? mdToHtml(doc.summary) : ''; $('context').value = doc.context || ''; }

  // ---------- history ----------
  function saveDoc() {
    if (doc.example || !doc.segments.length) return;
    const list = store.get('history', []).filter((d) => d.id !== doc.id);
    list.unshift({ id: doc.id, name: doc.name, date: doc.date, duration: doc.duration, segments: doc.segments, summary: doc.summary || '', context: doc.context || '' });
    store.set('history', list.slice(0, 15));
    renderHistory();
  }
  function renderHistory() {
    const list = store.get('history', []);
    $('history').innerHTML = list.length
      ? list.map((d) => `<button type="button" data-id="${esc(d.id)}"><b>${esc(d.name)}</b><small>${esc(new Date(d.date).toLocaleString())} · ${clock(d.duration || 0)}</small></button>`).join('')
      : '<p class="help">Finished transcripts are saved in this browser and listed here.</p>';
  }
  $('history').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]'); if (!b || running) return;
    const d = store.get('history', []).find((x) => x.id === b.dataset.id); if (!d) return;
    doc = structuredClone(d); renderTranscript(); renderSummary();
    $('player').hidden = true; toast('Opened ' + d.name + '. Load the recording again to play it.');
  });

  // ---------- editing and playback ----------
  let saveTimer;
  $('transcript').addEventListener('input', (e) => {
    const row = e.target.closest('.seg'); if (!row) return;
    doc.segments[+row.dataset.i].text = e.target.innerText.trim();
    clearTimeout(saveTimer); saveTimer = setTimeout(saveDoc, 800);
  });
  $('transcript').addEventListener('click', (e) => {
    const t = e.target.closest('.t'); if (!t) return;
    const p = $('player'); if (p.hidden || !p.src) { toast('Load the recording to play it from this point.'); return; }
    p.currentTime = doc.segments[+t.parentElement.dataset.i].start; p.play();
  });
  let liveIdx = -1;
  $('player').addEventListener('timeupdate', () => {
    const t = $('player').currentTime;
    const i = doc.segments.findIndex((s) => t >= s.start && t < s.end);
    if (i === liveIdx) return;
    const box = $('transcript');
    box.querySelector('.seg.live')?.classList.remove('live');
    liveIdx = i; if (i < 0) return;
    const row = box.querySelector(`.seg[data-i="${i}"]`); if (!row) return;
    row.classList.add('live');
    if ($('follow').checked && document.activeElement?.closest('.seg') == null) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  $('speed').addEventListener('change', () => { $('player').playbackRate = +$('speed').value; });
  $('showTimes').addEventListener('change', () => $('transcript').classList.toggle('hide-times', !$('showTimes').checked));

  // ---------- file loading ----------
  async function takeFile(file) {
    if (!file || running) return;
    fileName = file.name; resumeAt = null; $('resume').hidden = true; setMsg('Reading the audio from ' + file.name); setBar(0);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(file);
    const p = $('player'); p.src = audioUrl; p.hidden = false; p.playbackRate = +$('speed').value;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const n = buf.length, ch = buf.numberOfChannels, out = new Float32Array(n);
      for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
      ctx.close();
      audioData = out;
      $('filemeta').hidden = false; $('filemeta').textContent = file.name + ' · ' + clock(n / SR);
      $('go').disabled = false;
      setMsg('The recording is ' + clock(n / SR) + ' long. Press Transcribe when you are ready.');
    } catch (err) {
      audioData = null; $('go').disabled = true;
      setMsg('This browser could not read that file. Try converting it to MP3 or WAV first.', true);
    }
  }
  $('file').addEventListener('change', (e) => takeFile(e.target.files[0]));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => takeFile(e.dataTransfer.files[0]));

  // ---------- worker ----------
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorker;
    worker.onerror = (e) => { e.preventDefault(); finish('The transcription engine stopped unexpectedly. Reload the page and try the Small model.', true); };
    return worker;
  }
  let totalWindows = 0, loadingCached = false, savedList = [], cacheAvailable = true;
  const MODEL_NAMES = {
    'onnx-community/whisper-large-v3-turbo': 'Large v3 Turbo',
    'onnx-community/whisper-small': 'Small',
    'onnx-community/whisper-base': 'Base'
  };
  function showSaved(saved) {
    if (!saved) return;
    savedList = saved.models; cacheAvailable = saved.available;
    for (const o of $('model').options) {
      o.textContent = o.textContent.replace(/ · saved on this computer$/, '') + (savedList.includes(o.value) ? ' · saved on this computer' : '');
    }
    updateModelHelp();
  }
  function updateModelHelp() {
    const id = $('model').value, name = MODEL_NAMES[id] || 'This model';
    let text;
    if (!cacheAvailable) text = 'This browser is not allowing Akosile to save the model, so it downloads again on every visit. Private or incognito windows cause this.';
    else if (savedList.includes(id)) text = name + ' is saved on this computer, so it loads without downloading.';
    else text = 'Your browser downloads ' + name + ' the first time and keeps it for later visits.';
    if (storageNote) text += ' ' + storageNote;
    $('modelHelp').textContent = text;
  }
  $('model').addEventListener('change', updateModelHelp);

  // Asks the browser to keep saved models even when disk space runs low, and warns when space is short.
  let storageNote = '';
  async function checkStorage() {
    try {
      const persisted = await navigator.storage?.persisted?.() || await navigator.storage?.persist?.();
      const est = await navigator.storage?.estimate?.();
      if (est && est.quota && est.quota - (est.usage || 0) < 1.5e9) {
        storageNote = 'Your computer is low on free space, so the browser may delete the saved model. Free up a few GB to keep it.';
      } else if (persisted === false) {
        storageNote = 'Bookmark this page so your browser is more likely to keep the model when space runs low.';
      }
      updateModelHelp();
    } catch (e) {}
  }

  function onWorker(e) {
    const m = e.data;
    if (m.type === 'probe') {
      const d = $('device'); d.textContent = m.gpu ? 'Graphics card ready (WebGPU)' : 'Processor only (no WebGPU)'; d.classList.toggle('gpu', m.gpu);
      $('noGpu').hidden = m.gpu;
      if (!m.gpu && !store.get('settings', null)) $('model').value = 'onnx-community/whisper-small';
      showSaved(m.saved);
      return;
    }
    if (m.type === 'saved') { showSaved(m.saved); return; }
    if (m.type === 'loading') {
      loadingCached = m.cached;
      setMsg(m.cached ? 'Akosile is loading the saved model from this computer. Nothing is being downloaded.' : 'Akosile is downloading the model. Your browser saves it for next time.');
    }
    if (m.type === 'status') setMsg(m.text);
    if (m.type === 'note') toast(m.text);
    if (m.type === 'load') {
      setBar(m.progress);
      const mb = (x) => Math.round(x / 1048576);
      if (loadingCached) setMsg(`Akosile is loading the saved model from this computer (${Math.round(m.progress || 0)}%). Nothing is being downloaded.`);
      else setMsg(m.total ? `Akosile is downloading the model: ${mb(m.loaded)} of ${mb(m.total)} MB. Your browser saves it, so this happens only once.` : 'Akosile is downloading the model.');
    }
    if (m.type === 'ready') { setBar(0); setMsg('The model is ready. Akosile is transcribing the first section.'); runStart = performance.now(); }
    if (m.type === 'plan') totalWindows = m.total;
    if (m.type === 'segments') {
      const r = rules();
      appendSegments(m.items.map((s) => ({ ...s, text: applyVocab(s.text, r) })));
      setBar(m.done / m.total * 100);
      resumeAt = m.audioDone;
      const el = (performance.now() - runStart) / 1000, left = el / m.done * (m.total - m.done);
      const full = audioData ? audioData.length / SR : 0, H = full >= 3600;
      setMsg(`Akosile has transcribed up to ${clock(m.audioDone, H)} of ${clock(full, H)}. About ${clock(left)} remains. Keep this tab open until it finishes.`);
    }
    if (m.type === 'complete') {
      const full = audioData ? audioData.length / SR : 0, H = full >= 3600;
      let text = `Akosile finished all ${m.total} sections and covered the full ${clock(full, H)}.`;
      if (m.silent) text += ` It found no speech in ${m.silent} of them.`;
      if (m.failed) text += ` It could not transcribe ${m.failed}, and the toast messages named where.`;
      text += ' Click any timestamp to check a passage against the audio.';
      resumeAt = null;
      finish(text);
    }
    if (m.type === 'stopped') { resumeAt = m.resumeAt; finish('Akosile stopped at ' + clock(m.resumeAt) + '. The transcript so far is saved, and you can continue from there.'); }
    if (m.type === 'error') {
      if (m.resumeAt != null) resumeAt = m.resumeAt;
      const hint = /fetch|network|Failed to load/i.test(m.text) ? ' Check your internet connection, because the first run downloads the model.' : '';
      finish('Transcription stopped with an error: ' + m.text + '.' + hint + (doc.segments.length ? ' You can continue from where it stopped.' : ''), true);
    }
  }
  function finish(text, err) {
    running = false; $('go').disabled = !audioData; $('stop').hidden = true; $('go').hidden = false;
    releaseWake();
    const canResume = audioData && resumeAt != null && doc.segments.length && resumeAt < audioData.length / SR - 1;
    $('resume').hidden = !canResume;
    if (canResume) $('resume').textContent = 'Continue from ' + clock(resumeAt);
    setMsg(text, err); if (!err) setBar(100);
    doc.duration = audioData ? audioData.length / SR : doc.duration;
    saveDoc();
  }
  // Keeps the screen and laptop awake during a long run, where the browser allows it.
  let wake = null;
  async function holdWake() { try { wake = await navigator.wakeLock?.request('screen'); } catch (e) { wake = null; } }
  function releaseWake() { try { wake?.release(); } catch (e) {} wake = null; }
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') holdWake(); });

  function startRun(startAt) {
    running = true;
    $('go').hidden = true; $('stop').hidden = false; $('resume').hidden = true;
    store.set('settings', { model: $('model').value, lang: $('lang').value, task: $('task').value });
    holdWake();
    getWorker().postMessage({ type: 'run', model: $('model').value, audio: audioData.slice(), opts: { language: $('lang').value || null, task: $('task').value, startAt } });
  }
  $('go').addEventListener('click', () => {
    if (!audioData || running) return;
    resumeAt = null;
    doc = { id: 'd' + Date.now(), name: fileName.replace(/\.[^.]+$/, '') || 'Recording', date: Date.now(), duration: audioData.length / SR, segments: [], summary: '', context: $('context').value === EXAMPLE.context ? '' : $('context').value };
    renderTranscript(); renderSummary();
    startRun(0);
  });
  $('resume').addEventListener('click', () => {
    if (!audioData || running || resumeAt == null) return;
    setMsg('Akosile is continuing from ' + clock(resumeAt) + '.');
    startRun(resumeAt);
  });
  $('stop').addEventListener('click', () => { worker?.postMessage({ type: 'stop' }); setMsg('Akosile will stop when the current section finishes.'); });
  $('applyVocab').addEventListener('click', () => {
    const r = rules(); doc.segments.forEach((s) => (s.text = applyVocab(s.text, r))); renderTranscript(); saveDoc(); toast('Your corrections are applied.');
  });
  $('vocab').addEventListener('input', () => store.set('vocab', $('vocab').value));

  // ---------- export ----------
  function plain(withTimes) {
    const H = hasHours();
    return doc.segments.map((s) => (withTimes ? '[' + clock(s.start, H) + '] ' : '') + s.text).join(withTimes ? '\n' : ' ').replace(/ {2,}/g, ' ');
  }
  function build(kind) {
    const times = $('showTimes').checked, H = hasHours();
    if (kind === 'txt') return { body: plain(times), type: 'text/plain' };
    if (kind === 'srt') return { body: doc.segments.map((s, i) => `${i + 1}\n${stamp(s.start, ',')} --> ${stamp(s.end, ',')}\n${s.text}\n`).join('\n'), type: 'application/x-subrip' };
    if (kind === 'vtt') return { body: 'WEBVTT\n\n' + doc.segments.map((s) => `${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${s.text}\n`).join('\n'), type: 'text/vtt' };
    if (kind === 'md') {
      let md = `# ${doc.name}\n\n`;
      if (doc.summary) md += doc.summary.replace(/^###/gm, '##') + '\n\n';
      md += '## Transcript\n\n' + doc.segments.map((s) => (times ? `**${clock(s.start, H)}** ` : '') + s.text).join('\n\n') + '\n';
      return { body: md, type: 'text/markdown' };
    }
    if (kind === 'doc') {
      const rows = doc.segments.map((s) => `<p>${times ? `<span style="color:#2c3a8f;font-family:Consolas,monospace">${clock(s.start, H)}</span>&nbsp;&nbsp;` : ''}${esc(s.text)}</p>`).join('');
      const html = `<html><head><meta charset="utf-8"><title>${esc(doc.name)}</title></head><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt"><h1 style="font-size:18pt">${esc(doc.name)}</h1>${doc.summary ? mdToHtml(doc.summary) + '<h2>Transcript</h2>' : ''}${rows}</body></html>`;
      return { body: html, type: 'application/msword', ext: 'doc' };
    }
  }
  document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
    if (!doc.segments.length) return toast('There is no transcript to export yet.');
    const k = b.dataset.export, out = build(k);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out.body], { type: out.type + ';charset=utf-8' }));
    a.download = (doc.name || 'transcript') + '.' + (out.ext || k);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }));
  async function copy(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); }
    catch (e) { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast(done); }
  }
  $('copyAll').addEventListener('click', () => copy(plain($('showTimes').checked), 'The transcript is on your clipboard.'));

  // ---------- summary ----------
  function prompt() {
    const ctx = $('context').value.trim();
    return `Summarise the transcript below${ctx ? ' of this recording: ' + ctx : ''}.

The speakers may use Nigerian English and local names. Keep every name exactly as the transcript spells it. Where the transcript looks garbled, write what was most likely said and mark it with (unclear).

Write in British English and plain sentences. Do not use em dashes. Return Markdown with these sections, each as a ### heading:
### Summary (one short paragraph)
### Key points (bullets)
### Decisions (bullets)
### Action items (bullets, each written as "Owner will do task by deadline", with the timestamp in backticks like \`[12:34]\`)
### Open questions (bullets)
If a section has nothing, write "None mentioned."

Transcript:
${plain(true)}`;
  }
  $('copyPrompt').addEventListener('click', () => {
    if (!doc.segments.length) return toast('There is no transcript to summarise yet.');
    copy(prompt(), 'The prompt is copied. Paste it into a Claude chat.');
  });
  $('context').addEventListener('input', () => { doc.context = $('context').value; });
  $('apiKey').addEventListener('change', () => store.set('apiKey', $('apiKey').value.trim()));
  $('apiModel').addEventListener('change', () => store.set('apiModel', $('apiModel').value.trim()));
  $('summarise').addEventListener('click', async () => {
    const key = $('apiKey').value.trim();
    if (!doc.segments.length) return toast('There is no transcript to summarise yet.');
    if (!key) { $('apiKey').closest('details').open = true; $('apiKey').focus(); $('sumMsg').textContent = 'Add your Anthropic API key below, or use the copy button to summarise in a normal Claude chat.'; return; }
    const btn = $('summarise'); btn.disabled = true; $('sumMsg').textContent = 'Claude is reading the transcript.';
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: $('apiModel').value.trim() || 'claude-sonnet-5-5', max_tokens: 2500, messages: [{ role: 'user', content: prompt() }] })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || res.statusText);
      doc.summary = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      renderSummary(); saveDoc();
      $('sumMsg').textContent = 'Claude wrote this summary. Exports to Word and Markdown now include it.';
    } catch (err) {
      $('sumMsg').textContent = 'The Claude API returned an error: ' + err.message;
    } finally { btn.disabled = false; }
  });

  // ---------- boot ----------
  const s = store.get('settings', null);
  if (s) { $('model').value = s.model; $('lang').value = s.lang; $('task').value = s.task; }
  $('vocab').value = store.get('vocab', '');
  if ($('vocab').value) $('vocabBox').open = true;
  $('apiKey').value = store.get('apiKey', '');
  $('apiModel').value = store.get('apiModel', 'claude-sonnet-5-5');
  renderTranscript(); renderSummary(); renderHistory();
  checkStorage();
  try { getWorker().postMessage({ type: 'probe' }); }
  catch (e) { $('device').textContent = 'Engine unavailable'; setMsg('This browser blocked the transcription engine. Open Akosile in Chrome or Edge instead.', true); }
})();
