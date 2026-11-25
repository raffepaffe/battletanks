import { modulate, airtime, Demodulator } from './modem.js';
import { decodeFrame, DEFAULT_KEY } from './frame.js';

/**
 * Carries frames as sound: speaker out, microphone in. This is the only part of
 * the link that needs a browser; the modem maths and the protocol are tested
 * without one.
 *
 * Implements the transport interface used by Session:
 *   send(bytes, band), airtime(byteLength), onFrame(bytes, band)
 */
const CAPTURE_WORKLET = `
class BattleTanksCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1024);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i];
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice());
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('battletanks-capture', BattleTanksCapture);
`;

/** The worklet may be registered only once per AudioContext, however often a transport starts. */
const captureLoaded = new WeakMap();
function loadCapture(ctx) {
  if (!captureLoaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
    captureLoaded.set(ctx, ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url)));
  }
  return captureLoaded.get(ctx);
}

const LISTEN_FIRST_MS = 1500;   // longest we hold a chirp back because someone else is talking
const OWN_ECHO_MS = 700;        // a frame in our own band this soon after sending is our own echo

export class AudioTransport {
  /** Why sound play cannot work here, or null if it can. */
  static unavailableReason() {
    if (!window.isSecureContext) return 'The microphone only works on a secure (https) page.';
    if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not give web pages access to the microphone.';
    if (!(window.AudioContext || window.webkitAudioContext)) return 'This browser cannot play generated sound.';
    return null;
  }

  /**
   * context: the page's AudioContext.
   * loopback: wire the output straight into the input instead of using speaker
   *   and microphone. Used to check the audio pipeline of a device by itself.
   */
  constructor({ context, echoCancellation = false, loopback = false, volume = 0.9 }) {
    this.context = context;
    this.echoCancellation = echoCancellation;
    this.loopback = loopback;
    this.volume = volume;
    this.onFrame = null;
    /** Optional: called with { type: 'tx' | 'rx' | 'idle', band, own, quality, level }. */
    this.onActivity = null;
    this._keys = new Set([DEFAULT_KEY]);
    this._queue = [];
    this._sending = false;
    this._lastSend = { band: -1, endedAt: -Infinity };
    this._started = false;
    this._stopped = false;
  }

  airtime(byteLength) {
    return airtime(byteLength);
  }

  /** Frames checked with this key are also accepted (the session key after pairing). */
  addKey(key) {
    this._keys.add(key);
  }

  level(band) {
    return this._demod ? this._demod.level(band) : 0;
  }

  async start() {
    if (this._started) return;
    const ctx = this.context;
    if (!this.loopback) {
      // iOS: without this the page may not be allowed to play and record together.
      try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* not supported */ }
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: this.echoCancellation,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    }
    if (ctx.state !== 'running') await ctx.resume();

    this._demod = new Demodulator({
      sampleRate: ctx.sampleRate,
      accept: (bytes) => [...this._keys].some((key) => decodeFrame(bytes, key) !== null),
      onFrame: (bytes, band, info) => this._received(bytes, band, info),
    });

    this._capture = await this._createCapture(ctx);
    // A node only runs while it leads to the speakers, so connect it through silence.
    this._silence = ctx.createGain();
    this._silence.gain.value = 0;
    this._capture.connect(this._silence).connect(ctx.destination);

    this._output = ctx.createGain();
    this._output.gain.value = this.volume;
    if (this.loopback) {
      this._output.connect(this._capture);
    } else {
      this._output.connect(ctx.destination);
      this._source = ctx.createMediaStreamSource(this._stream);
      this._source.connect(this._capture);
    }
    this._started = true;
    this._pump();   // anything queued while the microphone prompt was open
  }

  async _createCapture(ctx) {
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        await loadCapture(ctx);
        const node = new AudioWorkletNode(ctx, 'battletanks-capture');
        node.port.onmessage = (event) => this._demod?.push(event.data);
        return node;
      } catch { /* fall through to the older API */ }
    }
    const node = ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (event) => this._demod?.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    return node;
  }

  send(bytes, band) {
    if (this._stopped) return;
    this._queue.push({ bytes: Uint8Array.from(bytes), band, queuedAt: performance.now() });
    this._pump();
  }

  _pump() {
    if (this._stopped || this._sending || this._queue.length === 0 || !this._started) return;
    const next = this._queue[0];
    // Listen before talking: do not start a chirp on top of one that is arriving.
    if (this._demod.busy && performance.now() - next.queuedAt < LISTEN_FIRST_MS) {
      setTimeout(() => this._pump(), 60);
      return;
    }
    this._queue.shift();
    const ctx = this.context;
    const samples = modulate(next.bytes, { sampleRate: ctx.sampleRate, band: next.band });
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this._output);

    this._sending = true;
    this._lastSend = { band: next.band, endedAt: Infinity };
    this.onActivity?.({ type: 'tx', band: next.band });
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      this._sending = false;
      this._lastSend = { band: next.band, endedAt: performance.now() };
      this.onActivity?.({ type: 'idle' });
      setTimeout(() => this._pump(), 80);
    };
    source.onended = done;
    setTimeout(done, (samples.length / ctx.sampleRate) * 1000 + 400);   // in case "ended" never fires
    source.start();
  }

  _received(bytes, band, info) {
    const own = band === this._lastSend.band && performance.now() - this._lastSend.endedAt < OWN_ECHO_MS;
    this.onActivity?.({ type: 'rx', band, own, quality: info.quality, level: info.level, bytes });
    // Our own chirps are reported for diagnostics but never delivered as received frames.
    if (!own) this.onFrame?.(bytes, band);
  }

  stop() {
    this._stopped = true;
    this._queue = [];
    for (const node of [this._source, this._capture, this._silence, this._output]) {
      try { node?.disconnect(); } catch { /* already gone */ }
    }
    if (this._capture?.port) this._capture.port.onmessage = null;
    if (this._capture && 'onaudioprocess' in this._capture) this._capture.onaudioprocess = null;
    for (const track of this._stream?.getTracks() ?? []) track.stop();
    this._demod = null;
  }
}

/**
 * Stand-in for sound between two tabs of the same browser, for trying the
 * two-player game on one computer (open the game with ?link=tabs in two tabs).
 */
export class TabTransport {
  constructor({ channel = 'battletanks-link', speed = 0.3 } = {}) {
    this.onFrame = null;
    this.onActivity = null;
    this._speed = speed;
    this._busyUntil = 0;
    this._channel = new BroadcastChannel(channel);
    this._channel.onmessage = (event) => {
      this.onActivity?.({ type: 'rx', band: event.data.band, own: false, quality: 1, level: 1 });
      this.onFrame?.(Uint8Array.from(event.data.bytes), event.data.band);
    };
  }

  static unavailableReason() {
    return 'BroadcastChannel' in window ? null : 'This browser cannot connect two tabs.';
  }

  async start() { /* nothing to set up */ }
  addKey() { /* every frame is passed on; the session checks the key */ }
  level() { return 0; }
  airtime(byteLength) { return airtime(byteLength) * this._speed; }

  send(bytes, band) {
    const start = Math.max(performance.now(), this._busyUntil);
    this._busyUntil = start + this.airtime(bytes.length) * 1000;
    this.onActivity?.({ type: 'tx', band });
    setTimeout(() => {
      this._channel?.postMessage({ bytes: [...bytes], band });
      this.onActivity?.({ type: 'idle' });
    }, this._busyUntil - performance.now());
  }

  stop() {
    this._channel?.close();
    this._channel = null;
  }
}
