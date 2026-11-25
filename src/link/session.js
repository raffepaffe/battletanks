import { encodeFrame, decodeFrame, DEFAULT_KEY } from './frame.js';
import * as M from './messages.js';

/** Bump when the frames, messages or tone plan change in an incompatible way. */
export const PROTO = 1;

const REPLY_DELAY_MS = 150;     // let the other speaker fall silent before answering
const TROUBLE_AFTER = 3;        // unanswered tries before the UI is told
const SLOW_AFTER = 6;           // after this many tries, back off
const MAX_WAIT_MS = 8000;
const ACK_BYTES = 4;
const RESULT_BYTES = 8;         // a typical report: three bytes plus one destroyed unit

/** The check key two paired devices share, derived from the pairing nonce. */
export function sessionKey(nonce) {
  const key = (Math.imul(nonce, 0x9e37) + 0x1b3d) & 0xffff;
  return key === DEFAULT_KEY ? 0x5a5a : key;
}

/**
 * The conversation between two devices, independent of how frames travel.
 *
 * Pairing: both devices listen; one calls by repeating HELLO with a random
 * nonce until it hears WELCOME. The nonce becomes the terrain seed and the key
 * for all later frames. The caller sends in band 0, the answerer in band 1.
 *
 * After pairing every message that matters is repeated until it is confirmed:
 * READY and REVEAL by an ACK, an ACTION by its RESULT. The receiving side
 * answers repeats from memory, so a handler runs once per turn however often
 * the chirp had to be sent.
 *
 * transport: { send(bytes, band), airtime(byteLength) -> seconds, onFrame }
 * Events: state, paired, version, trouble, recovered, fault.
 */
export class Session {
  constructor({ transport, timers = globalThis, random = Math.random, onEvent = () => {}, proto = PROTO }) {
    this.transport = transport;
    this.onEvent = onEvent;
    this.onAction = null;
    this.state = 'idle';
    this.role = null;
    this.seed = null;
    this.turn = 0;
    this._timers = timers;
    this._random = random;
    this._proto = proto;
    this._key = DEFAULT_KEY;
    this._pending = new Map();
    this._replyTimers = new Set();
    this._helloTimer = null;
    this._answered = null;
    this._welcome = null;
    this._troubled = false;
    this._ready = deferred();
    this._reveal = deferred();
    this.whenPeerReady = this._ready.promise;
    this.whenPeerReveal = this._reveal.promise;
    transport.onFrame = (bytes, band) => this._onFrame(bytes, band);
  }

  /** True if this device takes the first turn. Decided by the nonce, so both sides agree. */
  get meFirst() {
    const callerFirst = (this.seed & 1) === 1;
    return this.role === 0 ? callerFirst : !callerFirst;
  }

  listen() {
    this._alive();
    if (this.state === 'idle') this._setState('listening');
  }

  call() {
    this._alive();
    if (this.state !== 'idle' && this.state !== 'listening') throw new Error('already connected');
    this._nonce = 1 + Math.floor(this._random() * 65535);
    this._setState('calling');
    this._hello();
  }

  close() {
    if (this.state === 'closed') return;
    this._clearHello();
    for (const id of this._replyTimers) this._timers.clearTimeout(id);
    this._replyTimers.clear();
    const error = new Error('the link was closed');
    for (const entry of this._pending.values()) {
      this._timers.clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
    this._ready.reject(error);
    this._reveal.reject(error);
    if (this.transport.onFrame) this.transport.onFrame = null;
    this._setState('closed');
  }

  /** Tell the other device our fleet is placed. Resolves once it has heard. */
  sendReady(commit) {
    this._paired();
    return this._reliable('ready', M.READY, M.encodeReady(commit), ACK_BYTES);
  }

  /** Send one of our actions. Resolves with the other device's report. */
  sendAction(action) {
    try {
      this._paired();
      if (!this._myTurn()) throw new Error('it is not our turn');
      if (this._pending.has('action')) throw new Error('still waiting for the last report of this turn');
      return this._reliable('action', M.ACTION, M.encodeAction(this.turn, action), RESULT_BYTES,
        { action, turn: this.turn });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Reveal our fleet after the battle. Resolves once the other device has it. */
  sendReveal({ layout, salt }) {
    this._paired();
    return this._reliable('reveal', M.REVEAL, M.encodeReveal({ layout, salt }), ACK_BYTES);
  }

  // --- pairing -------------------------------------------------------------

  _hello() {
    const bytes = encodeFrame(M.HELLO, M.encodeHello({ nonce: this._nonce, proto: this._proto }));
    this.transport.send(bytes, 0);
    // The pause varies by more than a chirp's length, so two devices that call at the
    // same moment drift apart instead of talking over each other for ever.
    const wait = this.transport.airtime(bytes.length) * 1000 + 800 + this._random() * 2000;
    this._helloTimer = this._timers.setTimeout(() => this._hello(), wait);
  }

  _clearHello() {
    if (this._helloTimer !== null) this._timers.clearTimeout(this._helloTimer);
    this._helloTimer = null;
  }

  _onPairingFrame(frame, band) {
    if (frame.type === M.HELLO && band === 0) {
      const hello = M.decodeHello(frame.payload);
      if (!hello) return;
      // If both devices call at once, the one with the lower nonce gives way.
      // An equal nonce is our own chirp coming back from the room.
      if (this.state === 'calling' && hello.nonce <= this._nonce) return;
      this._clearHello();
      this._welcome = encodeFrame(M.WELCOME, M.encodeWelcome({ nonce: hello.nonce, proto: this._proto }));
      this._reply(this._welcome, 1);
      if (hello.proto !== this._proto) return this._mismatch(hello.proto);
      this._pair(1, hello.nonce);
    } else if (frame.type === M.WELCOME && band === 1 && this.state === 'calling') {
      const welcome = M.decodeWelcome(frame.payload);
      if (!welcome || welcome.nonce !== this._nonce) return;
      this._clearHello();
      if (welcome.proto !== this._proto) return this._mismatch(welcome.proto);
      this._pair(0, this._nonce);
    }
  }

  _pair(role, nonce) {
    this.role = role;
    this.seed = nonce;
    this._key = sessionKey(nonce);
    this.transport.addKey?.(this._key);
    this._setState('paired');
    this.onEvent({ type: 'paired', role, seed: nonce, meFirst: this.meFirst });
  }

  _mismatch(theirs) {
    this._setState('mismatch');
    this.onEvent({ type: 'version', ours: this._proto, theirs });
  }

  // --- frames in ------------------------------------------------------------

  _onFrame(bytes, band) {
    if (this.state === 'listening' || this.state === 'calling') {
      const frame = decodeFrame(bytes, DEFAULT_KEY);
      if (frame) this._onPairingFrame(frame, band);
      return;
    }
    if (this.state !== 'paired' || band !== 1 - this.role) return;

    const frame = decodeFrame(bytes, this._key);
    if (!frame) {
      // The caller repeats HELLO until our WELCOME gets through.
      const early = this.role === 1 ? decodeFrame(bytes, DEFAULT_KEY) : null;
      if (early && early.type === M.HELLO && M.decodeHello(early.payload)?.nonce === this.seed) {
        this._reply(this._welcome, 1);
      }
      return;
    }
    switch (frame.type) {
      case M.READY: return this._onReady(frame.payload);
      case M.ACK: return this._onAck(frame.payload);
      case M.ACTION: return this._onActionFrame(frame.payload);
      case M.RESULT: return this._onResult(frame.payload);
      case M.REVEAL: return this._onReveal(frame.payload);
      default: return undefined;
    }
  }

  _onReady(payload) {
    const commit = M.decodeReady(payload);
    if (commit === null) return;
    this._ready.resolve(commit);
    this._reply(encodeFrame(M.ACK, M.encodeAck(M.READY), this._key));
  }

  _onReveal(payload) {
    const reveal = M.decodeReveal(payload);
    if (!reveal) return;
    this._reveal.resolve(reveal);
    this._reply(encodeFrame(M.ACK, M.encodeAck(M.REVEAL), this._key));
  }

  _onAck(payload) {
    const type = M.decodeAck(payload);
    if (type === M.READY) this._settle('ready');
    else if (type === M.REVEAL) this._settle('reveal');
  }

  _onActionFrame(payload) {
    const message = M.decodeAction(payload);
    if (!message) return;
    if (this._answered && message.turn === this._answered.turn) {
      this._reply(this._answered.bytes);
      return;
    }
    if (message.turn !== this.turn || this._myTurn() || !this.onAction) return;
    // The other device only attacks once it has our fingerprint, whatever happened to its ACK.
    this._settle('ready');
    let result;
    try {
      result = this.onAction(message.action);
    } catch (error) {
      this.onEvent({ type: 'fault', message: `The other device sent an impossible move: ${error.message}` });
      return;
    }
    const bytes = encodeFrame(M.RESULT, M.encodeResult(message.turn, result), this._key);
    this._answered = { turn: message.turn, bytes };
    this.turn++;
    this._reply(bytes);
  }

  _onResult(payload) {
    const entry = this._pending.get('action');
    if (!entry || M.resultTurn(payload) !== entry.turn) return;
    const result = M.decodeResult(payload, entry.action);
    if (!result) return;
    this.turn++;
    this._settle('action', result);
  }

  // --- frames out -------------------------------------------------------------

  _reply(bytes, band = this.role) {
    const id = this._timers.setTimeout(() => {
      this._replyTimers.delete(id);
      this.transport.send(bytes, band);
    }, REPLY_DELAY_MS);
    this._replyTimers.add(id);
  }

  _reliable(name, type, payload, replyBytes, extra = {}) {
    const existing = this._pending.get(name);
    if (existing) return existing.promise;
    const d = deferred();
    const entry = {
      ...extra, name, bytes: encodeFrame(type, payload, this._key), replyBytes, tries: 0, timer: null,
      promise: d.promise, resolve: d.resolve, reject: d.reject,
    };
    this._pending.set(name, entry);
    this._transmit(entry);
    return entry.promise;
  }

  _transmit(entry) {
    if (this._pending.get(entry.name) !== entry) return;
    entry.tries++;
    if (entry.tries === TROUBLE_AFTER + 1 && !this._troubled) {
      this._troubled = true;
      this.onEvent({ type: 'trouble' });
    }
    this.transport.send(entry.bytes, this.role);
    const air = this.transport.airtime(entry.bytes.length) + this.transport.airtime(entry.replyBytes);
    let wait = air * 1000 + REPLY_DELAY_MS + 500 + this._random() * 700;
    // Both devices may repeat at the same moment (both reveal when the battle ends).
    // The answerer always waits one chirp longer, so the repeats cannot stay in step.
    if (this.role === 1) wait += this.transport.airtime(entry.bytes.length) * 1000 + 800;
    if (entry.tries > SLOW_AFTER) wait = Math.min(MAX_WAIT_MS, wait * 1.5 ** (entry.tries - SLOW_AFTER));
    entry.timer = this._timers.setTimeout(() => this._transmit(entry), wait);
  }

  _settle(name, value) {
    const entry = this._pending.get(name);
    if (!entry) return;
    this._timers.clearTimeout(entry.timer);
    this._pending.delete(name);
    if (this._troubled && ![...this._pending.values()].some((e) => e.tries > TROUBLE_AFTER)) {
      this._troubled = false;
      this.onEvent({ type: 'recovered' });
    }
    entry.resolve(value);
  }

  // --- helpers ------------------------------------------------------------------

  _myTurn() {
    return (this.turn % 2 === 0) === this.meFirst;
  }

  _alive() {
    if (this.state === 'closed') throw new Error('the link was closed');
  }

  _paired() {
    this._alive();
    if (this.state !== 'paired') throw new Error('not connected to another device yet');
  }

  _setState(state) {
    this.state = state;
    this.onEvent({ type: 'state', state });
  }
}

/** A promise with its resolve and reject, safe to leave unobserved. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
