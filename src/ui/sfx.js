/**
 * Sound effects, synthesised on the fly so the game ships no audio files.
 *
 * Everything passes through a low-pass filter. During a sound-link game it is
 * closed down to 700 Hz so that explosions stay far below the modem tones
 * (1500 Hz and up) and cannot corrupt a chirp.
 */
const STORAGE_KEY = 'battletanks.muted';

let sharedContext = null;

/** The page's single AudioContext. Must first be called from a tap or click. */
export function audioContext() {
  if (!sharedContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    sharedContext = new Ctor({ latencyHint: 'interactive' });
  }
  if (sharedContext.state === 'suspended') sharedContext.resume().catch(() => {});
  return sharedContext;
}

export class Sfx {
  constructor() {
    this.muted = false;
    try { this.muted = localStorage.getItem(STORAGE_KEY) === '1'; } catch { /* private mode */ }
    this._linkSafe = false;
    this._out = null;
    this._noise = null;
  }

  setMuted(muted) {
    this.muted = muted;
    try { localStorage.setItem(STORAGE_KEY, muted ? '1' : '0'); } catch { /* private mode */ }
  }

  /** Keep effects out of the modem's frequency range. */
  setLinkSafe(on) {
    this._linkSafe = on;
    if (this._filters) for (const f of this._filters) f.frequency.value = on ? 700 : 3800;
  }

  /** Call from a user gesture so later sounds are allowed to play. */
  unlock() {
    this._output();
  }

  _output() {
    const ctx = audioContext();
    if (!ctx) return null;
    if (!this._out) {
      const gain = ctx.createGain();
      gain.gain.value = 0.7;
      this._filters = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
      for (const f of this._filters) {
        f.type = 'lowpass';
        f.Q.value = 0.5;
        f.frequency.value = this._linkSafe ? 700 : 3800;
      }
      gain.connect(this._filters[0]).connect(this._filters[1]).connect(ctx.destination);
      this._out = gain;
      const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this._noise = noise;
    }
    return ctx;
  }

  _tone({ type = 'sine', from, to = from, seconds, volume = 0.5, delay = 0 }) {
    if (this.muted) return;
    const ctx = this._output();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + seconds);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(gain).connect(this._out);
    osc.start(t);
    osc.stop(t + seconds + 0.05);
  }

  _rumble({ seconds, volume = 0.6, cutoff = 600, delay = 0 }) {
    if (this.muted) return;
    const ctx = this._output();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    src.buffer = this._noise;
    src.loop = true;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, cutoff / 6), t + seconds);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    src.connect(filter).connect(gain).connect(this._out);
    src.start(t);
    src.stop(t + seconds + 0.05);
  }

  click() { this._tone({ type: 'triangle', from: 520, to: 360, seconds: 0.06, volume: 0.25 }); }
  blip() { this._tone({ type: 'triangle', from: 440, to: 660, seconds: 0.14, volume: 0.3 }); }
  place() { this._tone({ type: 'square', from: 140, to: 90, seconds: 0.09, volume: 0.25 }); }
  error() { this._tone({ type: 'sawtooth', from: 160, to: 110, seconds: 0.18, volume: 0.25 }); }

  fire() {
    this._tone({ from: 170, to: 45, seconds: 0.28, volume: 0.8 });
    this._rumble({ seconds: 0.22, volume: 0.5, cutoff: 900 });
  }

  explosion(scale = 1) {
    this._tone({ from: 110, to: 30, seconds: 0.5 * scale, volume: 0.9 });
    this._rumble({ seconds: 0.7 * scale, volume: 0.8, cutoff: 700 });
  }

  miss() {
    this._tone({ from: 90, to: 50, seconds: 0.18, volume: 0.45 });
    this._rumble({ seconds: 0.25, volume: 0.3, cutoff: 350 });
  }

  plane() {
    this._tone({ type: 'sawtooth', from: 70, to: 110, seconds: 0.9, volume: 0.35 });
    this._tone({ type: 'sawtooth', from: 110, to: 60, seconds: 0.9, volume: 0.35, delay: 0.85 });
  }

  drone() {
    for (let i = 0; i < 10; i++) {
      this._tone({ type: 'square', from: 190 + (i % 2) * 14, seconds: 0.2, volume: 0.12, delay: i * 0.2 });
    }
  }

  win() {
    [262, 330, 392, 523].forEach((f, i) => this._tone({ type: 'triangle', from: f, seconds: 0.32, volume: 0.4, delay: i * 0.16 }));
  }

  lose() {
    [330, 294, 262, 196].forEach((f, i) => this._tone({ type: 'triangle', from: f, seconds: 0.4, volume: 0.35, delay: i * 0.22 }));
  }
}
