import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.js';
import { H, V, cellAt, CELLS } from '../src/core/grid.js';
import { FLEET } from '../src/core/fleet.js';
import { OPEN, ROCK, LAKE } from '../src/core/terrain.js';
import { Board, SHELL, STRIKE, SCOUT, SKIP, MISS, HIT } from '../src/core/board.js';
import { RuleError } from '../src/core/errors.js';

const openTerrain = () => new Uint8Array(CELLS);

/** Fleet laid out in rows 0,2,4,6,8 starting at column 0, all horizontal. */
function standardBoard(terrain = openTerrain()) {
  const b = new Board(terrain);
  FLEET.forEach((u, i) => b.place(u.id, cellAt(0, i * 2), H));
  return b;
}

test('placing a unit records it and marks its cells', () => {
  const b = new Board(openTerrain());
  b.place(0, cellAt(2, 3), V);
  assert.deepEqual(b.placements[0], { origin: 32, orient: V });
  assert.equal(b.unitAt(cellAt(2, 3)), 0);
  assert.equal(b.unitAt(cellAt(2, 7)), 0);
  assert.equal(b.unitAt(cellAt(2, 8)), -1);
  assert.equal(b.isComplete(), false);
});

test('placement rejects off-grid, overlapping, blocked and repeated units', () => {
  const terrain = openTerrain();
  terrain[cellAt(5, 5)] = ROCK;
  terrain[cellAt(0, 9)] = LAKE;
  const b = new Board(terrain);
  assert.equal(b.canPlace(0, cellAt(6, 0), H), false, 'five cells do not fit from column 6');
  assert.throws(() => b.place(0, cellAt(6, 0), H), RuleError);
  assert.equal(b.canPlace(4, cellAt(4, 5), H), false, 'rock in the way');
  assert.equal(b.canPlace(4, cellAt(0, 8), V), false, 'lake in the way');
  b.place(0, cellAt(0, 0), H);
  assert.equal(b.canPlace(1, cellAt(4, 0), V), false, 'overlaps unit 0');
  assert.equal(b.canPlace(0, cellAt(0, 2), H), false, 'unit 0 is already placed');
  assert.equal(b.canPlace(9, cellAt(0, 2), H), false, 'unknown unit');
  assert.equal(b.canPlace(1, cellAt(0, 2), 7), false, 'unknown orientation');
});

test('a unit can be removed and placed again before the battle', () => {
  const b = new Board(openTerrain());
  b.place(4, cellAt(0, 0), H);
  b.remove(4);
  assert.equal(b.unitAt(0), -1);
  b.place(4, cellAt(3, 3), V);
  assert.equal(b.unitAt(cellAt(3, 4)), 4);
});

test('placeRandom fills the board legally and reproducibly', () => {
  const terrain = openTerrain();
  terrain[44] = ROCK;
  const a = new Board(terrain), b = new Board(terrain);
  a.placeRandom(createRng(9));
  b.placeRandom(createRng(9));
  assert.ok(a.isComplete());
  assert.deepEqual(a.placements, b.placements);
  let occupied = 0;
  for (let c = 0; c < CELLS; c++) if (a.unitAt(c) >= 0) occupied++;
  assert.equal(occupied, 17);
  assert.equal(a.unitAt(44), -1);
});

test('a shell reports miss, hit, and the unit when its last tank is hit', () => {
  const b = standardBoard();
  assert.deepEqual(b.resolve({ kind: SHELL, cell: cellAt(9, 9) }), {
    kind: SHELL, cells: [{ cell: 99, outcome: MISS }], sunk: [], count: 0, over: false,
  });
  const hit = b.resolve({ kind: SHELL, cell: cellAt(0, 8) });
  assert.deepEqual(hit.cells, [{ cell: 80, outcome: HIT }]);
  assert.deepEqual(hit.sunk, []);
  const sunk = b.resolve({ kind: SHELL, cell: cellAt(1, 8) });
  assert.deepEqual(sunk.sunk, [{ id: 4, origin: 80, orient: H }]);
  assert.equal(sunk.over, false);
  assert.ok(b.isSunk(4));
});

test('the battle is over when every unit is destroyed, and then nothing more is accepted', () => {
  const b = standardBoard();
  let last;
  FLEET.forEach((u, i) => {
    for (let c = 0; c < u.length; c++) last = b.resolve({ kind: SHELL, cell: cellAt(c, i * 2) });
  });
  assert.equal(last.over, true);
  assert.ok(b.allSunk());
  assert.throws(() => b.resolve({ kind: SHELL, cell: 99 }), RuleError);
});

test('resolve rejects illegal shells', () => {
  const terrain = openTerrain();
  terrain[50] = ROCK;
  const b = standardBoard(terrain);
  b.resolve({ kind: SHELL, cell: 99 });
  assert.throws(() => b.resolve({ kind: SHELL, cell: 99 }), RuleError, 'same cell twice');
  assert.throws(() => b.resolve({ kind: SHELL, cell: 50 }), RuleError, 'terrain');
  assert.throws(() => b.resolve({ kind: SHELL, cell: 100 }), RuleError, 'off grid');
  assert.throws(() => b.resolve({ kind: 9, cell: 1 }), RuleError, 'unknown kind');
  assert.throws(() => b.resolve(null), RuleError);
  const incomplete = new Board(openTerrain());
  assert.throws(() => incomplete.resolve({ kind: SHELL, cell: 1 }), RuleError, 'fleet not placed');
});

test('units cannot be moved once the battle has started', () => {
  const b = standardBoard();
  b.resolve({ kind: SHELL, cell: 99 });
  assert.throws(() => b.remove(0), RuleError);
});

test('an air strike hits three cells in a row and skips terrain and old craters', () => {
  const terrain = openTerrain();
  terrain[cellAt(1, 1)] = ROCK;
  const b = standardBoard(terrain);
  b.resolve({ kind: SHELL, cell: cellAt(1, 2) }); // hit on unit 1 already
  const r = b.resolve({ kind: STRIKE, cell: cellAt(1, 0), orient: V });
  assert.deepEqual(r.cells, [
    { cell: cellAt(1, 0), outcome: HIT },
    { cell: cellAt(1, 1), outcome: SKIP },
    { cell: cellAt(1, 2), outcome: SKIP },
  ]);
  assert.equal(r.kind, STRIKE);
});

test('an air strike can destroy units and is allowed only once', () => {
  const b = standardBoard();
  b.resolve({ kind: SHELL, cell: cellAt(0, 8) });
  const r = b.resolve({ kind: STRIKE, cell: cellAt(1, 8), orient: H });
  assert.deepEqual(r.cells.map((c) => c.outcome), [HIT, MISS, MISS]);
  assert.deepEqual(r.sunk, [{ id: 4, origin: 80, orient: H }]);
  assert.throws(() => b.resolve({ kind: STRIKE, cell: cellAt(5, 5), orient: H }), RuleError);
});

test('an air strike must fit on the grid and touch at least one fresh cell', () => {
  const b = standardBoard();
  assert.throws(() => b.resolve({ kind: STRIKE, cell: cellAt(8, 9), orient: H }), RuleError);
  assert.throws(() => b.resolve({ kind: STRIKE, cell: cellAt(0, 9), orient: 5 }), RuleError);
  for (const c of [97, 98, 99]) b.resolve({ kind: SHELL, cell: c });
  assert.throws(() => b.resolve({ kind: STRIKE, cell: 97, orient: H }), RuleError);
  // The failed attempts must not have used the strike up.
  assert.equal(b.resolve({ kind: STRIKE, cell: cellAt(5, 9), orient: H }).kind, STRIKE);
});

test('a scout drone counts intact tanks in a 3x3 area without damaging them', () => {
  const b = standardBoard();
  b.resolve({ kind: SHELL, cell: cellAt(0, 0) }); // one tank of unit 0 already burning
  const r = b.resolve({ kind: SCOUT, cell: cellAt(1, 1) });
  // Area covers columns 0-2 of rows 0-2: unit 0 (3 cells, 1 hit) and unit 1 (3 cells).
  assert.deepEqual(r, { kind: SCOUT, cells: [], sunk: [], count: 5, over: false });
  assert.equal(b.isHit(cellAt(1, 0)), false);
  assert.throws(() => b.resolve({ kind: SCOUT, cell: cellAt(5, 5) }), RuleError, 'only one scout');
});

test('layout bytes round-trip and invalid layouts are rejected', () => {
  const terrain = openTerrain();
  terrain[99] = LAKE;
  const b = standardBoard(terrain);
  const bytes = b.layout();
  assert.equal(bytes.length, 5);
  const copy = Board.fromLayout(terrain, bytes);
  assert.deepEqual(copy.placements, b.placements);
  const overlapping = Uint8Array.from(bytes);
  overlapping[1] = overlapping[0];
  assert.throws(() => Board.fromLayout(terrain, overlapping), RuleError);
  assert.throws(() => Board.fromLayout(terrain, bytes.slice(0, 4)), RuleError);
  assert.throws(() => Board.fromLayout(terrain, Uint8Array.of(255, 0, 0, 0, 0)), RuleError);
  assert.equal(OPEN, 0);
});
