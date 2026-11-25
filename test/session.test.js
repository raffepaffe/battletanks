import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.js';
import { SHELL, STRIKE, SCOUT, MISS, HIT } from '../src/core/board.js';
import { H } from '../src/core/grid.js';
import { encodeFrame, decodeFrame, DEFAULT_KEY } from '../src/link/frame.js';
import * as M from '../src/link/messages.js';
import { Session, PROTO, sessionKey } from '../src/link/session.js';
import { FakeClock, createLink } from './helpers/fake-link.js';

function pair(options = {}) {
  const clock = new FakeClock();
  const link = createLink(clock, options);
  const rngA = createRng(options.seedA ?? 11), rngB = createRng(options.seedB ?? 22);
  const eventsA = [], eventsB = [];
  const a = new Session({ transport: link.a, timers: clock.timers, random: rngA.next, onEvent: (e) => eventsA.push(e), proto: options.protoA });
  const b = new Session({ transport: link.b, timers: clock.timers, random: rngB.next, onEvent: (e) => eventsB.push(e), proto: options.protoB });
  return { clock, link, a, b, eventsA, eventsB };
}

async function paired(options = {}) {
  const ctx = pair(options);
  ctx.a.listen();
  ctx.b.listen();
  ctx.b.call();
  await ctx.clock.until(() => ctx.a.state === 'paired' && ctx.b.state === 'paired');
  return ctx;
}

const miss = (cell) => ({ kind: SHELL, cells: [{ cell, outcome: MISS }], sunk: [], count: 0, over: false });

/** Lose the frames with these indexes (in sending order). */
const loseIndexes = (...indexes) => (frame) => indexes.includes(frame.index);

test('one device calls, the other answers by itself', async () => {
  const { a, b, eventsA, eventsB } = await paired();
  assert.equal(b.role, 0, 'the caller');
  assert.equal(a.role, 1, 'the answerer');
  assert.equal(a.seed, b.seed);
  assert.ok(a.seed >= 1 && a.seed <= 65535);
  assert.notEqual(a.meFirst, b.meFirst, 'exactly one side starts');
  assert.ok(eventsA.some((e) => e.type === 'paired'));
  assert.ok(eventsB.some((e) => e.type === 'paired'));
  assert.notEqual(sessionKey(a.seed), DEFAULT_KEY);
});

test('pairing survives a lost hello and a lost welcome', async () => {
  const { a, b, link } = await paired({ lose: loseIndexes(0, 2) });
  assert.equal(a.state, 'paired');
  assert.equal(b.state, 'paired');
  assert.ok(link.sent.length >= 4);
});

test('if both devices call at once, one of them gives way', async () => {
  const ctx = pair();
  ctx.a.listen();
  ctx.b.listen();
  ctx.a.call();
  ctx.b.call();
  await ctx.clock.until(() => ctx.a.state === 'paired' && ctx.b.state === 'paired');
  assert.notEqual(ctx.a.role, ctx.b.role);
  assert.equal(ctx.a.seed, ctx.b.seed);
});

test('devices with different protocol versions refuse to pair and say so', async () => {
  const ctx = pair({ protoB: PROTO + 1 });
  ctx.a.listen();
  ctx.b.listen();
  ctx.b.call();
  await ctx.clock.until(() => ctx.a.state === 'mismatch' && ctx.b.state === 'mismatch');
  assert.ok(ctx.eventsA.some((e) => e.type === 'version'));
  assert.ok(ctx.eventsB.some((e) => e.type === 'version'));
});

test('both sides exchange fleet fingerprints, even on a lossy link', async () => {
  const rng = createRng(5);
  const { a, b, clock } = await paired({ lose: (f) => f.index > 1 && rng.next() < 0.35 });
  let doneA = false, doneB = false;
  a.sendReady(0x11111111).then(() => { doneA = true; });
  b.sendReady(0x22222222).then(() => { doneB = true; });
  await clock.until(() => doneA && doneB);
  assert.equal(await a.whenPeerReady, 0x22222222);
  assert.equal(await b.whenPeerReady, 0x11111111);
});

const frameType = (frame) => frame.bytes[0] >> 4;

/** Lose only the first frame of the given type. */
function loseFirst(type) {
  let dropped = false;
  return (frame) => {
    if (dropped || frameType(frame) !== type) return false;
    dropped = true;
    return true;
  };
}

test('an action is answered with a result and the handler runs exactly once', async () => {
  // Lose the first RESULT so the ACTION is repeated.
  const { a, b, clock } = await paired({ lose: loseFirst(M.RESULT) });
  const [first, second] = a.meFirst ? [a, b] : [b, a];
  let calls = 0;
  second.onAction = (action) => { calls++; return miss(action.cell); };
  let result = null;
  first.sendAction({ kind: SHELL, cell: 42 }).then((r) => { result = r; });
  await clock.until(() => result !== null);
  assert.deepEqual(result, miss(42));
  assert.equal(calls, 1);
  assert.equal(first.turn, 1);
  assert.equal(second.turn, 1);
});

test('a whole exchange of turns completes in order on a bad link', async () => {
  const rng = createRng(99);
  const { a, b, clock } = await paired({ lose: (f) => f.index > 1 && rng.next() < 0.3 });
  const received = { a: [], b: [] };
  a.onAction = (action) => { received.a.push(action.cell); return miss(action.cell); };
  b.onAction = (action) => { received.b.push(action.cell); return miss(action.cell); };
  let [attacker, defender] = a.meFirst ? [a, b] : [b, a];
  const order = [];
  for (let turn = 0; turn < 12; turn++) {
    let result = null;
    attacker.sendAction({ kind: SHELL, cell: turn }).then((r) => { result = r; });
    await clock.until(() => result !== null);
    assert.deepEqual(result, miss(turn));
    order.push(turn);
    [attacker, defender] = [defender, attacker];
  }
  assert.equal(a.turn, 12);
  assert.equal(b.turn, 12);
  const firstCells = [0, 2, 4, 6, 8, 10], secondCells = [1, 3, 5, 7, 9, 11];
  const [firstName, secondName] = a.meFirst ? ['a', 'b'] : ['b', 'a'];
  assert.deepEqual(received[secondName], firstCells);
  assert.deepEqual(received[firstName], secondCells);
});

test('the next action may be sent before the last result has arrived on the other side', async () => {
  // The defender answers, then immediately attacks; its RESULT is lost once.
  const { a, b, clock } = await paired({ lose: loseFirst(M.RESULT) });
  const [first, second] = a.meFirst ? [a, b] : [b, a];
  let firstResult = null, secondResult = null;
  second.onAction = (action) => {
    // Attack back as soon as our report is on its way, before the first side has heard it.
    clock.timers.setTimeout(() => {
      second.sendAction({ kind: SHELL, cell: 7 }).then((r) => { secondResult = r; });
    }, 0);
    return miss(action.cell);
  };
  first.onAction = (action) => miss(action.cell);
  first.sendAction({ kind: SHELL, cell: 3 }).then((r) => { firstResult = r; });
  await clock.until(() => firstResult !== null && secondResult !== null);
  assert.deepEqual(firstResult, miss(3));
  assert.deepEqual(secondResult, miss(7));
  assert.equal(first.turn, 2);
  assert.equal(second.turn, 2);
});

test('special actions and their results cross the link intact', async () => {
  const { a, b, clock } = await paired();
  const [first, second] = a.meFirst ? [a, b] : [b, a];
  const strike = { kind: STRIKE, cell: 10, orient: H };
  const strikeResult = {
    kind: STRIKE, count: 0, over: false,
    cells: [{ cell: 10, outcome: HIT }, { cell: 11, outcome: MISS }, { cell: 12, outcome: HIT }],
    sunk: [{ id: 4, origin: 2, orient: 1 }],
  };
  const scoutResult = { kind: SCOUT, cells: [], sunk: [], count: 3, over: false };
  const seen = [];
  second.onAction = (action) => { seen.push(action); return strikeResult; };
  first.onAction = (action) => { seen.push(action); return scoutResult; };
  let r1 = null, r2 = null;
  first.sendAction(strike).then((r) => { r1 = r; });
  await clock.until(() => r1 !== null);
  second.sendAction({ kind: SCOUT, cell: 55 }).then((r) => { r2 = r; });
  await clock.until(() => r2 !== null);
  assert.deepEqual(r1, strikeResult);
  assert.deepEqual(r2, scoutResult);
  assert.deepEqual(seen, [strike, { kind: SCOUT, cell: 55 }]);
});

test('an action from the side whose turn it is not is ignored', async () => {
  const { a, b, clock, link } = await paired();
  const [first, second] = a.meFirst ? [a, b] : [b, a];
  let calls = 0;
  first.onAction = () => { calls++; return miss(1); };
  second.onAction = () => { calls++; return miss(1); };
  await assert.rejects(() => second.sendAction({ kind: SHELL, cell: 1 }), /turn/);
  // Forge a frame with a wrong turn number straight onto the link.
  const transport = second === a ? link.a : link.b;
  transport.send(encodeFrame(M.ACTION, M.encodeAction(5, { kind: SHELL, cell: 1 }), sessionKey(a.seed)), second.role);
  await clock.advance(5000);
  assert.equal(calls, 0);
  assert.equal(first.turn, 0);
});

test('if the handler refuses an action, a fault is reported and nothing is answered', async () => {
  const { a, b, clock, eventsA, eventsB, link } = await paired();
  const [first, second] = a.meFirst ? [a, b] : [b, a];
  second.onAction = () => { throw new Error('that cell was already hit'); };
  const before = link.sent.length;
  first.sendAction({ kind: SHELL, cell: 1 }).catch(() => {});
  await clock.advance(1500);
  const events = second === a ? eventsA : eventsB;
  assert.ok(events.some((e) => e.type === 'fault' && /already hit/.test(e.message)));
  assert.equal(link.sent.slice(before).filter((f) => frameType(f) === M.RESULT).length, 0);
  assert.equal(second.turn, 0);
});

test('an incoming action counts as proof that our fingerprint arrived', async () => {
  // Every ACK is lost, so only the action can confirm the READY.
  const { a, b, clock } = await paired({ lose: (f) => frameType(f) === M.ACK });
  const [first, second] = a.meFirst ? [a, b] : [b, a];
  let ready = false, heard = false;
  second.sendReady(0xabc).then(() => { ready = true; });
  first.whenPeerReady.then(() => { heard = true; });
  await clock.until(() => heard);
  assert.equal(ready, false, 'no ACK ever arrives');
  second.onAction = (action) => miss(action.cell);
  let result = null;
  first.sendAction({ kind: SHELL, cell: 9 }).then((r) => { result = r; });
  await clock.until(() => result !== null && ready);
  assert.equal(ready, true);
});

test('after the battle both sides exchange their layouts', async () => {
  const rng = createRng(3);
  const { a, b, clock } = await paired({ lose: (f) => f.index > 1 && rng.next() < 0.3 });
  const la = { layout: Uint8Array.of(0, 40, 80, 120, 160), salt: 0xdeadbeef };
  const lb = { layout: Uint8Array.of(1, 3, 5, 7, 9), salt: 42 };
  let doneA = false, doneB = false;
  a.sendReveal(la).then(() => { doneA = true; });
  b.sendReveal(lb).then(() => { doneB = true; });
  await clock.until(() => doneA && doneB);
  assert.deepEqual(await a.whenPeerReveal, lb);
  assert.deepEqual(await b.whenPeerReveal, la);
});

test('trouble is reported when the other device stops answering, and recovery when it returns', async () => {
  let deaf = true;
  const { a, b, clock, eventsA, eventsB } = await paired({ lose: (f) => f.index > 1 && deaf });
  const [first, second] = a.meFirst ? [a, b] : [b, a];
  const events = first === a ? eventsA : eventsB;
  second.onAction = (action) => miss(action.cell);
  let result = null;
  first.sendAction({ kind: SHELL, cell: 1 }).then((r) => { result = r; });
  await clock.until(() => events.some((e) => e.type === 'trouble'), 60000);
  assert.equal(result, null);
  deaf = false;
  await clock.until(() => result !== null);
  assert.ok(events.some((e) => e.type === 'recovered'));
});

test('chirps from strangers and malformed frames are ignored', async () => {
  const { a, b, clock, link } = await paired({ halfDuplex: false });
  const stranger = sessionKey(a.seed === 65535 ? 1 : a.seed + 1);
  let calls = 0;
  a.onAction = () => { calls++; return miss(0); };
  b.onAction = () => { calls++; return miss(0); };
  for (const [transport, session] of [[link.a, a], [link.b, b]]) {
    // Another pair's action, a hello from a third device, and nonsense with a valid check.
    transport.send(encodeFrame(M.ACTION, M.encodeAction(0, { kind: SHELL, cell: 1 }), stranger), session.role);
    transport.send(encodeFrame(M.HELLO, M.encodeHello({ nonce: 12345, proto: PROTO })), 0);
    transport.send(encodeFrame(M.ACTION, Uint8Array.of(1, 2), sessionKey(a.seed)), session.role);
    transport.send(encodeFrame(M.RESULT, Uint8Array.of(0, 0, 0), sessionKey(a.seed)), session.role);
    transport.send(encodeFrame(15, Uint8Array.of(9, 9), sessionKey(a.seed)), session.role);
    transport.send(Uint8Array.of(1, 2, 3), session.role);
  }
  await clock.advance(15000);
  assert.equal(calls, 0);
  assert.equal(a.state, 'paired');
  assert.equal(b.state, 'paired');
  assert.equal(a.turn, 0);
});

test('a device only listens to the other device\'s band', async () => {
  const { a, b, clock, link } = await paired();
  const [first, second] = a.meFirst ? [a, b] : [b, a];
  let calls = 0;
  second.onAction = () => { calls++; return miss(0); };
  // A correct action, but arriving in the receiver's own band, as an echo of itself would.
  const transport = first === a ? link.a : link.b;
  transport.send(encodeFrame(M.ACTION, M.encodeAction(0, { kind: SHELL, cell: 1 }), sessionKey(a.seed)), second.role);
  await clock.advance(3000);
  assert.equal(calls, 0);
});

test('closing rejects what was waiting and leaves no timers behind', async () => {
  const { a, b, clock } = await paired({ lose: (f) => f.index > 1 });
  const [first] = a.meFirst ? [a, b] : [b, a];
  const pending = first.sendAction({ kind: SHELL, cell: 1 });
  await clock.advance(3000);
  a.close();
  b.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(a.whenPeerReveal, /closed/);
  await clock.advance(10000);
  assert.equal(clock.pending, 0);
  assert.equal(a.state, 'closed');
  assert.throws(() => a.call(), /closed/);
});

test('frames use the pre-pairing key for pairing and the session key afterwards', async () => {
  const { a, link } = await paired();
  const hello = link.sent.find((f) => frameType(f) === M.HELLO);
  assert.ok(decodeFrame(hello.bytes, DEFAULT_KEY));
  a.sendReady(1).catch(() => {});
  const ready = link.sent[link.sent.length - 1];
  assert.equal(decodeFrame(ready.bytes, DEFAULT_KEY), null);
  assert.equal(decodeFrame(ready.bytes, sessionKey(a.seed)).type, M.READY);
  a.close();
});

test('a version mismatch is still reported when the first welcome is lost', async () => {
  const ctx = pair({ protoB: PROTO + 1, lose: loseFirst(M.WELCOME) });
  ctx.a.listen();
  ctx.b.listen();
  ctx.b.call();
  await ctx.clock.until(() => ctx.a.state === 'mismatch' && ctx.b.state === 'mismatch');
  assert.ok(ctx.eventsB.some((e) => e.type === 'version'));
});

test('closing a paired session tells the other device, which stops waiting', async () => {
  const { a, b, clock, eventsA, eventsB, link } = await paired();
  const [first, second] = a.meFirst ? [a, b] : [b, a];
  const waiting = first.sendAction({ kind: SHELL, cell: 1 });
  second.close();
  assert.ok(link.sent.some((f) => frameType(f) === M.BYE), 'a goodbye is sent');
  await clock.advance(4000);
  const events = first === a ? eventsA : eventsB;
  assert.ok(events.some((e) => e.type === 'left'));
  assert.equal(first.state, 'closed');
  await assert.rejects(waiting, /left/);
  await assert.rejects(first.whenPeerReveal, /left/);
  await clock.advance(20000);
  assert.equal(clock.pending, 0, 'nothing keeps chirping');
  const others = second === a ? eventsA : eventsB;
  assert.equal(others.some((e) => e.type === 'left'), false, 'the side that left is not told it left');
});

test('a session that never paired says no goodbye, and a stranger\'s goodbye is ignored', async () => {
  const lonely = pair();
  lonely.a.listen();
  lonely.a.close();
  assert.equal(lonely.link.sent.length, 0);

  const { a, b, clock, link } = await paired({ halfDuplex: false });
  const stranger = sessionKey(a.seed === 65535 ? 1 : a.seed + 1);
  link.a.send(encodeFrame(M.BYE, new Uint8Array(0), stranger), a.role);
  link.b.send(encodeFrame(M.BYE, new Uint8Array(0), stranger), b.role);
  // Right key, but a goodbye carries no payload: this is something else.
  link.a.send(encodeFrame(M.BYE, Uint8Array.of(1), sessionKey(a.seed)), a.role);
  await clock.advance(3000);
  assert.equal(a.state, 'paired');
  assert.equal(b.state, 'paired');
});
