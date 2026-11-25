import { CELLS, H, V, lineCells, areaCells, neighbours, colOf, rowOf } from '../core/grid.js';
import { FLEET } from '../core/fleet.js';
import { OPEN } from '../core/terrain.js';
import { SHELL, STRIKE, SCOUT, STRIKE_LENGTH } from '../core/board.js';
import { UNKNOWN, T_HIT } from '../core/tracker.js';

export const LEVELS = ['easy', 'medium', 'hard'];

/**
 * Pick the computer's next action. It sees only its Tracker, exactly what a
 * human attacker would know, so it cannot cheat.
 */
export function chooseAction(tracker, rng, level) {
  if (level === 'easy') return easy(tracker, rng);
  if (level === 'medium') return medium(tracker, rng);
  if (level === 'hard') return hard(tracker, rng);
  throw new Error(`unknown level: ${level}`);
}

const freshCells = (tracker) => {
  const out = [];
  for (let c = 0; c < CELLS; c++) if (tracker.isFresh(c)) out.push(c);
  return out;
};

const openHits = (tracker) => {
  const out = [];
  for (let c = 0; c < CELLS; c++) if (tracker.state[c] === T_HIT) out.push(c);
  return out;
};

/** Fresh cells next to a burning tank whose unit is not destroyed yet. */
const followUps = (tracker) => {
  const out = new Set();
  for (const hit of openHits(tracker)) {
    for (const n of neighbours(hit)) if (tracker.isFresh(n) && !tracker.knownEmpty[n]) out.add(n);
  }
  return [...out];
};

const shell = (cell) => ({ kind: SHELL, cell });

function easy(tracker, rng) {
  const near = followUps(tracker);
  if (near.length && rng.next() < 0.5) return shell(rng.pick(near));
  return shell(rng.pick(freshCells(tracker)));
}

function medium(tracker, rng) {
  const near = followUps(tracker);
  if (near.length) {
    // Prefer continuing a line: the cell opposite another hit.
    const inLine = near.filter((c) => neighbours(c).some((hit) => {
      if (tracker.state[hit] !== T_HIT) return false;
      const beyond = hit + (hit - c);
      const sameAxis = colOf(beyond) === colOf(c) || rowOf(beyond) === rowOf(c);
      return beyond >= 0 && beyond < CELLS && sameAxis && tracker.state[beyond] === T_HIT;
    }));
    return shell(rng.pick(inLine.length ? inLine : near));
  }
  if (!tracker.strikeUsed && tracker.log.length >= 4 && rng.next() < 0.25) {
    const lines = strikeLines(tracker).filter((l) => l.cells.every((c) => tracker.isFresh(c)));
    if (lines.length) {
      const line = rng.pick(lines);
      return { kind: STRIKE, cell: line.cell, orient: line.orient };
    }
  }
  const fresh = freshCells(tracker).filter((c) => !tracker.knownEmpty[c]);
  const checker = fresh.filter((c) => (colOf(c) + rowOf(c)) % 2 === 0);
  const pool = checker.length ? checker : fresh.length ? fresh : freshCells(tracker);
  return shell(rng.pick(pool));
}

function hard(tracker, rng) {
  const density = densityMap(tracker);
  const hunting = openHits(tracker).length === 0;
  const moves = tracker.log.length;

  if (hunting && !tracker.scoutUsed && moves >= 2) {
    let best = null;
    for (let c = 0; c < CELLS; c++) {
      const area = areaCells(c);
      if (area.length < 9) continue;
      const score = area.reduce((sum, a) => sum + density[a], 0) + rng.next() * 1e-6;
      if (!best || score > best.score) best = { cell: c, score };
    }
    if (best && best.score > 0) return { kind: SCOUT, cell: best.cell };
  }

  if (!tracker.strikeUsed && moves >= 3) {
    let best = null;
    for (const line of strikeLines(tracker)) {
      if (!line.cells.every((c) => tracker.isFresh(c))) continue;
      const score = line.cells.reduce((sum, c) => sum + density[c], 0) + rng.next() * 1e-6;
      if (!best || score > best.score) best = { ...line, score };
    }
    if (best && best.score > 0) return { kind: STRIKE, cell: best.cell, orient: best.orient };
  }

  let top = -1, picks = [];
  for (let c = 0; c < CELLS; c++) {
    if (!tracker.isFresh(c)) continue;
    if (density[c] > top) { top = density[c]; picks = [c]; } else if (density[c] === top) picks.push(c);
  }
  return shell(rng.pick(picks));
}

function strikeLines(tracker) {
  const out = [];
  for (let cell = 0; cell < CELLS; cell++) {
    for (const orient of [H, V]) {
      const cells = lineCells(cell, orient, STRIKE_LENGTH);
      if (cells && cells.some((c) => tracker.isFresh(c))) out.push({ cell, orient, cells });
    }
  }
  return out;
}

/**
 * For every cell, how many ways the remaining enemy units could cover it given
 * everything known so far. When there are burning tanks of a unit that is not
 * destroyed yet, only placements through them count, and placements through
 * several of them count much more.
 */
export function densityMap(tracker) {
  const targeting = openHits(tracker).length > 0;
  let density = countPlacements(tracker, targeting);
  if (targeting && !density.some((d) => d > 0)) density = countPlacements(tracker, false);

  if (!targeting) {
    // A scout report says how crowded an area is; lean towards or away from it.
    for (const s of tracker.scouts) {
      const area = areaCells(s.center).filter((c) => tracker.isFresh(c));
      const left = s.count - s.found;
      if (left <= 0 || area.length === 0) continue;
      const factor = Math.min(6, Math.max(0.3, (left / area.length) / 0.18));
      for (const c of area) density[c] *= factor;
    }
  }
  return density;
}

function countPlacements(tracker, mustCoverHit) {
  const density = new Float64Array(CELLS);
  for (const id of tracker.remainingIds()) {
    const length = FLEET[id].length;
    for (let origin = 0; origin < CELLS; origin++) {
      for (const orient of [H, V]) {
        const cells = lineCells(origin, orient, length);
        if (!cells) continue;
        let hits = 0, possible = true;
        for (const c of cells) {
          const s = tracker.state[c];
          if (s === T_HIT) hits++;
          else if (s !== UNKNOWN || tracker.terrain[c] !== OPEN || tracker.knownEmpty[c]) { possible = false; break; }
        }
        if (!possible || (mustCoverHit && hits === 0)) continue;
        const weight = hits === 0 ? 1 : 12 ** (hits - 1);
        for (const c of cells) if (tracker.state[c] === UNKNOWN) density[c] += weight;
      }
    }
  }
  return density;
}
