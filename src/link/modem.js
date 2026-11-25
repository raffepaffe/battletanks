import { frameBytes, MAX_FRAME_BYTES } from './frame.js';

/**
 * The sound modem: turns frame bytes into a short chirp and back.
 *
 * Each device sends in its own band of 18 tones, 100 Hz apart: 17 data tones and
 * one sync tone. A chirp is the sync tone for two symbols, then one tone per four
 * bits (60 ms each). The tone for a symbol is chosen relative to the previous
 * tone so that two neighbouring symbols never use the same tone, which keeps the
 * symbol boundaries visible to the receiver and lets it ignore the echo of the
 * previous tone.
 *
 * The receiver measures each tone over a 40 ms window in the middle of the
 * symbol. With that window, tones 100 Hz apart do not leak into each other, and
 * band 1 is shifted by 50 Hz so that overtones of band 0 fall between its tones.
 *
 * This file is pure maths on sample arrays so it can be tested without a browser.
 */
export const SYMBOL_SECONDS = 0.06;
export const WINDOW_SECONDS = 0.04;
export const PREAMBLE_SYMBOLS = 2;
export const TONES = 18;
export const DATA_TONES = 17;
export const SYNC_TONE = 17;
export const TONE_SPACING = 100;
export const BAND_BASE = [1500, 3550];

const HOP_SECONDS = 0.01;
const RAMP_SECONDS = 0.005;
const SYNC_HOPS = 4;           // consecutive hops of sync tone needed to start a frame
const SYNC_SHARE = 0.55;       // share of the band's energy the sync tone must hold
const MIN_AMPLITUDE = 2e-5;
const JAM_SECONDS = 0.4;       // a "sync tone" this long is a whistle, not a preamble
const TIMING_OFFSETS_MS = [0, -4, 4, -8, 8, -12, 12, -16, 16, -20, 20];

export const toneFrequency = (band, tone) => BAND_BASE[band] + tone * TONE_SPACING;

/** Seconds of sound for a frame of the given length in bytes. */
export const airtime = (byteLength) => (PREAMBLE_SYMBOLS + 2 * byteLength) * SYMBOL_SECONDS;

/** Tone numbers for a frame: preamble, then two symbols per byte, high half first. */
export function frameTones(bytes) {
  const tones = new Array(PREAMBLE_SYMBOLS).fill(SYNC_TONE);
  let prev = DATA_TONES - 1;
  for (const byte of bytes) {
    for (const nibble of [byte >> 4, byte & 0x0f]) {
      prev = (prev + 1 + nibble) % DATA_TONES;
      tones.push(prev);
    }
  }
  return tones;
}

/** Audio samples (-1..1) for a frame. */
export function modulate(bytes, { sampleRate, band, amplitude = 0.8 }) {
  const tones = frameTones(bytes);
  const perSymbol = SYMBOL_SECONDS * sampleRate;
  const total = Math.round(tones.length * perSymbol);
  const ramp = Math.max(1, Math.round(RAMP_SECONDS * sampleRate));
  const out = new Float32Array(total);
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const tone = tones[Math.min(tones.length - 1, Math.floor(i / perSymbol))];
    phase += (2 * Math.PI * toneFrequency(band, tone)) / sampleRate;
    const edge = Math.min(i, total - 1 - i);
    const envelope = edge < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / ramp) : 1;
    out[i] = amplitude * envelope * Math.sin(phase);
  }
  return out;
}

/**
 * Streaming receiver. Feed it microphone samples with push(); it calls
 * onFrame(bytes, band, info) for every frame that `accept(bytes, band)` approves.
 * `accept` is where the checksum is verified; the demodulator uses it to pick the
 * right symbol timing among a few candidates.
 */
export class Demodulator {
  constructor({ sampleRate, accept, onFrame }) {
    this.sampleRate = sampleRate;
    this.accept = accept;
    this.onFrame = onFrame;
    this._perSymbol = SYMBOL_SECONDS * sampleRate;
    this._win = Math.round(WINDOW_SECONDS * sampleRate);
    this._hop = Math.max(1, Math.round(HOP_SECONDS * sampleRate));
    this._capacity = Math.ceil(sampleRate * (airtime(MAX_FRAME_BYTES) + 1.5));
    this._buf = new Float32Array(this._capacity);
    this._tmp = new Float32Array(this._win);
    this._hann = new Float32Array(this._win);
    let weight = 0;
    for (let i = 0; i < this._win; i++) {
      this._hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / this._win);
      weight += this._hann[i];
    }
    this._scale = 2 / weight;
    this._coeff = BAND_BASE.map((_, band) => Float64Array.from(
      { length: TONES }, (__, tone) => 2 * Math.cos((2 * Math.PI * toneFrequency(band, tone)) / sampleRate),
    ));
    this._power = new Float64Array(TONES);
    this._offsets = TIMING_OFFSETS_MS.map((ms) => Math.round((ms / 1000) * sampleRate));
    this._total = 0;
    this._nextHop = this._win;
    this._bands = BAND_BASE.map(() => ({ mode: 'idle', hops: 0, level: 0 }));
  }

  /** True while a chirp is being received in either band. */
  get busy() {
    return this._bands.some((b) => b.mode !== 'idle');
  }

  /** Amplitude (0..1) of the strongest tone in a band at the latest measurement. */
  level(band) {
    return this._bands[band].level;
  }

  /** Forget any chirp in progress, for example after transmitting ourselves. */
  reset() {
    for (const b of this._bands) { b.mode = 'idle'; b.hops = 0; b.level = 0; }
    this._nextHop = this._total + this._win;
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this._buf[this._total % this._capacity] = samples[i];
      this._total++;
      if (this._total === this._nextHop) {
        this._nextHop += this._hop;
        this._measure(this._total);
      }
    }
  }

  _measure(end) {
    for (let band = 0; band < this._bands.length; band++) {
      // Reload for every band: decoding a frame in one band reuses the same buffers.
      this._load(end - this._win);
      this._tonePowers(band);
      this._step(band, end);
    }
  }

  /** Copy a window starting at an absolute sample position into _tmp, Hann-weighted. */
  _load(start) {
    const { _buf: buf, _tmp: tmp, _hann: hann, _capacity: cap } = this;
    let at = ((start % cap) + cap) % cap;
    for (let i = 0; i < tmp.length; i++) {
      tmp[i] = buf[at] * hann[i];
      if (++at === cap) at = 0;
    }
  }

  /** Goertzel filter for each tone of a band over the loaded window. */
  _tonePowers(band) {
    const tmp = this._tmp, coeffs = this._coeff[band], power = this._power;
    for (let tone = 0; tone < TONES; tone++) {
      const c = coeffs[tone];
      let s1 = 0, s2 = 0;
      for (let i = 0; i < tmp.length; i++) {
        const s0 = tmp[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      power[tone] = Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2);
    }
  }

  _step(band, end) {
    const state = this._bands[band], power = this._power;
    let sum = 0, best = 0;
    for (let tone = 0; tone < TONES; tone++) {
      sum += power[tone];
      if (power[tone] > power[best]) best = tone;
    }
    state.level = Math.sqrt(power[best]) * this._scale;
    const syncAmplitude = Math.sqrt(power[SYNC_TONE]) * this._scale;
    const syncNow = sum > 0 && power[SYNC_TONE] >= SYNC_SHARE * sum && syncAmplitude > MIN_AMPLITUDE;

    if (state.mode === 'jam') {
      state.hops = syncNow ? 0 : state.hops + 1;
      if (state.hops >= SYNC_HOPS) { state.mode = 'idle'; state.hops = 0; }
      return;
    }

    if (state.mode === 'sync') {
      if (best !== SYNC_TONE) {
        // The window is now more data than preamble: the first symbol started about half a window ago.
        state.mode = 'collect';
        state.t0 = end - Math.round(this._win / 2) - Math.round(this._hop / 2);
        state.deadline = state.t0 + Math.round(airtime(MAX_FRAME_BYTES) * this.sampleRate);
        state.candidates = this._offsets.map((offset) => ({ start: state.t0 + offset, need: null, done: false }));
        state.hops = 0;
      } else if (end - state.since > JAM_SECONDS * this.sampleRate) {
        state.mode = 'jam';
        state.hops = 0;
      }
      return;
    }

    // idle or collect: watch for a preamble. During collect a new preamble means a new frame.
    state.hops = syncNow ? state.hops + 1 : 0;
    if (state.hops >= SYNC_HOPS) {
      state.mode = 'sync';
      state.since = end;
      state.hops = 0;
      return;
    }
    if (state.mode === 'collect') this._collect(band, state, end);
  }

  _collect(band, state, end) {
    let waiting = false;
    for (const cand of state.candidates) {
      if (cand.done) continue;
      if (cand.need === null) {
        if (end < cand.start + 2 * this._perSymbol) { waiting = true; continue; }
        const header = this._decode(band, cand.start, 1);
        if (!header) { cand.done = true; continue; }
        cand.need = cand.start + Math.round(2 * frameBytes(header.bytes[0]) * this._perSymbol);
      }
      if (end < cand.need) { waiting = true; continue; }
      cand.done = true;
      const decoded = this._decode(band, cand.start, Math.round((cand.need - cand.start) / (2 * this._perSymbol)));
      if (decoded && this.accept(decoded.bytes, band)) {
        state.mode = 'idle';
        state.hops = 0;
        this.onFrame(decoded.bytes, band, { quality: decoded.quality, level: decoded.level });
        return;
      }
    }
    if (!waiting || end > state.deadline) { state.mode = 'idle'; state.hops = 0; }
  }

  /** Read `byteCount` bytes whose first symbol starts at absolute sample `start`. */
  _decode(band, start, byteCount) {
    const bytes = new Uint8Array(byteCount), power = this._power;
    const half = this._win / 2;
    let prev = DATA_TONES - 1, clarity = 0, loudness = 0;
    for (let symbol = 0; symbol < byteCount * 2; symbol++) {
      const centre = start + (symbol + 0.5) * this._perSymbol;
      const from = Math.round(centre - half);
      if (from < this._total - this._capacity || from < 0) return null;
      this._load(from);
      this._tonePowers(band);
      let best = -1, sum = 0;
      for (let tone = 0; tone < DATA_TONES; tone++) {
        sum += power[tone];
        if (tone !== prev && (best === -1 || power[tone] > power[best])) best = tone;
      }
      const nibble = (best - prev - 1 + DATA_TONES) % DATA_TONES;
      if (nibble > 15) return null;
      if (symbol % 2 === 0) bytes[symbol >> 1] = nibble << 4;
      else bytes[symbol >> 1] |= nibble;
      clarity += sum > 0 ? power[best] / sum : 0;
      loudness += Math.sqrt(power[best]) * this._scale;
      prev = best;
    }
    const symbols = byteCount * 2;
    return { bytes, quality: clarity / symbols, level: loudness / symbols };
  }
}
