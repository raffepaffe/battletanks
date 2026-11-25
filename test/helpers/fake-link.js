import { airtime } from '../../src/link/modem.js';

/** Flush promise callbacks. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A clock under test control, with the timer functions a Session needs. */
export class FakeClock {
  constructor() {
    this.now = 0;
    this._timers = [];
    this._id = 0;
    this.timers = {
      setTimeout: (fn, ms) => {
        const id = ++this._id;
        this._timers.push({ id, at: this.now + Math.max(0, ms), fn });
        return id;
      },
      clearTimeout: (id) => { this._timers = this._timers.filter((t) => t.id !== id); },
    };
  }

  get pending() { return this._timers.length; }

  /** Run the next timer, if it is due at or before `limit`. */
  async _next(limit) {
    if (this._timers.length === 0) return false;
    let first = this._timers[0];
    for (const t of this._timers) if (t.at < first.at) first = t;
    if (first.at > limit) return false;
    this._timers = this._timers.filter((t) => t !== first);
    this.now = first.at;
    first.fn();
    await settle();
    return true;
  }

  async advance(ms) {
    const limit = this.now + ms;
    await settle();
    while (await this._next(limit));
    this.now = limit;
  }

  /** Run timers until `done()` is true. Fails if that takes more than `maxMs` of fake time. */
  async until(done, maxMs = 120000) {
    const limit = this.now + maxMs;
    await settle();
    while (!done()) {
      if (!(await this._next(limit))) throw new Error(`condition not reached within ${maxMs} ms of fake time`);
    }
  }
}

/**
 * Two transports joined by an imaginary room. Sound takes its real airtime.
 * `lose(frame)` decides which frames vanish; `halfDuplex` makes a device deaf
 * while it is transmitting itself, the worst case for a real speaker and mic.
 */
export function createLink(clock, { lose = () => false, halfDuplex = true } = {}) {
  const sent = [];
  const make = (name) => ({
    name,
    onFrame: null,
    peer: null,
    busyUntil: 0,
    talking: [],
    airtime,
    send(bytes, band) {
      const start = Math.max(clock.now, this.busyUntil);
      const end = start + airtime(bytes.length) * 1000;
      this.busyUntil = end;
      this.talking.push([start, end]);
      const frame = { from: name, bytes: Uint8Array.from(bytes), band, start, end, index: sent.length };
      sent.push(frame);
      clock.timers.setTimeout(() => {
        if (lose(frame)) { frame.lost = true; return; }
        const peer = this.peer;
        if (halfDuplex && peer.talking.some(([s, e]) => s < end && e > start)) { frame.collided = true; return; }
        peer.onFrame?.(frame.bytes, band);
      }, end - clock.now);
    },
  });
  const a = make('a'), b = make('b');
  a.peer = b;
  b.peer = a;
  return { a, b, sent };
}
