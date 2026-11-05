const portaudio = require('naudiodon2');
const { CompJob } = require('./comp');

const GRID = { f0: 20, ppo: 24, count: 240 };
const gridFreq = (i) => GRID.f0 * Math.pow(2, i / GRID.ppo);
const N = 8192;
const PRE = 64;
// Cycle must exceed N/sr plus one chunk so the next impulse never lands in the analysis window
const PERIOD_S = 0.22;
const NO_SIGNAL_S = 0.2;
const FRAMES_PER_CHUNK = 1024;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function listDevices() {
  return portaudio.getDevices()
    .filter((d) => d.maxInputChannels > 0 && d.maxOutputChannels > 0)
    .map((d) => ({
      id: d.id, name: d.name, api: d.hostAPIName,
      inputs: d.maxInputChannels, outputs: d.maxOutputChannels, sampleRate: d.defaultSampleRate,
    }));
}

// Audio is emitted continuously while input is captured from the same interface.
class Engine {
  constructor() {
    this.io = null;
    this.streams = new Map();
    this.listeners = new Set();
    this.status = { running: false };
    this.cfg = {};
  }

  emit(msg) { for (const l of this.listeners) l(msg); }

  setStatus(s) { this.status = { ...this.status, ...s }; this.emit({ type: 'status', ...this.status }); }

  configure(c) {
    this.cfg = { ...this.cfg, ...c };
    if ('inCh' in c || 'outCh' in c) this.ring && this.ring.fill(0);
  }

  // Closing a PortAudio stream intermittently crashes CoreAudio, so streams are
  // never closed: each device keeps one open stream that plays silence while idle.
  start(opts) { return this.enqueue(() => this._start(opts)); }

  stop() { return this.enqueue(() => this._stop()); }

  enqueue(fn) {
    const run = (this.queue || Promise.resolve()).then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  openStream(dev, inCh, outCh) {
    let s = this.streams.get(dev.id);
    if (s) return s;
    const sr = dev.defaultSampleRate;
    // Open the complete device layout. CoreAudio may remap a reduced channel
    // stream to its default stereo pair instead of the requested physical bus.
    const nIn = dev.maxInputChannels;
    const nOut = dev.maxOutputChannels;
    const io = new portaudio.AudioIO({
      inOptions: { channelCount: nIn, sampleFormat: portaudio.SampleFormatFloat32, sampleRate: sr, deviceId: dev.id, closeOnError: true, framesPerBuffer: FRAMES_PER_CHUNK },
      outOptions: { channelCount: nOut, sampleFormat: portaudio.SampleFormatFloat32, sampleRate: sr, deviceId: dev.id, closeOnError: true, framesPerBuffer: FRAMES_PER_CHUNK },
    });
    s = { id: dev.id, io, sr, nIn, nOut, name: dev.name, outputFrame: 0 };
    this.streams.set(dev.id, s);
    io.on('data', (chunk) => {
      if (this.io === io) this.onChunk(chunk);
    });
    io.on('error', (e) => {
      this.streams.delete(dev.id);
      if (this.io === io) { this.io = null; this.setStatus({ running: false, error: e.message }); }
    });
    io.start();
    this.pumpOutput(s);
    return s;
  }

  pumpOutput(s) {
    const out = new Float32Array(FRAMES_PER_CHUNK * s.nOut);
    if (this.io === s.io) {
      if (this.job) {
        const job = this.job;
        const { outCh } = this.cfg;
        const oc = Math.min(outCh, s.nOut - 1);
        for (let i = 0; i < FRAMES_PER_CHUNK && !job.done; i++, job.frame++) {
          out[i * s.nOut + oc] = job.sample(job.frame);
        }
        if (job.done) {
          this.job = null;
          this.io = null;
          this.setStatus({ running: false });
          setImmediate(() => this.emit({ type: 'comp', ...job.analyse() }));
        } else if (job.chunks++ % 5 === 0) {
          this.emit({ type: 'progress', frac: job.frame / job.total });
        }
      } else if (this.status.mode === 'eq') {
        const { outCh, levelDb } = this.cfg;
        const oc = Math.min(outCh, s.nOut - 1);
        const amp = Math.pow(10, levelDb / 20);
        for (let i = 0; i < FRAMES_PER_CHUNK; i++, s.outputFrame++) {
          if (s.outputFrame === this.nextImpulse) {
            out[i * s.nOut + oc] = amp;
            this.impulseAt = s.outputFrame;
            this.waiting = true;
            this.nextImpulse += Math.round(this.sr * PERIOD_S);
            this.lastImpulseAmp = amp;
          }
        }
      }
    }

    s.io.write(Buffer.from(out.buffer), (error) => {
      if (error) {
        this.streams.delete(s.id);
        if (this.io === s.io) {
          this.io = null;
          this.setStatus({ running: false, error: error.message });
        }
        return;
      }
      this.pumpOutput(s);
    });
  }

  async _start({ deviceId, inCh, outCh, levelDb, smoothing }) {
    this.job = null;
    const { dev, s } = await this.attach(deviceId, inCh, outCh);
    const { sr, nIn, nOut } = s;
    this.cfg = { inCh, outCh, levelDb, smoothing };
    this.sr = sr; this.nIn = nIn; this.nOut = nOut;

    this.ringLen = Math.ceil(sr * PERIOD_S * 2);
    this.ring = new Float32Array(this.ringLen);
    this.ringPos = 0;
    this.frame = 0;
    s.outputFrame = 0;
    this.nextImpulse = Math.ceil(sr * 0.1);
    this.lastAnalysed = -1;
    this.lastImpulseAmp = 0;
    this.waiting = false;
    this.due = null;

    this.io = s.io;
    this.setStatus({ running: true, mode: 'eq', error: null, sampleRate: sr, nIn, nOut, inCh, outCh, device: dev.name });
  }

  async attach(deviceId, inCh, outCh) {
    await this._stop();
    const dev = portaudio.getDevices().find((d) => d.id === deviceId);
    if (!dev) throw new Error('Device not found');
    try { return { dev, s: this.openStream(dev, inCh, outCh) }; } catch (e) { throw new Error(`Could not start audio on "${dev.name}": ${e.message}`); }
  }

  runComp(opts) { return this.enqueue(() => this._runComp(opts)); }

  async _runComp({ deviceId, inCh, outCh, variant }) {
    const { dev, s } = await this.attach(deviceId, inCh, outCh);
    this.cfg = { inCh, outCh };
    this.sr = s.sr; this.nIn = s.nIn; this.nOut = s.nOut;
    this.job = new CompJob(variant === 'b' ? 'b' : 'a', s.sr);
    s.outputFrame = 0;
    this.io = s.io;
    this.setStatus({ running: true, mode: 'comp', error: null, sampleRate: s.sr, nIn: s.nIn, nOut: s.nOut, inCh, outCh, device: dev.name });
  }

  onJobChunk(f32, frames) {
    const job = this.job, { inCh } = this.cfg;
    const ic = Math.min(inCh, this.nIn - 1);
    for (let i = 0; i < frames && job.captureFrame < job.total; i++, job.captureFrame++) {
      job.rec[job.captureFrame] = f32[i * this.nIn + ic];
    }
  }

  onChunk(chunk) {
    const io = this.io;
    if (!io) return;
    const f32 = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);
    const frames = f32.length / this.nIn;
    if (this.job) return this.onJobChunk(f32, frames);
    const { inCh } = this.cfg;

    for (let i = 0; i < frames; i++) {
      const s = f32[i * this.nIn + Math.min(inCh, this.nIn - 1)];
      this.ring[this.ringPos] = s;
      this.ringPos = (this.ringPos + 1) % this.ringLen;
      const at = this.frame + i;
      if (this.waiting && Math.abs(s) > this.lastImpulseAmp * 0.1) {
        // Impulse has come back through the loop: analyse as soon as its tail is captured
        this.waiting = false;
        this.due = at + N + PRE;
      }
    }
    this.frame += frames;

    // No response at all: still analyse so a "no signal" message gets reported
    if (this.waiting && this.frame >= this.impulseAt + Math.round(this.sr * NO_SIGNAL_S)) {
      this.waiting = false;
      this.due = this.frame;
    }
    if (this.due != null && this.frame >= this.due) {
      this.due = null;
      setImmediate(() => this.analyse());
    }
  }

  window() {
    const len = Math.round(this.sr * PERIOD_S);
    const data = new Float32Array(len);
    let p = (this.ringPos - len + this.ringLen) % this.ringLen;
    for (let i = 0; i < len; i++) { data[i] = this.ring[p]; p = (p + 1) % this.ringLen; }
    return data;
  }

  analyse() {
    if (!this.io || !this.lastImpulseAmp) return;
    const data = this.window();
    const amp = this.lastImpulseAmp;
    let peak = 0, pi = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) { peak = a; pi = i; }
    }
    const peakDb = 20 * Math.log10(peak || 1e-9);
    const start = pi - PRE;
    if (peak < 1e-4 || start < 0 || start + N > data.length) {
      this.emit({ type: 'nosignal', peakDb });
      return;
    }

    const re = new Float64Array(N), im = new Float64Array(N);
    const fadeStart = Math.floor(N * 0.75);
    for (let i = 0; i < N; i++) {
      let w = 1;
      if (i > fadeStart) w = 0.5 * (1 + Math.cos(Math.PI * (i - fadeStart) / (N - fadeStart)));
      re[i] = data[start + i] * w;
    }
    fft(re, im);
    const bins = N / 2;
    const pow = new Float64Array(bins);
    for (let k = 0; k < bins; k++) pow[k] = (re[k] * re[k] + im[k] * im[k]) / (amp * amp);

    const nyq = this.sr / 2;
    const frac = this.cfg.smoothing || 6;
    const half = Math.pow(2, 1 / (2 * frac));
    const db = new Array(GRID.count);
    for (let g = 0; g < GRID.count; g++) {
      const f = gridFreq(g);
      if (f >= nyq) { db[g] = null; continue; }
      const kc = f * N / this.sr, lo = kc / half, hi = kc * half;
      const a = Math.ceil(lo), b = Math.min(Math.floor(hi), bins - 1);
      let v;
      if (b - a < 1) {
        const k0 = Math.min(Math.floor(kc), bins - 2), t = kc - k0;
        v = pow[k0] * (1 - t) + pow[k0 + 1] * t;
      } else {
        let s = 0;
        for (let k = a; k <= b; k++) s += pow[k];
        v = s / (b - a + 1);
      }
      db[g] = v > 0 ? +(10 * Math.log10(v)).toFixed(2) : null;
    }
    this.emit({ type: 'result', pow: Array.from({ length: GRID.count }, (_, g) => db[g]), peakDb, sampleRate: this.sr });
  }

  async _stop() {
    this.job = null;
    this.io = null;
    if (this.status.running) this.setStatus({ running: false });
  }
}

module.exports = { Engine, listDevices, GRID };
