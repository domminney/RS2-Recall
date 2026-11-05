// Compressor tests: a 1 kHz tone is played with a known level plan, the returned
// signal is recorded, and the 1 kHz level is measured with a single-bin DFT.
const TONE_HZ = 1000;
const IMPULSE_AMP = Math.pow(10, -12 / 20);
const IMPULSE_AT_S = 0.1;   // latency-finding click
const TONE_AT_S = 0.6;      // tone starts after the click has had time to return
const TAIL_S = 0.5;         // extra recording after the tone to cover the loop latency
const FADE_S = 0.005;       // fade at the very start/end of the tone to avoid pops
const ENV_HOP_S = 0.005;    // test B envelope resolution (5 whole cycles of 1 kHz)

const dbToAmp = (db) => Math.pow(10, db / 20);
const ampToDb = (a) => 20 * Math.log10(Math.max(a, 1e-6));

function plan(variant) {
  if (variant === 'a') {
    const segs = [];
    for (let db = -50; db <= 0; db += 1) segs.push({ dur: 0.1, db });
    return segs;
  }
  return [[1, -18], [2, -12], [2, -6], [2, -12], [1, -18]].map(([dur, db]) => ({ dur, db }));
}

function toneLevel(rec, start, len) {
  const w = 2 * Math.PI * TONE_HZ / rec.sr;
  let re = 0, im = 0;
  for (let i = 0; i < len; i++) {
    const x = rec.data[start + i];
    re += x * Math.cos(w * i); im -= x * Math.sin(w * i);
  }
  return ampToDb(2 * Math.hypot(re, im) / len);
}

class CompJob {
  constructor(variant, sr) {
    this.variant = variant;
    this.sr = sr;
    this.segs = plan(variant);
    this.bounds = [];
    let acc = 0;
    for (const s of this.segs) { acc += Math.round(s.dur * sr); this.bounds.push(acc); }
    this.toneFrames = acc;
    this.impulseAt = Math.round(IMPULSE_AT_S * sr);
    this.toneAt = Math.round(TONE_AT_S * sr);
    this.total = this.toneAt + this.toneFrames + Math.round(TAIL_S * sr);
    this.rec = new Float32Array(this.total);
    this.frame = 0;
    this.captureFrame = 0;
    this.seg = 0;
    this.chunks = 0;
    this.fade = Math.round(FADE_S * sr);
    this.amps = this.segs.map((s) => dbToAmp(s.db));
  }

  get done() { return this.frame >= this.total; }

  // Output sample for job frame f; must be called with increasing f
  sample(f) {
    if (f === this.impulseAt) return IMPULSE_AMP;
    const t = f - this.toneAt;
    if (t < 0 || t >= this.toneFrames) return 0;
    while (t >= this.bounds[this.seg]) this.seg++;
    const g = Math.min(1, t / this.fade, (this.toneFrames - 1 - t) / this.fade);
    return this.amps[this.seg] * g * Math.sin(2 * Math.PI * TONE_HZ * t / this.sr);
  }

  analyse() {
    const { rec, sr } = this;
    const hi = this.toneAt - Math.round(0.05 * sr);
    let peak = 0, pi = 0;
    for (let i = this.impulseAt; i < hi; i++) {
      const a = Math.abs(rec[i]);
      if (a > peak) { peak = a; pi = i; }
    }
    let latency;
    if (peak >= 1e-4) {
      latency = pi - this.impulseAt;
    } else {
      // Some hardware or mixer paths pass the tone but swallow a one-sample click.
      // Fall back to the returned tone's onset so the sustained test remains usable.
      const hop = Math.max(1, Math.round(0.005 * sr));
      const threshold = 1e-4;
      const start = Math.max(0, this.toneAt - Math.round(0.1 * sr));
      const end = Math.min(rec.length - hop, this.toneAt + Math.round(0.5 * sr));
      for (let i = start; i <= end; i += hop) {
        let sum = 0;
        for (let j = 0; j < hop; j++) sum += rec[i + j] * rec[i + j];
        if (Math.sqrt(sum / hop) >= threshold) {
          latency = i - this.toneAt;
          break;
        }
      }
      if (latency == null) return { nosignal: true, peakDb: ampToDb(peak) };
      peak = Math.max(peak, Math.max(...rec.slice(start, end + hop).map(Math.abs)));
    }
    const peakDb = ampToDb(peak);
    const base = this.toneAt + latency;
    const r = { data: rec, sr };
    const out = { variant: this.variant, latencyMs: +(latency / sr * 1000).toFixed(1), sampleRate: sr };

    if (this.variant === 'a') {
      // Measure the last part of each step so the compressor has had time to settle
      const cycles = 40, len = Math.round(cycles * sr / TONE_HZ), off = Math.round(0.055 * sr);
      out.inDb = this.segs.map((s) => s.db);
      out.outDb = this.segs.map((s, k) => {
        const start = base + (k ? this.bounds[k - 1] : 0) + off;
        return +toneLevel(r, start, len).toFixed(2);
      });
    } else {
      const hop = Math.round(ENV_HOP_S * sr), count = Math.floor(this.toneFrames / hop);
      out.hopMs = ENV_HOP_S * 1000;
      out.inDb = this.segs.map((s) => ({ dur: s.dur, db: s.db }));
      out.outDb = Array.from({ length: count }, (_, i) => +toneLevel(r, base + i * hop, hop).toFixed(2));
    }
    return out;
  }
}

module.exports = { CompJob };
