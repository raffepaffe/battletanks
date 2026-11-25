import { CELLS, neighbours } from './grid.js';
import { createRng } from './rng.js';

export const OPEN = 0;
export const ROCK = 1;
export const LAKE = 2;

const LAKES = 2;
const ROCKS = 4;

/**
 * Terrain for a match, derived only from the seed so two devices that agree on a
 * seed get identical battlefields. Rocks and lakes cannot hold tanks and cannot
 * be shot at.
 */
export function generateTerrain(seed) {
  const rng = createRng((seed ^ 0x7e55a11d) >>> 0);
  const terrain = new Uint8Array(CELLS);

  for (let i = 0; i < LAKES; i++) {
    const size = 2 + rng.int(2);
    let cell = pickOpen(terrain, rng);
    terrain[cell] = LAKE;
    for (let n = 1; n < size; n++) {
      const options = neighbours(cell).filter((c) => terrain[c] === OPEN);
      if (options.length === 0) break;
      cell = rng.pick(options);
      terrain[cell] = LAKE;
    }
  }
  for (let i = 0; i < ROCKS; i++) terrain[pickOpen(terrain, rng)] = ROCK;
  return terrain;
}

function pickOpen(terrain, rng) {
  for (;;) {
    const cell = rng.int(CELLS);
    if (terrain[cell] === OPEN) return cell;
  }
}
