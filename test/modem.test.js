import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.js';
import { encodeFrame, decodeFrame, MAX_PAYLOAD } from '../src/link/frame.js';
import {
  modulate, airtime, toneFrequency, Demodulator, SYMBOL_SECONDS, TONES, SYNC_TONE,
} from '../src/link/modem.js';

/** Gaussian noise from a seeded generator, so failures are reproducible. */
function gaussian(rng) {
  const u = Math.max(rng.next(), 1e-12), v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A simulated room: silence before and after, volume change, echoes and noise.
 * `snrDb` compares the direct sound with white noise across the whole spectrum.
 */
function room(signal, { sampleRate, lead = 0.2, tail = 0.4, gain = 1, snrDb = null, echoes = [], seed = 1 }) {
  const rng = createRng(seed);
  const start = Math.round(lead * sampleRate);
  const out = new Float32Array(start + signal.length + Math.round(tail * sampleRate));
  for (let i = 0; i < signal.length; i++) out[start + i] += signal[i] * gain;
  for (const e of echoes) {
    const d = Math.round(e.delay * sampleRate);
    for (let i = 0; i < signal.length && start + d + i < out.length; i++) out[start + d + i] += signal[i] * gain * e.gain;
  }
  if (snrDb !== null) {
    let power = 0;
    for (const s of signal) power += s * s;
    const noiseRms = Math.sqrt(power / signal.length) * gain / 10 ** (snrDb / 20);
    for (let i = 0; i < out.length; i++) out[i] += gaussian(rng) * noiseRms;
  }
  return out;
}

/** Push audio through a demodulator in blocks, as the browser would deliver it. */
function receive(audio, sampleRate, { block = 128, accept = (b) => decodeFrame(b) !== null } = {}) {
  const frames = [];
  const demod = new Demodulator({ sampleRate, accept, onFrame: (bytes, band) => frames.push({ bytes, band }) });
  for (let i = 0; i < audio.length; i += block) demod.push(audio.subarray(i, Math.min(i + block, audio.length)));
  return { frames, demod };
}

const frame = (type, ...payload) => encodeFrame(type, Uint8Array.from(payload));

test('tone plan: 18 tones per band, bands do not overlap, all tones below 6 kHz', () => {
  assert.equal(TONES, 18);
  assert.equal(SYNC_TONE, 17);
  const band0 = Array.from({ length: TONES }, (_, k) => toneFrequency(0, k));
  const band1 = Array.from({ length: TONES }, (_, k) => toneFrequency(1, k));
  assert.ok(Math.max(...band0) < Math.min(...band1));
  assert.ok(Math.min(...band0) >= 1000 && Math.max(...band1) < 6000);
  assert.equal(new Set([...band0, ...band1]).size, 36);
});

test('airtime grows with the frame and matches the generated audio', () => {
  const bytes = frame(5, 1, 2, 3);
  const audio = modulate(bytes, { sampleRate: 48000, band: 0 });
  assert.ok(Math.abs(audio.length / 48000 - airtime(bytes.length)) < 0.001);
  assert.ok(airtime(6) < 1.0, 'a move must take under a second');
  assert.ok(airtime(4) < airtime(6));
  assert.equal(SYMBOL_SECONDS > 0.03 && SYMBOL_SECONDS < 0.1, true);
  for (const s of audio) assert.ok(Math.abs(s) <= 1);
});

test('a clean frame decodes at common sample rates and in both bands', () => {
  for (const sampleRate of [48000, 44100, 16000]) {
    for (const band of [0, 1]) {
      const bytes = frame(5, 12, 0, 99);
      const { frames } = receive(room(modulate(bytes, { sampleRate, band }), { sampleRate }), sampleRate);
      assert.equal(frames.length, 1, `${sampleRate} Hz band ${band}`);
      assert.deepEqual(frames[0].bytes, bytes);
      assert.equal(frames[0].band, band);
    }
  }
});

test('every byte value and the longest frame survive', () => {
  const sampleRate = 48000;
  for (let base = 0; base < 256; base += MAX_PAYLOAD) {
    const payload = Uint8Array.from({ length: MAX_PAYLOAD }, (_, i) => (base + i) & 0xff);
    const bytes = encodeFrame(7, payload);
    const { frames } = receive(room(modulate(bytes, { sampleRate, band: 1 }), { sampleRate }), sampleRate);
    assert.equal(frames.length, 1, `payload starting at ${base}`);
    assert.deepEqual(frames[0].bytes, bytes);
  }
});

test('block size does not matter', () => {
  const sampleRate = 44100, bytes = frame(3, 1, 2, 3, 4);
  const audio = room(modulate(bytes, { sampleRate, band: 0 }), { sampleRate, lead: 0.137 });
  for (const block of [1, 100, 128, 512, 1024, 4096, audio.length]) {
    const { frames } = receive(audio, sampleRate, { block });
    assert.equal(frames.length, 1, `block ${block}`);
    assert.deepEqual(frames[0].bytes, bytes);
  }
});

test('frames survive noise as loud as the signal and louder', () => {
  const sampleRate = 48000;
  for (const snrDb of [10, 0, -6]) {
    let ok = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const bytes = frame(5, seed, 2, seed * 7);
      const audio = room(modulate(bytes, { sampleRate, band: seed % 2 }), { sampleRate, snrDb, seed });
      const { frames } = receive(audio, sampleRate);
      if (frames.length === 1 && frames[0].bytes.every((b, i) => b === bytes[i])) ok++;
      assert.ok(frames.length <= 1);
    }
    assert.ok(ok >= 9, `only ${ok}/10 frames at ${snrDb} dB`);
  }
});

test('frames survive a very quiet signal and a clipped loud one', () => {
  const sampleRate = 48000, bytes = frame(6, 1, 2, 3);
  const quiet = room(modulate(bytes, { sampleRate, band: 0 }), { sampleRate, gain: 0.002 });
  assert.equal(receive(quiet, sampleRate).frames.length, 1);
  const loud = room(modulate(bytes, { sampleRate, band: 0 }), { sampleRate, gain: 5 })
    .map((s) => Math.max(-1, Math.min(1, s)));
  assert.equal(receive(loud, sampleRate).frames.length, 1);
});

test('frames survive room echoes', () => {
  const sampleRate = 48000;
  const echoes = [{ delay: 0.009, gain: 0.6 }, { delay: 0.021, gain: 0.45 }, { delay: 0.047, gain: 0.3 }];
  let ok = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const bytes = frame(5, seed * 3, seed, 50 + seed);
    const audio = room(modulate(bytes, { sampleRate, band: seed % 2 }), { sampleRate, echoes, snrDb: 10, seed });
    const { frames } = receive(audio, sampleRate);
    if (frames.length === 1 && frames[0].bytes.every((b, i) => b === bytes[i])) ok++;
  }
  assert.ok(ok >= 9, `only ${ok}/10 frames with echoes`);
});

test('noise alone, silence and a steady whistle produce no frames', () => {
  const sampleRate = 48000, rng = createRng(4);
  const noise = Float32Array.from({ length: sampleRate * 4 }, () => gaussian(rng) * 0.3);
  assert.equal(receive(noise, sampleRate).frames.length, 0);
  assert.equal(receive(new Float32Array(sampleRate), sampleRate).frames.length, 0);
  const f = toneFrequency(0, SYNC_TONE);
  const whistle = Float32Array.from({ length: sampleRate * 3 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * f * i / sampleRate));
  assert.equal(receive(whistle, sampleRate).frames.length, 0);
});

test('a frame right after a long whistle on the sync tone still decodes', () => {
  const sampleRate = 48000, bytes = frame(5, 9, 9, 9);
  const f = toneFrequency(0, SYNC_TONE);
  const whistle = Float32Array.from({ length: sampleRate * 2 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * f * i / sampleRate));
  const signal = room(modulate(bytes, { sampleRate, band: 0 }), { sampleRate, lead: 0.5 });
  const audio = new Float32Array(whistle.length + signal.length);
  audio.set(whistle);
  audio.set(signal, whistle.length);
  const { frames } = receive(audio, sampleRate);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].bytes, bytes);
});

test('several frames in a row all arrive, in order', () => {
  const sampleRate = 48000;
  const list = [frame(5, 1, 0, 10), frame(6, 1, 64, 32), frame(4, 3), frame(7, 1, 2, 3, 4, 5, 6, 7, 8, 9)];
  const parts = list.map((bytes, i) => room(modulate(bytes, { sampleRate, band: i % 2 }), {
    sampleRate, lead: 0.15, tail: 0.15, snrDb: 15, seed: i + 1,
  }));
  const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { audio.set(p, at); at += p.length; }
  const { frames } = receive(audio, sampleRate);
  assert.deepEqual(frames.map((f) => [...f.bytes]), list.map((b) => [...b]));
  assert.deepEqual(frames.map((f) => f.band), [0, 1, 0, 1]);
});

test('two devices talking at once in different bands are both understood', () => {
  const sampleRate = 48000;
  const a = frame(5, 1, 2, 3), b = frame(6, 9, 8, 7);
  const first = room(modulate(a, { sampleRate, band: 0 }), { sampleRate, lead: 0.2, tail: 0.6 });
  const second = room(modulate(b, { sampleRate, band: 1 }), { sampleRate, lead: 0.33, tail: 0.47, gain: 0.5 });
  const audio = first.map((s, i) => s + (second[i] || 0));
  const { frames } = receive(audio, sampleRate);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.find((f) => f.band === 0).bytes, a);
  assert.deepEqual(frames.find((f) => f.band === 1).bytes, b);
});

test('a frame that fails the check is dropped and the next one still arrives', () => {
  const sampleRate = 48000;
  const good = frame(5, 4, 4, 4);
  const bad = Uint8Array.from(good);
  bad[2] ^= 0x10; // corrupt after the check was computed
  const audio = new Float32Array(sampleRate * 3);
  audio.set(modulate(bad, { sampleRate, band: 0 }), 4800);
  audio.set(modulate(good, { sampleRate, band: 0 }), sampleRate * 1.5);
  const { frames } = receive(audio, sampleRate);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].bytes, good);
});

test('the demodulator reports when the channel is busy and can be reset', () => {
  const sampleRate = 48000, bytes = frame(5, 1, 2, 3);
  const audio = room(modulate(bytes, { sampleRate, band: 0 }), { sampleRate, lead: 0.1, tail: 0.5 });
  const frames = [];
  const demod = new Demodulator({ sampleRate, accept: (b) => decodeFrame(b) !== null, onFrame: (b) => frames.push(b) });
  assert.equal(demod.busy, false);
  const half = Math.round((0.1 + airtime(bytes.length) / 2) * sampleRate);
  demod.push(audio.subarray(0, half));
  assert.equal(demod.busy, true);
  demod.reset();
  assert.equal(demod.busy, false);
  demod.push(audio.subarray(half));
  assert.equal(frames.length, 0, 'the second half alone is not a frame');
  demod.push(audio);
  assert.equal(frames.length, 1);
  assert.equal(demod.busy, false);
});

test('signal level is reported per band', () => {
  const sampleRate = 48000, bytes = frame(5, 1, 2, 3);
  const demod = new Demodulator({ sampleRate, accept: () => false, onFrame: () => {} });
  demod.push(new Float32Array(4800));
  assert.ok(demod.level(0) < 1e-6);
  const signal = modulate(bytes, { sampleRate, band: 1 });
  demod.push(signal.subarray(0, 9600));
  assert.ok(demod.level(1) > 0.05, `band 1 level ${demod.level(1)}`);
  assert.ok(demod.level(0) < demod.level(1) / 10);
});

test('measuring one band is not disturbed by decoding a frame in the other band', () => {
  const sampleRate = 48000, hop = 480;
  const bytes = frame(7, 1, 2, 3, 4, 5, 6, 7, 8, 9);
  const chirp = modulate(bytes, { sampleRate, band: 0 });
  const total = chirp.length + sampleRate;
  // Band 1 carries a tone that gets louder quickly while the frame arrives, so a
  // measurement taken from the wrong moment gives a visibly different level.
  const f = toneFrequency(1, 5);
  const loudness = (i) => Math.max(0, Math.min(0.6, (0.6 * (i - 4800)) / 24000));
  const ramp = Float32Array.from({ length: total }, (_, i) => loudness(i) * Math.sin(2 * Math.PI * f * i / sampleRate));
  const mixed = Float32Array.from(ramp);
  for (let i = 0; i < chirp.length; i++) mixed[4800 + i] += chirp[i];

  const alone = new Demodulator({ sampleRate, accept: () => false, onFrame: () => {} });
  const busy = new Demodulator({ sampleRate, accept: (b) => decodeFrame(b) !== null, onFrame: () => {} });
  let worst = 0;
  for (let i = 0; i + hop <= total; i += hop) {
    alone.push(ramp.subarray(i, i + hop));
    busy.push(mixed.subarray(i, i + hop));
    if (alone.level(1) > 0.15) worst = Math.max(worst, Math.abs(busy.level(1) - alone.level(1)) / alone.level(1));
  }
  assert.ok(worst < 0.02, `band 1 level was off by ${(worst * 100).toFixed(1)}% while band 0 was decoding`);
});
