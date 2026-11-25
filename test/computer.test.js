import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.js';
import { H, cellAt, CELLS, neighbours } from '../src/core/grid.js';
import { FLEET } from '../src/core/fleet.js';
import { generateTerrain } from '../src/core/terrain.js';
import { Board, SHELL, STRIKE, SCOUT } from '../src/core/board.js';
import { Tracker } from '../src/core/tracker.js';
import { chooseAction, densityMap, LEVELS } from '../src/computer/strategy.js';

const openTerrain = () => new Uint8Array(CELLS);

function standardBoard(terrain = openTerrain()) {
  const b = new Board(terrain);
  FLEET.forEach((u, i) => b.place(u.id, cellAt(0, i * 2), H));
  return b;
}

/** Play one attacker against a board until the fleet is gone. Returns the number of actions. */
function playOut(level, seed) {
  const terrain = generateTerrain(seed);
  const board = new Board(terrain);
  board.placeRandom(createRng(seed * 31 + 1));
  const tracker = new Tracker(terrain);
  const rng = createRng(seed * 17 + 5);
  let actions = 0;
  while (!tracker.over) {
    const action = chooseAction(tracker, rng, level);
    assert.ok(tracker.canDo(action), `${level} chose an illegal action: ${JSON.stringify(action)}`);
    tracker.apply(action, board.resolve(action));
    actions++;
    assert.ok(actions <= 110, `${level} did not finish`);
  }
  return actions;
}

test('there are three difficulty levels', () => {
  assert.deepEqual(LEVELS, ['easy', 'medium', 'hard']);
});

test('every level only ever chooses legal actions and finishes the battle', () => {
  for (const level of LEVELS) {
    for (let seed = 1; seed <= 25; seed++) playOut(level, seed);
  }
});

test('an unknown level is rejected', () => {
  assert.throws(() => chooseAction(new Tracker(openTerrain()), createRng(1), 'impossible'));
});

test('harder levels need fewer actions on average', () => {
  const average = (level) => {
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) total += playOut(level, seed);
    return total / 40;
  };
  const easy = average('easy'), medium = average('medium'), hard = average('hard');
  assert.ok(medium < easy - 5, `medium ${medium} should clearly beat easy ${easy}`);
  assert.ok(hard < medium - 3, `hard ${hard} should clearly beat medium ${medium}`);
  assert.ok(hard < 55, `hard should average under 55 actions, got ${hard}`);
});

test('after a hit, medium and hard follow up next to it', () => {
  for (const level of ['medium', 'hard']) {
    const board = standardBoard(), tracker = new Tracker(openTerrain());
    const first = { kind: SHELL, cell: cellAt(2, 4) };
    tracker.apply(first, board.resolve(first));
    // Use up the specials so the next choice must be a shell.
    for (const a of [{ kind: SCOUT, cell: 99 }, { kind: STRIKE, cell: 97, orient: H }]) {
      tracker.apply(a, board.resolve(a));
    }
    const next = chooseAction(tracker, createRng(3), level);
    assert.equal(next.kind, SHELL);
    assert.ok(neighbours(cellAt(2, 4)).includes(next.cell), `${level} fired at ${next.cell}`);
  }
});

test('hard extends a line of two hits along its axis', () => {
  const board = standardBoard(), tracker = new Tracker(openTerrain());
  const setup = [
    { kind: SCOUT, cell: 99 }, { kind: STRIKE, cell: 97, orient: H },
    { kind: SHELL, cell: cellAt(2, 0) }, { kind: SHELL, cell: cellAt(3, 0) },
  ];
  for (const a of setup) tracker.apply(a, board.resolve(a));
  const next = chooseAction(tracker, createRng(8), 'hard');
  assert.ok([cellAt(1, 0), cellAt(4, 0)].includes(next.cell), `fired at ${next.cell}`);
});

test('density map is zero where no remaining unit can be', () => {
  const terrain = openTerrain();
  const board = standardBoard(terrain), tracker = new Tracker(terrain);
  const scout = { kind: SCOUT, cell: cellAt(8, 8) };
  tracker.apply(scout, board.resolve(scout)); // reports an empty corner
  const miss = { kind: SHELL, cell: cellAt(5, 5) };
  tracker.apply(miss, board.resolve(miss));
  const d = densityMap(tracker);
  assert.equal(d[cellAt(5, 5)], 0);
  assert.equal(d[cellAt(9, 9)], 0);
  assert.ok(d[cellAt(4, 4)] > 0);
});

test('easy never uses the special weapons, hard uses both during a game', () => {
  const kinds = (level) => {
    const terrain = generateTerrain(11);
    const board = new Board(terrain);
    board.placeRandom(createRng(12));
    const tracker = new Tracker(terrain), rng = createRng(13), used = new Set();
    while (!tracker.over) {
      const a = chooseAction(tracker, rng, level);
      used.add(a.kind);
      tracker.apply(a, board.resolve(a));
    }
    return used;
  };
  assert.deepEqual([...kinds('easy')], [SHELL]);
  const hard = kinds('hard');
  assert.ok(hard.has(SCOUT) && hard.has(STRIKE));
});
