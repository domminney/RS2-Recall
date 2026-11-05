'use strict';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 10);
const safeName = (n) => String(n).replace(/[^\w\- ]/g, '').trim().slice(0, 80);

// Log-spaced analysis grid shared by live curve and saved readings
const GRID = { f0: 20, ppo: 24, count: 240 };
const gridFreq = (i) => GRID.f0 * Math.pow(2, i / GRID.ppo);

// ---------- state ----------
let session = null;       // { name, created, tests: [] }
let currentId = null;
let live = null;          // smoothed power on grid (EMA)
let liveInfo = null;
let devices = [];
let status = { running: false };
let saveTimer = null;

const current = () => session && session.tests.find((t) => t.id === currentId);
const isComp = (t) => !!t && t.type === 'comp';
const variantOf = (t) => (t && t.variant === 'b' ? 'b' : 'a');
const readingKey = (t) => (isComp(t) ? (variantOf(t) === 'b' ? 'readingB' : 'readingA') : 'reading');
const readingOf = (t) => (t && t[readingKey(t)]) || null;
const hasReading = (t) => !!(t.reading || t.readingA || t.readingB);

let compLive = { a: null, b: null };  // latest compression results, not yet saved
let autoStopped = false;              // EQ analyser was paused by switching to a compression test
const B_PLAN = [[1, -18], [2, -12], [2, -6], [2, -12], [1, -18]];

// ---------- persistence ----------
async function api(path, opts) {
  const r = await fetch('/api/sessions' + path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
  setStatus('Saving…');
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!session) return;
  try {
    await api('/' + encodeURIComponent(session.name), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session),
    });
    setStatus('Saved to sessions/' + session.name + '.json');
  } catch (e) { setStatus('Save failed: ' + e.message); }
}

function setStatus(s) { $('status').textContent = s; }

async function refreshSessionList(select) {
  const names = await api('');
  const sel = $('sessionSel');
  sel.innerHTML = '';
  names.forEach((n) => sel.add(new Option(n, n)));
  if (select) sel.value = select;
}

async function loadSession(name) {
  await saveNow();
  session = await api('/' + encodeURIComponent(name));
  localStorage.setItem('lastSession', name);
  $('sessionSel').value = name;
  await selectTest(session.tests.length ? session.tests[0].id : null);
}

async function newSession() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const def = `Session ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const name = safeName(prompt('Session name', def) || '');
  if (!name) return;
  const existing = await api('');
  if (existing.includes(name)) { alert('A session with that name already exists.'); return; }
  await saveNow();
  session = { name, created: new Date().toISOString(), tests: [] };
  await saveNow();
  await refreshSessionList(name);
  localStorage.setItem('lastSession', name);
  await selectTest(null);
}

async function renameSession() {
  if (!session) return;
  const name = safeName(prompt('Rename session', session.name) || '');
  if (!name || name === session.name) return;
  await saveNow();
  try {
    const r = await fetch('/api/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: session.name, to: name }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || (r.status === 404 ? 'server needs restarting (npm start) to support renaming' : r.statusText));
    session.name = body.name;
    localStorage.setItem('lastSession', body.name);
    await refreshSessionList(body.name);
    setStatus('Renamed to ' + body.name);
  } catch (e) { alert('Rename failed: ' + e.message); }
}

// ---------- tests list ----------
function renderList() {
  const ul = $('testList');
  ul.innerHTML = '';
  (session ? session.tests : []).forEach((t) => {
    const li = document.createElement('li');
    li.className = t.id === currentId ? 'active' : '';
    li.innerHTML = '<span></span><span class="dot"></span>';
    li.firstChild.textContent = t.name;
    li.lastChild.textContent = hasReading(t) ? '●' : '';
    li.onclick = () => selectTest(t.id);
    ul.appendChild(li);
  });
}

function addTest(type) {
  if (!session) return;
  const base = current() || lastSetup();
  const n = session.tests.length + 1;
  const t = {
    id: uid(), type, name: (type === 'comp' ? 'Comp ' : 'Channel ') + n,
    dev: base.dev || (devices[0] ? devices[0].name : ''),
    inCh: base.inCh || 0, outCh: base.outCh || 0,
  };
  if (type === 'comp') { t.variant = 'a'; t.readingA = null; t.readingB = null; } else t.reading = null;
  session.tests.push(t);
  scheduleSave();
  selectTest(t.id);
  $('testName').select();
}

function lastSetup() {
  try { return JSON.parse(localStorage.getItem('lastSetup')) || {}; } catch (e) { return {}; }
}

function rememberSetup(t) {
  localStorage.setItem('lastSetup', JSON.stringify({ dev: t.dev, inCh: t.inCh, outCh: t.outCh }));
}

function cloneTest() {
  const t = current();
  if (!t) return;
  const c = JSON.parse(JSON.stringify(t));
  c.id = uid();
  c.name = t.name + ' copy';
  session.tests.splice(session.tests.indexOf(t) + 1, 0, c);
  scheduleSave();
  selectTest(c.id);
  $('testName').select();
}

function deleteTest() {
  const t = current();
  if (!t || !confirm(`Delete "${t.name}" and its reading?`)) return;
  session.tests = session.tests.filter((x) => x !== t);
  scheduleSave();
  selectTest(session.tests.length ? session.tests[0].id : null);
}

// ---------- device / channel UI ----------
const post = (path, body) => fetch('/api' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); });

// Devices are matched by name so saved tests survive device-id changes
const devByName = (name) => devices.find((d) => d.name === name) || devices[0];

async function loadDevices() {
  devices = await (await fetch('/api/devices')).json();
  const sel = $('dev');
  sel.innerHTML = '';
  devices.forEach((d) => sel.add(new Option(`${d.name} (${d.inputs} in / ${d.outputs} out)`, d.name)));
}

function fillChannels(id, count, selected) {
  const sel = $(id);
  sel.innerHTML = '';
  for (let i = 0; i < count; i++) sel.add(new Option(String(i + 1), String(i)));
  sel.value = String(Math.min(selected, count - 1));
}

function showConfig(t) {
  const d = devByName(t.dev);
  if (!d) return;
  $('dev').value = d.name;
  fillChannels('inCh', d.inputs, t.inCh);
  fillChannels('outCh', d.outputs, t.outCh);
}

function readConfigFromUI() {
  const t = current();
  if (!t) return;
  t.dev = $('dev').value; t.inCh = +$('inCh').value; t.outCh = +$('outCh').value;
  rememberSetup(t);
  scheduleSave();
}

function engineParams() {
  const t = current();
  return {
    deviceId: devByName(t.dev).id, inCh: t.inCh, outCh: t.outCh,
    levelDb: +$('level').value, smoothing: +$('smooth').value,
  };
}

async function startEngine() {
  if (!current()) return;
  resetLive();
  try { await post('/start', engineParams()); } catch (e) { setStatus('Could not start audio: ' + e.message); }
}

async function runComp() {
  const t = current();
  if (!t) return;
  const v = variantOf(t);
  compLive[v] = null;
  draw();
  try {
    await post('/comp/run', { deviceId: devByName(t.dev).id, inCh: t.inCh, outCh: t.outCh, variant: v });
  } catch (e) { setStatus('Could not start test: ' + e.message); }
}

async function applyToEngine() {
  if (!status.running || !current() || isComp(current())) return;
  const p = engineParams();
  if (status.device !== devByName(current().dev).name) await startEngine();
  else await post('/config', { inCh: p.inCh, outCh: p.outCh, levelDb: p.levelDb, smoothing: p.smoothing });
}

function resetLive() { live = null; liveInfo = null; compLive = { a: null, b: null }; }

function updateRunBtn() {
  const t = current();
  $('runBtn').textContent = status.running ? 'Stop' : isComp(t) ? 'Run test ' + variantOf(t).toUpperCase() : 'Start';
}

function applyTypeUI(t) {
  const comp = isComp(t);
  $('testType').textContent = comp ? 'Compression test' : 'EQ analyser';
  document.querySelectorAll('.eq-only').forEach((e) => e.classList.toggle('hide', comp));
  $('variantBox').classList.toggle('hide', !comp);
  $('varA').classList.toggle('on', variantOf(t) === 'a');
  $('varB').classList.toggle('on', variantOf(t) === 'b');
  $('progress').classList.add('hide');
  bView = null;
  $('plot').style.cursor = comp && variantOf(t) === 'b' ? 'grab' : '';
  $('zoomHint').classList.toggle('hide', !(comp && variantOf(t) === 'b'));
  updateRunBtn();
}

function setVariant(v) {
  const t = current();
  if (!isComp(t) || status.running) return;
  t.variant = v;
  scheduleSave();
  applyTypeUI(t); draw(); updateReadingInfo();
}

// ---------- selecting a test ----------
async function selectTest(id) {
  currentId = id;
  const t = current();
  $('panel').hidden = !t;
  $('empty').hidden = !!t;
  renderList();
  if (!t) { await post('/stop'); return; }
  $('testName').value = t.name;
  $('notes').value = t.notes || '';
  showConfig(t);
  rememberSetup(t);
  resetLive();
  applyTypeUI(t);
  draw();
  updateReadingInfo();
  if (isComp(t)) {
    if (status.running) { autoStopped = autoStopped || status.mode === 'eq'; await post('/stop'); }
  } else if (autoStopped && !status.running) {
    autoStopped = false;
    await startEngine();
  } else await applyToEngine();
}

// ---------- readings ----------
function liveDb() {
  return live ? Array.from(live, (v) => (v == null ? NaN : v)) : null;
}

function captureReading() {
  const t = current();
  if (!t) return;
  if (isComp(t)) {
    const r = compLive[variantOf(t)];
    if (!r) { setStatus('No result yet – run the test first.'); return; }
    const { type, nosignal, ...data } = r;
    t[readingKey(t)] = { ts: new Date().toISOString(), ...data };
    scheduleSave(); renderList(); updateReadingInfo(); draw();
    return;
  }
  const db = liveDb();
  if (!db) { setStatus('No live curve yet – press Start and wait for a measurement.'); return; }
  t.reading = {
    ts: new Date().toISOString(),
    sampleRate: liveInfo.sampleRate,
    impulseDb: +$('level').value,
    smoothing: +$('smooth').value,
    peakDb: +liveInfo.peakDb.toFixed(1),
    grid: { ...GRID },
    db: db.map((v) => (Number.isFinite(v) ? +v.toFixed(2) : null)),
  };
  scheduleSave(); renderList(); updateReadingInfo(); draw();
}

function clearReading() {
  const t = current();
  if (!t || !readingOf(t)) return;
  t[readingKey(t)] = null;
  scheduleSave(); renderList(); updateReadingInfo(); draw();
}

function updateReadingInfo() {
  const t = current(), r = readingOf(t);
  $('readingInfo').textContent = !r ? 'No saved reading'
    : isComp(t) ? `Test ${variantOf(t).toUpperCase()} captured ${new Date(r.ts).toLocaleString()} · loop latency ${r.latencyMs} ms`
    : `Captured ${new Date(r.ts).toLocaleString()} · impulse ${r.impulseDb} dB · 1/${r.smoothing} oct · in peak ${r.peakDb} dBFS`;
}

// ---------- plot ----------
function draw() {
  if (isComp(current())) drawComp(current()); else drawEq();
}

const PLOT = { L: 50, R: 12, T: 12, B: 28 };

function niceStep(span, target) {
  const raw = span / target, pow = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / pow;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * pow;
}

function ticks(lo, hi, target) {
  const step = niceStep(hi - lo, target), out = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) out.push(+(k * step).toFixed(6));
  return { step, values: out, dec: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) };
}

function drawFrame(o) {
  const cv = $('plot'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height, { L, R, T, B } = PLOT;
  g.clearRect(0, 0, W, H);
  const x = (v) => L + ((v - o.x0) / (o.x1 - o.x0)) * (W - L - R);
  const y = (v) => T + (1 - (v - o.y0) / (o.y1 - o.y0)) * (H - T - B);
  g.font = '11px system-ui'; g.fillStyle = '#889'; g.strokeStyle = '#242830'; g.lineWidth = 1;
  g.textAlign = 'right';
  for (let k = Math.ceil(o.y0 / o.ys - 1e-9); k * o.ys <= o.y1 + 1e-9; k++) {
    const d = +(k * o.ys).toFixed(6);
    g.beginPath(); g.moveTo(L, y(d)); g.lineTo(W - R, y(d)); g.stroke();
    g.fillText(o.yf ? o.yf(d) : d + '', L - 6, y(d) + 4);
  }
  g.textAlign = 'center';
  o.xt.forEach((v) => {
    g.beginPath(); g.moveTo(x(v), T); g.lineTo(x(v), H - B); g.stroke();
    g.fillText(o.xf(v), x(v), H - 10);
  });
  g.textAlign = 'right';
  g.fillText(o.label, W - R - 4, T + 12);
  g.save();
  g.beginPath(); g.rect(L, T, W - L - R, H - T - B); g.clip();
  return { g, x, y };
}

function dbSpan(vals, step) {
  return [Math.floor((Math.min(...vals) - 2) / step) * step, Math.ceil((Math.max(...vals) + 2) / step) * step];
}

// Zoom/pan window for the attack/release plot; null = fit everything
let bView = null;
let bShown = null;
const B_TOTAL = B_PLAN.reduce((s, p) => s + p[0], 0);

function drawComp(t) {
  const v = variantOf(t), saved = readingOf(t), liveR = compLive[v];
  const vals = v === 'a' ? [-50, 0] : [-18, -6];
  [saved, liveR].forEach((r) => r && r.outDb.forEach((d) => Number.isFinite(d) && vals.push(d)));
  const step = v === 'a' ? 10 : 5;
  const [y0, y1] = dbSpan(vals, step);
  let f, point;
  if (v === 'a') {
    f = drawFrame({ x0: -50, x1: 0, xt: [-50, -40, -30, -20, -10, 0], xf: (n) => n + '', y0, y1, ys: step, label: 'Input level → output level (dBFS)' });
    point = (r, i) => [f.x(r.inDb[i]), f.y(r.outDb[i])];
    f.g.setLineDash([5, 5]); f.g.strokeStyle = '#4a5160'; f.g.beginPath();
    f.g.moveTo(f.x(-50), f.y(-50)); f.g.lineTo(f.x(0), f.y(0)); f.g.stroke(); f.g.setLineDash([]);
  } else {
    const view = bView || { x0: 0, x1: B_TOTAL, y0, y1 };
    bShown = view;
    const xt = ticks(view.x0, view.x1, 10), yt = ticks(view.y0, view.y1, 8);
    f = drawFrame({
      ...view, xt: xt.values, xf: (n) => n.toFixed(xt.dec) + 's', ys: yt.step, yf: (n) => n.toFixed(yt.dec),
      label: 'Returned 1 kHz level over time (dBFS)',
    });
    point = (r, i) => [f.x((i * r.hopMs) / 1000), f.y(r.outDb[i])];
    f.g.setLineDash([5, 5]); f.g.strokeStyle = '#4a5160'; f.g.beginPath();
    let at = 0;
    B_PLAN.forEach(([dur, db], i) => {
      if (i) f.g.lineTo(f.x(at), f.y(db)); else f.g.moveTo(f.x(at), f.y(db));
      at += dur; f.g.lineTo(f.x(at), f.y(db));
    });
    f.g.stroke(); f.g.setLineDash([]);
  }
  const line = (r, color) => {
    if (!r) return;
    f.g.strokeStyle = color; f.g.lineWidth = 2; f.g.beginPath();
    r.outDb.forEach((_, i) => { const [px, py] = point(r, i); if (i) f.g.lineTo(px, py); else f.g.moveTo(px, py); });
    f.g.stroke();
  };
  line(saved, '#ffb74d');
  line(liveR, '#4fc3f7');
  f.g.restore();
}

// ---------- zoom / pan (attack/release plot) ----------
const zoomable = () => isComp(current()) && variantOf(current()) === 'b';

function plotPos(e) {
  const cv = $('plot'), r = cv.getBoundingClientRect(), k = cv.width / r.width;
  const w = cv.width - PLOT.L - PLOT.R, h = cv.height - PLOT.T - PLOT.B;
  return { fx: ((e.clientX - r.left) * k - PLOT.L) / w, fy: 1 - ((e.clientY - r.top) * k - PLOT.T) / h, w, h, k };
}

// Keep [lo, hi] inside [min, max] without changing its span
function fit(lo, hi, min, max) {
  const span = Math.min(hi - lo, max - min);
  lo = Math.max(min, Math.min(lo, max - span));
  return [lo, lo + span];
}

function zoomAxis(lo, hi, anchor, factor, minSpan, min, max) {
  const span = Math.max(minSpan, Math.min(max - min, (hi - lo) * factor));
  const start = anchor - (anchor - lo) * (span / (hi - lo));
  return fit(start, start + span, min, max);
}

$('plot').addEventListener('wheel', (e) => {
  if (!zoomable() || !bShown) return;
  e.preventDefault();
  const p = plotPos(e), v = { ...bShown };
  const factor = Math.exp((e.deltaY || e.deltaX) * (e.ctrlKey ? 0.01 : 0.0025));
  if (e.altKey) [v.y0, v.y1] = zoomAxis(v.y0, v.y1, v.y0 + p.fy * (v.y1 - v.y0), factor, 0.5, -120, 12);
  else [v.x0, v.x1] = zoomAxis(v.x0, v.x1, v.x0 + p.fx * (v.x1 - v.x0), factor, 0.02, 0, B_TOTAL);
  bView = v;
  draw();
}, { passive: false });

let drag = null;
$('plot').addEventListener('pointerdown', (e) => {
  if (!zoomable() || !bShown) return;
  drag = { x: e.clientX, y: e.clientY, view: { ...bShown } };
  $('plot').setPointerCapture(e.pointerId);
  $('plot').style.cursor = 'grabbing';
});
$('plot').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = plotPos({ clientX: drag.x, clientY: drag.y }), q = plotPos(e), v = { ...drag.view };
  const dx = (q.fx - p.fx) * (v.x1 - v.x0), dy = (q.fy - p.fy) * (v.y1 - v.y0);
  [v.x0, v.x1] = fit(v.x0 - dx, v.x1 - dx, 0, B_TOTAL);
  [v.y0, v.y1] = fit(v.y0 - dy, v.y1 - dy, -120, 12);
  bView = v;
  draw();
});
const endDrag = () => { drag = null; $('plot').style.cursor = zoomable() ? 'grab' : ''; };
$('plot').addEventListener('pointerup', endDrag);
$('plot').addEventListener('pointercancel', endDrag);
$('plot').addEventListener('dblclick', () => { if (zoomable()) { bView = null; draw(); } });

function drawEq() {
  const cv = $('plot'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height, L = 50, R = 12, T = 12, B = 28;
  g.clearRect(0, 0, W, H);
  const t = current();
  const liveCurve = liveDb();
  const saved = t && t.reading ? t.reading.db : null;

  let lo = Infinity, hi = -Infinity;
  [liveCurve, saved].forEach((c) => c && c.forEach((v) => {
    if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }));
  if (!Number.isFinite(lo)) { lo = -40; hi = 20; }
  lo = Math.floor((lo - 3) / 10) * 10; hi = Math.ceil((hi + 3) / 10) * 10;
  if (hi - lo < 40) { const c = (hi + lo) / 2; lo = Math.floor((c - 20) / 10) * 10; hi = lo + 40; }

  const x = (f) => L + (Math.log(f / 20) / Math.log(1000)) * (W - L - R);
  const y = (d) => T + (1 - (d - lo) / (hi - lo)) * (H - T - B);

  g.font = '11px system-ui'; g.fillStyle = '#889'; g.strokeStyle = '#242830'; g.lineWidth = 1;
  g.textAlign = 'right';
  for (let d = lo; d <= hi; d += 10) {
    g.beginPath(); g.moveTo(L, y(d)); g.lineTo(W - R, y(d)); g.stroke();
    g.fillText(d + '', L - 6, y(d) + 4);
  }
  g.textAlign = 'center';
  [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach((f) => {
    g.beginPath(); g.moveTo(x(f), T); g.lineTo(x(f), H - B); g.stroke();
    g.fillText(f >= 1000 ? f / 1000 + 'k' : f + '', x(f), H - 10);
  });
  if (lo < 0 && hi > 0) { g.strokeStyle = '#4a5160'; g.beginPath(); g.moveTo(L, y(0)); g.lineTo(W - R, y(0)); g.stroke(); }

  const line = (curve, color, width) => {
    if (!curve) return;
    g.strokeStyle = color; g.lineWidth = width; g.beginPath();
    let pen = false;
    curve.forEach((v, i) => {
      if (!Number.isFinite(v)) { pen = false; return; }
      const px = x(gridFreq(i)), py = y(v);
      if (pen) g.lineTo(px, py); else g.moveTo(px, py);
      pen = true;
    });
    g.stroke();
  };
  line(saved, '#ffb74d', 2);
  line(liveCurve, '#4fc3f7', 2);
}

// ---------- wiring ----------
function onLive(m) {
  if (m.type === 'status') {
    status = m;
    updateRunBtn();
    if (!m.running || m.mode !== 'comp') $('progress').classList.add('hide');
    if (m.error) setStatus('Audio error: ' + m.error);
    else if (m.running && m.mode === 'comp') { $('progress').classList.remove('hide'); setStatus('Playing test tone…'); }
    else if (m.running) setStatus(`Running on ${m.device}: ${m.nIn} in / ${m.nOut} out @ ${m.sampleRate} Hz`);
    else setStatus('Stopped');
  } else if (m.type === 'progress') {
    $('progress').value = m.frac;
  } else if (m.type === 'comp') {
    if (m.nosignal) setStatus(`No signal returned (input peak ${m.peakDb.toFixed(1)} dBFS) – check routing, channels and levels.`);
    else {
      compLive[m.variant] = m;
      setStatus(`Test ${m.variant.toUpperCase()} complete · loop latency ${m.latencyMs} ms – press Capture to save it.`);
      draw();
    }
  } else if (m.type === 'result') {
    const a = +$('avg').value;
    live = live ? m.pow.map((v, i) => (v == null || live[i] == null ? v : a * v + (1 - a) * live[i])) : m.pow;
    liveInfo = m;
    setStatus(`Running · input peak ${m.peakDb.toFixed(1)} dBFS${m.peakDb > -0.5 ? ' – INPUT CLIPPING' : ''}`);
    draw();
  } else if (m.type === 'nosignal') {
    setStatus(`No impulse detected (input peak ${m.peakDb.toFixed(1)} dBFS) – check routing, channels and levels.`);
  }
}

$('runBtn').onclick = () => {
  if (status.running) { autoStopped = false; return post('/stop'); }
  return isComp(current()) ? runComp() : startEngine();
};
$('capture').onclick = captureReading;
$('clear').onclick = clearReading;
$('addTest').onclick = () => addTest('eq');
$('addComp').onclick = () => addTest('comp');
$('varA').onclick = () => setVariant('a');
$('varB').onclick = () => setVariant('b');
$('delTest').onclick = deleteTest;
$('cloneTest').onclick = cloneTest;
$('newSession').onclick = newSession;
$('renameSession').onclick = renameSession;
$('sessionSel').onchange = (e) => loadSession(e.target.value);
$('notes').oninput = (e) => {
  const t = current();
  if (!t) return;
  t.notes = e.target.value;
  scheduleSave();
};
$('testName').oninput = (e) => {
  const t = current();
  if (!t) return;
  t.name = e.target.value;
  scheduleSave(); renderList();
};
$('dev').onchange = () => {
  const d = devByName($('dev').value);
  fillChannels('inCh', d.inputs, 0);
  fillChannels('outCh', d.outputs, 0);
  readConfigFromUI();
  resetLive();
  if (status.running && !isComp(current())) startEngine();
};
['inCh', 'outCh'].forEach((id) => ($(id).onchange = () => {
  readConfigFromUI(); resetLive(); applyToEngine();
}));
$('level').oninput = (e) => {
  $('levelV').textContent = e.target.value + ' dB';
  resetLive(); applyToEngine();
};
$('smooth').onchange = () => { resetLive(); applyToEngine(); };
window.addEventListener('beforeunload', () => {
  if (session) fetch('/api/sessions/' + encodeURIComponent(session.name), {
    method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session),
  });
});

(async function init() {
  await loadDevices();
  new EventSource('/api/live').onmessage = (e) => onLive(JSON.parse(e.data));
  let names = await api('');
  if (!names.length) {
    session = { name: 'Session 1', created: new Date().toISOString(), tests: [] };
    await saveNow();
    names = await api('');
  }
  await refreshSessionList();
  const last = localStorage.getItem('lastSession');
  await loadSession(names.includes(last) ? last : names[0]);
})();

