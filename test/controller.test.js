import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.js';
import { Board, SHELL } from '../src/core/board.js';
import { RuleError } from '../src/core/errors.js';
import { chooseAction } from '../src/computer/strategy.js';
import { GameController } from '../src/game/controller.js';
import { ComputerOpponent } from '../src/game/opponent-computer.js';

const noDelay = () => Promise.resolve();

function setup({ seed = 5, level = 'medium' } = {}) {
  const opponent = new ComputerOpponent({ seed, level, rng: createRng(seed + 1), delay: noDelay });
  const board = new Board(opponent.terrain);
  board.placeRandom(createRng(seed + 2));
  const events = [];
  const game = new GameController({ opponent, board, onEvent: (e) => events.push(e) });
  return { opponent, board, game, events };
}

/** Wait until the controller says it is our turn again, or the battle is over. */
async function myTurn(game) {
  for (let i = 0; i < 1000; i++) {
    if (game.over || game.turn === 'me') return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('the opponent never moved');
}

test('the computer opponent sets up terrain and lets the player start', async () => {
  const { opponent, game } = setup();
  assert.equal(opponent.terrain.length, 100);
  assert.equal(opponent.meFirst, true);
  await game.begin();
  assert.equal(game.turn, 'me');
  assert.equal(game.over, false);
});

test('firing reports the result and then the computer takes its turn', async () => {
  const { game, events } = setup();
  await game.begin();
  const action = chooseAction(game.duel.tracker, createRng(1), 'easy');
  const result = await game.fire(action);
  assert.equal(result.kind, SHELL);
  await myTurn(game);
  assert.deepEqual(events.map((e) => e.type), ['begin', 'fired', 'myResult', 'theirAction']);
  assert.deepEqual(events[1].action, action);
  assert.deepEqual(events[2].result, result);
  assert.ok(events[3].action && events[3].result);
});

test('firing out of turn or at an illegal target is refused without side effects', async () => {
  const { game, events, opponent } = setup();
  await assert.rejects(() => game.fire({ kind: SHELL, cell: 0 }), RuleError, 'before begin');
  await game.begin();
  const blocked = opponent.terrain.findIndex((t) => t !== 0);
  await assert.rejects(() => game.fire({ kind: SHELL, cell: blocked }), RuleError);
  await assert.rejects(() => game.fire({ kind: SHELL, cell: 100 }), RuleError);
  assert.deepEqual(events.map((e) => e.type), ['begin']);
  assert.equal(game.turn, 'me');
});

test('a full game against each level ends with one winner and a clean audit', async () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const { game, events } = setup({ seed: 21, level });
    await game.begin();
    const rng = createRng(77);
    while (!game.over) {
      await game.fire(chooseAction(game.duel.tracker, rng, 'hard'));
      await myTurn(game);
    }
    assert.ok(['me', 'them'].includes(game.winner));
    const last = events[events.length - 1];
    assert.deepEqual(last, { type: 'over', winner: game.winner });
    assert.equal(events.filter((e) => e.type === 'over').length, 1);

    const reveal = await game.finish();
    assert.equal(reveal.verdict.ok, true, reveal.verdict.reason);
    assert.equal(reveal.layout.length, 5);
    await assert.rejects(() => game.fire({ kind: SHELL, cell: 0 }), RuleError);
  }
});

test('the computer can be told to move first', async () => {
  const opponent = new ComputerOpponent({ seed: 9, level: 'easy', rng: createRng(1), delay: noDelay, meFirst: false });
  const board = new Board(opponent.terrain);
  board.placeRandom(createRng(2));
  const events = [];
  const game = new GameController({ opponent, board, onEvent: (e) => events.push(e) });
  await game.begin();
  assert.equal(game.turn === 'me' || game.turn === 'them', true);
  await myTurn(game);
  assert.equal(events[1].type, 'theirAction');
  assert.equal(game.turn, 'me');
});

test('finish is refused while the battle is still running', async () => {
  const { game } = setup();
  await game.begin();
  await assert.rejects(() => game.finish(), RuleError);
});

test('closing the opponent stops the computer from moving', async () => {
  const { game, events, opponent } = setup();
  await game.begin();
  const p = game.fire(chooseAction(game.duel.tracker, createRng(1), 'easy'));
  opponent.close();
  await p;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.some((e) => e.type === 'theirAction'), false);
});
