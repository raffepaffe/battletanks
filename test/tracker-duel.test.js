import test from 'node:test';
import assert from 'node:assert/strict';
import { H, V, cellAt, CELLS } from '../src/core/grid.js';
import { FLEET } from '../src/core/fleet.js';
import { ROCK } from '../src/core/terrain.js';
import { Board, SHELL, STRIKE, SCOUT, SKIP, MISS, HIT } from '../src/core/board.js';
import { Tracker, UNKNOWN, T_MISS, T_HIT, T_SUNK } from '../src/core/tracker.js';
import { Duel } from '../src/core/duel.js';
import { commitLayout, auditReveal } from '../src/core/commitment.js';
import { RuleError, ProtocolError } from '../src/core/errors.js';

const openTerrain = () => new Uint8Array(CELLS);

function standardBoard(terrain = openTerrain()) {
  const b = new Board(terrain);
  FLEET.forEach((u, i) => b.place(u.id, cellAt(0, i * 2), H));
  return b;
}

/** Fire an action at a real board and feed the honest result to the tracker. */
function fire(tracker, board, action) {
  const result = board.resolve(action);
  tracker.apply(action, result);
  return result;
}

test('tracker records misses, hits and destroyed units', () => {
  const board = standardBoard(), t = new Tracker(openTerrain());
  fire(t, board, { kind: SHELL, cell: 99 });
  fire(t, board, { kind: SHELL, cell: 80 });
  assert.equal(t.state[99], T_MISS);
  assert.equal(t.state[80], T_HIT);
  assert.equal(t.state[81], UNKNOWN);
  fire(t, board, { kind: SHELL, cell: 81 });
  assert.equal(t.state[80], T_SUNK);
  assert.equal(t.state[81], T_SUNK);
  assert.deepEqual(t.sunk, [{ id: 4, origin: 80, orient: H }]);
  assert.deepEqual(t.remainingIds(), [0, 1, 2, 3]);
  assert.equal(t.over, false);
  assert.equal(t.log.length, 3);
});

test('tracker knows which actions are still possible', () => {
  const terrain = openTerrain();
  terrain[50] = ROCK;
  const board = standardBoard(terrain), t = new Tracker(terrain);
  assert.ok(t.canDo({ kind: SHELL, cell: 99 }));
  assert.equal(t.canDo({ kind: SHELL, cell: 50 }), false, 'terrain');
  assert.equal(t.canDo({ kind: SHELL, cell: 100 }), false);
  assert.equal(t.canDo({ kind: STRIKE, cell: cellAt(8, 0), orient: H }), false, 'off grid');
  assert.equal(t.canDo({ kind: 7, cell: 1 }), false);
  assert.equal(t.canDo(null), false);
  fire(t, board, { kind: SHELL, cell: 99 });
  assert.equal(t.canDo({ kind: SHELL, cell: 99 }), false, 'already fired there');
  fire(t, board, { kind: STRIKE, cell: 90, orient: H });
  assert.equal(t.canDo({ kind: STRIKE, cell: 60, orient: H }), false, 'strike used');
  assert.equal(t.strikeUsed, true);
  fire(t, board, { kind: SCOUT, cell: 55 });
  assert.equal(t.canDo({ kind: SCOUT, cell: 11 }), false, 'scout used');
  assert.throws(() => t.apply({ kind: SCOUT, cell: 11 }, { kind: SCOUT, cells: [], sunk: [], count: 0, over: false }), RuleError);
});

test('scout reports are remembered and empty areas become known', () => {
  const board = standardBoard(), t = new Tracker(openTerrain());
  fire(t, board, { kind: SCOUT, cell: cellAt(8, 8) });
  assert.deepEqual(t.scouts, [{ center: 88, count: 0, found: 0 }]);
  assert.equal(t.knownEmpty[cellAt(9, 9)], 1);
  assert.equal(t.knownEmpty[cellAt(6, 8)], 0);
});

test('a scouted area becomes known-empty once all its reported tanks are found', () => {
  const board = standardBoard(), t = new Tracker(openTerrain());
  // Area around (1,9) covers rows 8-9, columns 0-2: the two Renault FTs.
  fire(t, board, { kind: SCOUT, cell: cellAt(1, 9) });
  assert.equal(t.scouts[0].count, 2);
  fire(t, board, { kind: SHELL, cell: cellAt(0, 8) });
  assert.equal(t.scouts[0].found, 1);
  assert.equal(t.knownEmpty[cellAt(2, 9)], 0);
  fire(t, board, { kind: SHELL, cell: cellAt(1, 8) });
  assert.equal(t.scouts[0].found, 2);
  assert.equal(t.knownEmpty[cellAt(2, 9)], 1);
  assert.equal(t.knownEmpty[cellAt(2, 8)], 1);
});

test('tracker ends the battle when all five units are destroyed', () => {
  const board = standardBoard(), t = new Tracker(openTerrain());
  FLEET.forEach((u, i) => {
    for (let c = 0; c < u.length; c++) fire(t, board, { kind: SHELL, cell: cellAt(c, i * 2) });
  });
  assert.equal(t.over, true);
  assert.equal(t.canDo({ kind: SHELL, cell: 99 }), false);
});

test('tracker rejects results that contradict the action or what is known', () => {
  const terrain = openTerrain();
  terrain[11] = ROCK;
  const fresh = () => new Tracker(terrain);
  const shell = { kind: SHELL, cell: 5 };
  const ok = { kind: SHELL, cells: [{ cell: 5, outcome: MISS }], sunk: [], count: 0, over: false };
  const bad = (action, result, why) => assert.throws(() => fresh().apply(action, result), ProtocolError, why);

  bad(shell, { ...ok, kind: SCOUT }, 'wrong kind');
  bad(shell, { ...ok, cells: [{ cell: 6, outcome: MISS }] }, 'wrong cell');
  bad(shell, { ...ok, cells: [] }, 'missing cell');
  bad(shell, { ...ok, cells: [{ cell: 5, outcome: SKIP }] }, 'a fresh cell cannot be skipped');
  bad(shell, { ...ok, cells: [{ cell: 5, outcome: 9 }] }, 'unknown outcome');
  bad(shell, { ...ok, over: true }, 'over without five units destroyed');
  bad(shell, { ...ok, count: 3 }, 'count on a shell');
  bad(shell, { ...ok, sunk: [{ id: 4, origin: 4, orient: H }] }, 'destroyed without a hit');
  bad(shell, {
    ...ok, cells: [{ cell: 5, outcome: HIT }], sunk: [{ id: 4, origin: 5, orient: H }],
  }, 'destroyed unit has an unhit cell');
  bad(shell, {
    ...ok, cells: [{ cell: 5, outcome: HIT }], sunk: [{ id: 9, origin: 5, orient: H }],
  }, 'unknown unit');
  bad(shell, null, 'no result');
  bad({ kind: SCOUT, cell: 5 }, { kind: SCOUT, cells: [], sunk: [], count: 10, over: false }, 'count too high');
  bad({ kind: SCOUT, cell: 0 }, { kind: SCOUT, cells: [], sunk: [], count: 4, over: false },
    'corner area has one rock, so at most three tanks');
  bad({ kind: STRIKE, cell: 10, orient: H }, {
    kind: STRIKE, sunk: [], count: 0, over: false,
    cells: [{ cell: 10, outcome: MISS }, { cell: 11, outcome: MISS }, { cell: 12, outcome: MISS }],
  }, 'terrain cell must be skipped');
});

test('tracker rejects a unit reported destroyed twice or a miss inside a destroyed unit', () => {
  const board = standardBoard(), t = new Tracker(openTerrain());
  fire(t, board, { kind: SHELL, cell: 80 });
  fire(t, board, { kind: SHELL, cell: 81 });
  assert.throws(() => t.apply({ kind: SHELL, cell: 82 }, {
    kind: SHELL, cells: [{ cell: 82, outcome: HIT }], sunk: [{ id: 4, origin: 81, orient: H }], count: 0, over: false,
  }), ProtocolError);
  // A failed apply must leave the tracker untouched.
  assert.equal(t.state[82], UNKNOWN);
  assert.equal(t.log.length, 2);
});

test('a duel alternates turns and each side resolves the other side\'s actions', () => {
  const terrain = openTerrain();
  const a = new Duel({ terrain, board: standardBoard(), first: true });
  const b = new Duel({ terrain, board: standardBoard(), first: false });
  assert.equal(a.turn, 'me');
  assert.equal(b.turn, 'them');

  const action = { kind: SHELL, cell: 0 };
  assert.throws(() => b.beginAction(action), RuleError, 'not b\'s turn');
  assert.throws(() => a.receiveAction(action), RuleError, 'not their turn');
  a.beginAction(action);
  assert.throws(() => a.beginAction({ kind: SHELL, cell: 1 }), RuleError, 'already waiting for a result');
  const result = b.receiveAction(action);
  a.completeAction(result);
  assert.equal(a.turn, 'them');
  assert.equal(b.turn, 'me');
  assert.equal(a.tracker.state[0], T_HIT);
  assert.throws(() => a.completeAction(result), RuleError, 'nothing pending');
});

test('a duel ends with a winner on both sides', () => {
  const terrain = openTerrain();
  const a = new Duel({ terrain, board: standardBoard(), first: true });
  const b = new Duel({ terrain, board: standardBoard(), first: false });
  const targets = [];
  FLEET.forEach((u, i) => { for (let c = 0; c < u.length; c++) targets.push(cellAt(c, i * 2)); });
  let wasted = 99;
  for (const cell of targets) {
    const mine = { kind: SHELL, cell };
    a.beginAction(mine);
    a.completeAction(b.receiveAction(mine));
    if (a.over) break;
    const theirs = { kind: SHELL, cell: wasted-- };
    b.beginAction(theirs);
    b.completeAction(a.receiveAction(theirs));
  }
  assert.equal(a.over, true);
  assert.equal(a.winner, 'me');
  assert.equal(b.over, true);
  assert.equal(b.winner, 'them');
  assert.equal(a.turn, null);
  assert.throws(() => b.beginAction({ kind: SHELL, cell: 50 }), RuleError);
});

test('a duel rejects an illegal own action before it is sent', () => {
  const terrain = openTerrain();
  terrain[5] = ROCK;
  const a = new Duel({ terrain, board: standardBoard(terrain), first: true });
  assert.throws(() => a.beginAction({ kind: SHELL, cell: 5 }), RuleError);
  assert.equal(a.pending, null);
});

test('a duel cannot start before the fleet is placed', () => {
  const terrain = openTerrain();
  assert.throws(() => new Duel({ terrain, board: new Board(terrain), first: true }), RuleError);
});

test('commitment is stable, and changes with the layout or the salt', () => {
  const layout = standardBoard().layout();
  const c = commitLayout(layout, 0xdeadbeef);
  assert.equal(c, commitLayout(layout, 0xdeadbeef));
  assert.ok(Number.isInteger(c) && c >= 0 && c <= 0xffffffff);
  assert.notEqual(c, commitLayout(layout, 0xdeadbeee));
  const other = Uint8Array.from(layout);
  other[4] ^= 1;
  assert.notEqual(c, commitLayout(other, 0xdeadbeef));
});

test('audit accepts an honest opponent', () => {
  const terrain = openTerrain();
  const board = standardBoard(terrain), t = new Tracker(terrain);
  const layout = board.layout(), salt = 12345, commit = commitLayout(layout, salt);
  fire(t, board, { kind: SCOUT, cell: 11 });
  fire(t, board, { kind: SHELL, cell: 0 });
  fire(t, board, { kind: STRIKE, cell: 60, orient: V });
  fire(t, board, { kind: SHELL, cell: 55 });
  assert.deepEqual(auditReveal({ terrain, layout, salt, commit, log: t.log }), { ok: true, reason: null });
});

test('audit catches a changed layout, an impossible layout and a false report', () => {
  const terrain = openTerrain();
  const board = standardBoard(terrain), t = new Tracker(terrain);
  const layout = board.layout(), salt = 777, commit = commitLayout(layout, salt);
  fire(t, board, { kind: SHELL, cell: 0 });

  const moved = Uint8Array.from(layout);
  moved[4] = (cellAt(5, 9) << 1) | H;
  assert.equal(auditReveal({ terrain, layout: moved, salt, commit, log: t.log }).ok, false);
  assert.equal(auditReveal({ terrain, layout, salt: salt + 1, commit, log: t.log }).ok, false);

  const impossible = Uint8Array.of(0, 0, 0, 0, 0);
  const r = auditReveal({ terrain, layout: impossible, salt, commit: commitLayout(impossible, salt), log: t.log });
  assert.equal(r.ok, false);

  // The opponent claimed a miss on a cell their revealed layout shows as occupied.
  const lying = new Tracker(terrain);
  lying.apply({ kind: SHELL, cell: 1 }, { kind: SHELL, cells: [{ cell: 1, outcome: MISS }], sunk: [], count: 0, over: false });
  const verdict = auditReveal({ terrain, layout, salt, commit, log: lying.log });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /report/i);
});
