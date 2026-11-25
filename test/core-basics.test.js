import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.js';
import {
  SIZE, CELLS, H, V, cellAt, colOf, rowOf, isCell, lineCells, areaCells, neighbours, cellName,
} from '../src/core/grid.js';
import { FLEET, FLEET_CELLS } from '../src/core/fleet.js';
import { OPEN, ROCK, LAKE, generateTerrain } from '../src/core/terrain.js';
import { Board } from '../src/core/board.js';

test('rng is deterministic per seed and differs between seeds', () => {
  const a = createRng(42), b = createRng(42), c = createRng(43);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  const seqC = Array.from({ length: 20 }, () => c.next());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const x of seqA) assert.ok(x >= 0 && x < 1);
});

test('rng.int stays in range and rng.pick returns members', () => {
  const r = createRng(7);
  for (let i = 0; i < 500; i++) {
    const n = r.int(10);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 10);
  }
  assert.ok(['a', 'b', 'c'].includes(r.pick(['a', 'b', 'c'])));
});

test('grid coordinates convert both ways', () => {
  assert.equal(SIZE, 10);
  assert.equal(CELLS, 100);
  assert.equal(cellAt(3, 2), 23);
  assert.equal(colOf(23), 3);
  assert.equal(rowOf(23), 2);
  assert.equal(cellName(0), 'A1');
  assert.equal(cellName(99), 'J10');
  assert.equal(cellName(cellAt(2, 4)), 'C5');
});

test('isCell rejects anything that is not a cell index', () => {
  assert.ok(isCell(0));
  assert.ok(isCell(99));
  for (const bad of [-1, 100, 1.5, NaN, '5', null, undefined]) assert.equal(isCell(bad), false);
});

test('lineCells returns the cells or null when the line leaves the grid', () => {
  assert.deepEqual(lineCells(cellAt(7, 0), H, 3), [7, 8, 9]);
  assert.equal(lineCells(cellAt(8, 0), H, 3), null, 'must not wrap to the next row');
  assert.deepEqual(lineCells(cellAt(0, 7), V, 3), [70, 80, 90]);
  assert.equal(lineCells(cellAt(0, 8), V, 3), null);
  assert.equal(lineCells(100, H, 1), null);
  assert.equal(lineCells(0, 2, 2), null, 'unknown orientation');
});

test('areaCells clips the 3x3 area at the edges', () => {
  assert.deepEqual(areaCells(cellAt(0, 0)), [0, 1, 10, 11]);
  assert.equal(areaCells(cellAt(5, 5)).length, 9);
  assert.deepEqual(areaCells(cellAt(9, 9)), [88, 89, 98, 99]);
});

test('neighbours gives the orthogonal cells without wrapping', () => {
  assert.deepEqual(neighbours(0).sort((a, b) => a - b), [1, 10]);
  assert.deepEqual(neighbours(cellAt(9, 0)).sort((a, b) => a - b), [8, 19]);
  assert.equal(neighbours(cellAt(4, 4)).length, 4);
});

test('the fleet is five historical tank units covering 17 cells', () => {
  assert.equal(FLEET.length, 5);
  assert.deepEqual(FLEET.map((u) => u.id), [0, 1, 2, 3, 4]);
  assert.deepEqual(FLEET.map((u) => u.length), [5, 4, 3, 3, 2]);
  assert.equal(FLEET_CELLS, 17);
  for (const u of FLEET) {
    assert.ok(u.name && u.nation && u.key);
    assert.ok(u.year >= 1900 && u.year <= 1950, `${u.name} must be from the first half of the 20th century`);
  }
});

test('terrain is deterministic, modest in size and only uses known types', () => {
  for (const seed of [1, 2, 3, 500, 65535]) {
    const t1 = generateTerrain(seed), t2 = generateTerrain(seed);
    assert.deepEqual(t1, t2);
    assert.equal(t1.length, CELLS);
    let blocked = 0;
    for (const v of t1) {
      assert.ok(v === OPEN || v === ROCK || v === LAKE);
      if (v !== OPEN) blocked++;
    }
    assert.ok(blocked >= 6 && blocked <= 12, `seed ${seed} has ${blocked} blocked cells`);
  }
  assert.notDeepEqual(generateTerrain(1), generateTerrain(2));
});

test('every terrain leaves room for the whole fleet', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const board = new Board(generateTerrain(seed));
    board.placeRandom(createRng(seed));
    assert.ok(board.isComplete(), `seed ${seed}`);
  }
});
