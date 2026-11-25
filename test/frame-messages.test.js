import test from 'node:test';
import assert from 'node:assert/strict';
import { H, V, cellAt } from '../src/core/grid.js';
import { SHELL, STRIKE, SCOUT, SKIP, MISS, HIT } from '../src/core/board.js';
import { crc16 } from '../src/link/crc.js';
import { encodeFrame, decodeFrame, frameBytes, DEFAULT_KEY, MAX_PAYLOAD } from '../src/link/frame.js';
import * as M from '../src/link/messages.js';

test('crc16 matches the CCITT reference value and depends on the start value', () => {
  const data = new TextEncoder().encode('123456789');
  assert.equal(crc16(data, 0xffff), 0x29b1);
  assert.notEqual(crc16(data, 0x1234), 0x29b1);
});

test('frames round-trip with type and payload', () => {
  const payload = Uint8Array.of(1, 2, 250);
  const bytes = encodeFrame(5, payload);
  assert.equal(bytes.length, 1 + 3 + 2);
  assert.equal(frameBytes(bytes[0]), bytes.length);
  assert.deepEqual(decodeFrame(bytes), { type: 5, payload });
  assert.deepEqual(decodeFrame(encodeFrame(9, new Uint8Array(0))), { type: 9, payload: new Uint8Array(0) });
});

test('a frame only decodes with the key it was made with', () => {
  const bytes = encodeFrame(3, Uint8Array.of(7), 0x4242);
  assert.deepEqual(decodeFrame(bytes, 0x4242), { type: 3, payload: Uint8Array.of(7) });
  assert.equal(decodeFrame(bytes, DEFAULT_KEY), null);
  assert.equal(decodeFrame(bytes, 0x4243), null);
});

test('corrupted, truncated and over-long frames are rejected', () => {
  const bytes = encodeFrame(3, Uint8Array.of(7, 8, 9));
  for (let i = 0; i < bytes.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const bad = Uint8Array.from(bytes);
      bad[i] ^= 1 << bit;
      assert.equal(decodeFrame(bad), null, `flipping byte ${i} bit ${bit}`);
    }
  }
  assert.equal(decodeFrame(bytes.slice(0, -1)), null);
  assert.equal(decodeFrame(Uint8Array.of(...bytes, 0)), null);
  assert.equal(decodeFrame(new Uint8Array(0)), null);
  assert.equal(decodeFrame(null), null);
});

test('encodeFrame refuses invalid types and payloads that are too long', () => {
  assert.equal(MAX_PAYLOAD, 15);
  assert.throws(() => encodeFrame(16, new Uint8Array(0)));
  assert.throws(() => encodeFrame(-1, new Uint8Array(0)));
  assert.throws(() => encodeFrame(1, new Uint8Array(16)));
  assert.equal(encodeFrame(1, new Uint8Array(15)).length, 18);
});

test('hello and welcome carry nonce and protocol version', () => {
  const p = M.encodeHello({ nonce: 0xabcd, proto: 3 });
  assert.deepEqual(M.decodeHello(p), { nonce: 0xabcd, proto: 3 });
  assert.deepEqual(M.decodeWelcome(M.encodeWelcome({ nonce: 1, proto: 1 })), { nonce: 1, proto: 1 });
  assert.equal(M.decodeHello(Uint8Array.of(0, 0, 1)), null, 'nonce 0 is not allowed');
  assert.equal(M.decodeHello(Uint8Array.of(1, 2)), null);
});

test('ready carries the 32-bit fingerprint and ack names what it acknowledges', () => {
  assert.equal(M.decodeReady(M.encodeReady(0xfedcba98)), 0xfedcba98);
  assert.equal(M.decodeReady(M.encodeReady(0)), 0);
  assert.equal(M.decodeReady(Uint8Array.of(1, 2, 3)), null);
  assert.equal(M.decodeAck(M.encodeAck(M.READY)), M.READY);
  assert.equal(M.decodeAck(new Uint8Array(0)), null);
});

test('actions round-trip and malformed ones are rejected', () => {
  const cases = [
    { turn: 0, action: { kind: SHELL, cell: 0 } },
    { turn: 200, action: { kind: SHELL, cell: 99 } },
    { turn: 7, action: { kind: STRIKE, cell: cellAt(3, 4), orient: V } },
    { turn: 8, action: { kind: STRIKE, cell: cellAt(3, 4), orient: H } },
    { turn: 9, action: { kind: SCOUT, cell: 55 } },
  ];
  for (const c of cases) assert.deepEqual(M.decodeAction(M.encodeAction(c.turn, c.action)), c);
  assert.equal(M.decodeAction(Uint8Array.of(1, 0, 100)), null, 'cell off grid');
  assert.equal(M.decodeAction(Uint8Array.of(1, 3 << 1, 5)), null, 'unknown kind');
  assert.equal(M.decodeAction(Uint8Array.of(1, 1, 5)), null, 'a shell has no direction');
  assert.equal(M.decodeAction(Uint8Array.of(1, 0)), null);
  assert.throws(() => M.encodeAction(256, { kind: SHELL, cell: 1 }));
});

test('results round-trip for every kind of action', () => {
  const cases = [
    {
      action: { kind: SHELL, cell: 42 },
      result: { kind: SHELL, cells: [{ cell: 42, outcome: MISS }], sunk: [], count: 0, over: false },
    },
    {
      action: { kind: SHELL, cell: 81 },
      result: {
        kind: SHELL, cells: [{ cell: 81, outcome: HIT }], sunk: [{ id: 4, origin: 80, orient: H }], count: 0, over: true,
      },
    },
    {
      action: { kind: STRIKE, cell: 10, orient: V },
      result: {
        kind: STRIKE, count: 0, over: false,
        cells: [{ cell: 10, outcome: HIT }, { cell: 20, outcome: SKIP }, { cell: 30, outcome: MISS }],
        sunk: [{ id: 0, origin: 10, orient: H }, { id: 2, origin: 99, orient: V }, { id: 3, origin: 5, orient: V }],
      },
    },
    {
      action: { kind: SCOUT, cell: 0 },
      result: { kind: SCOUT, cells: [], sunk: [], count: 4, over: false },
    },
  ];
  for (const c of cases) {
    const payload = M.encodeResult(33, c.result);
    assert.ok(payload.length <= 15);
    assert.equal(M.resultTurn(payload), 33);
    assert.deepEqual(M.decodeResult(payload, c.action), c.result);
  }
});

test('a result that does not fit the action is rejected', () => {
  const shellResult = M.encodeResult(1, {
    kind: SHELL, cells: [{ cell: 42, outcome: MISS }], sunk: [], count: 0, over: false,
  });
  assert.equal(M.decodeResult(shellResult, { kind: SCOUT, cell: 42 }), null);
  assert.equal(M.decodeResult(shellResult, { kind: STRIKE, cell: 42, orient: H }), null);
  assert.equal(M.decodeResult(shellResult.slice(0, 2), { kind: SHELL, cell: 42 }), null);
  assert.equal(M.decodeResult(Uint8Array.of(1, 0, 0, 9), { kind: SHELL, cell: 42 }), null, 'trailing bytes');
  assert.equal(M.resultTurn(new Uint8Array(0)), null);
});

test('reveal carries the layout and the salt', () => {
  const layout = Uint8Array.of(0, 41, 80, 121, 199);
  const p = M.encodeReveal({ layout, salt: 0x89abcdef });
  assert.equal(p.length, 9);
  assert.deepEqual(M.decodeReveal(p), { layout, salt: 0x89abcdef });
  assert.equal(M.decodeReveal(p.slice(0, 8)), null);
});

test('ping carries a counter and a sender id', () => {
  assert.deepEqual(M.decodePing(M.encodePing({ counter: 200, sender: 17 })), { counter: 200, sender: 17 });
  assert.equal(M.decodePing(Uint8Array.of(1)), null);
});

test('message type numbers are distinct and fit in four bits', () => {
  const types = [M.HELLO, M.WELCOME, M.READY, M.ACK, M.ACTION, M.RESULT, M.REVEAL, M.PING, M.BYE];
  assert.equal(new Set(types).size, types.length);
  for (const t of types) assert.ok(t >= 1 && t <= 15);
});
