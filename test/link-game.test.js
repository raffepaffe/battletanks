import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.js';
import { Board } from '../src/core/board.js';
import { generateTerrain } from '../src/core/terrain.js';
import { chooseAction } from '../src/computer/strategy.js';
import { GameController } from '../src/game/controller.js';
import { LinkOpponent } from '../src/game/opponent-link.js';
import { Session } from '../src/link/session.js';
import { FakeClock, createLink } from './helpers/fake-link.js';

/** Two devices, paired over a fake room, each with a controller and a random fleet. */
async function twoDevices({ lossRate = 0, seed = 1 } = {}) {
  const clock = new FakeClock();
  const lossRng = createRng(seed * 7);
  const link = createLink(clock, { lose: () => lossRng.next() < lossRate });
  const sides = ['a', 'b'].map((name, i) => {
    const random = createRng(seed * 100 + i);
    const session = new Session({ transport: link[name], timers: clock.timers, random: random.next });
    return { name, session, random, events: [] };
  });
  sides[0].session.listen();
  sides[1].session.listen();
  sides[1].session.call();
  await clock.until(() => sides.every((s) => s.session.state === 'paired'));

  for (const side of sides) {
    side.opponent = new LinkOpponent({ session: side.session, randomSalt: () => side.random.int(0xffffffff) });
    side.board = new Board(side.opponent.terrain);
    side.board.placeRandom(side.random);
    side.game = new GameController({ opponent: side.opponent, board: side.board, onEvent: (e) => side.events.push(e) });
  }
  return { clock, link, sides };
}

async function playToTheEnd({ clock, sides }) {
  let begun = 0;
  for (const side of sides) side.game.begin().then(() => { begun++; });
  await clock.until(() => begun === 2);
  const rng = createRng(4242);
  let moves = 0;
  while (!sides.every((s) => s.game.over)) {
    const side = sides.find((s) => s.game.turn === 'me');
    assert.ok(side, 'exactly one side must be able to move');
    assert.equal(sides.filter((s) => s.game.turn === 'me').length, 1);
    let done = false;
    side.game.fire(chooseAction(side.game.duel.tracker, rng, 'hard')).then(() => { done = true; });
    await clock.until(() => done);
    assert.ok(++moves < 220);
  }
  return moves;
}

async function finishBoth({ clock, sides }) {
  const reveals = [null, null];
  sides.forEach((side, i) => side.game.finish().then((r) => { reveals[i] = r; }));
  await clock.until(() => reveals.every(Boolean));
  return reveals;
}

test('both devices derive the same battlefield and agree on who starts', async () => {
  const { sides } = await twoDevices();
  const [a, b] = sides;
  assert.deepEqual(a.opponent.terrain, b.opponent.terrain);
  assert.deepEqual(a.opponent.terrain, generateTerrain(a.session.seed));
  assert.notEqual(a.opponent.meFirst, b.opponent.meFirst);
});

test('a full two-device game over a clean link ends with one winner and honest audits', async () => {
  const ctx = await twoDevices({ seed: 3 });
  await playToTheEnd(ctx);
  const [a, b] = ctx.sides;
  assert.deepEqual([a.game.winner, b.game.winner].sort(), ['me', 'them']);
  const reveals = await finishBoth(ctx);
  assert.equal(reveals[0].verdict.ok, true, reveals[0].verdict.reason);
  assert.equal(reveals[1].verdict.ok, true, reveals[1].verdict.reason);
  // Each side ends up knowing the other's real layout.
  assert.deepEqual(reveals[0].layout, b.board.layout());
  assert.deepEqual(reveals[1].layout, a.board.layout());
  assert.equal(a.events.some((e) => e.type === 'fault'), false);
});

test('a full two-device game survives a link that loses a quarter of all chirps', async () => {
  for (const seed of [5, 6]) {
    const ctx = await twoDevices({ seed, lossRate: 0.25 });
    await playToTheEnd(ctx);
    const reveals = await finishBoth(ctx);
    assert.equal(reveals[0].verdict.ok, true, reveals[0].verdict.reason);
    assert.equal(reveals[1].verdict.ok, true, reveals[1].verdict.reason);
    const [a, b] = ctx.sides;
    assert.deepEqual([a.game.winner, b.game.winner].sort(), ['me', 'them']);
    // What each side believes about the enemy matches the enemy's real board.
    for (const [me, them] of [[a, b], [b, a]]) {
      for (let c = 0; c < 100; c++) {
        const believedHit = me.game.duel.tracker.state[c] >= 2;
        const reallyHit = them.board.isHit(c) && them.board.unitAt(c) >= 0;
        assert.equal(believedHit, reallyHit, `cell ${c}`);
      }
    }
  }
});

test('a device that reveals a different fleet than it committed to is caught', async () => {
  const ctx = await twoDevices({ seed: 8 });
  await playToTheEnd(ctx);
  const [a, b] = ctx.sides;
  // b pretends its fleet stood somewhere else.
  const fake = new Board(b.opponent.terrain);
  fake.placeRandom(createRng(999));
  b.opponent._layout = fake.layout();
  const reveals = await finishBoth(ctx);
  assert.equal(reveals[0].verdict.ok, false);
  assert.match(reveals[0].verdict.reason, /fingerprint/);
  assert.equal(reveals[1].verdict.ok, true);
});

test('closing the link ends a waiting move with an error instead of hanging', async () => {
  const ctx = await twoDevices({ seed: 9 });
  const { clock, sides } = ctx;
  let begun = 0;
  for (const side of sides) side.game.begin().then(() => { begun++; });
  await clock.until(() => begun === 2);
  const side = sides.find((s) => s.game.turn === 'me');
  const other = sides.find((s) => s !== side);
  other.opponent.close();
  const move = side.game.fire(chooseAction(side.game.duel.tracker, createRng(1), 'easy'));
  await clock.advance(4000);
  side.opponent.close();
  await assert.rejects(move, /closed/);
  assert.ok(side.events.some((e) => e.type === 'fault'));
});
