import { CELLS, H, V, isCell, isOrient, lineCells, areaCells } from './grid.js';
import { FLEET, isUnitId } from './fleet.js';
import { OPEN } from './terrain.js';
import { RuleError } from './errors.js';

/** Action kinds. The numbers go over the sound link. */
export const SHELL = 0;
export const STRIKE = 1;
export const SCOUT = 2;

/** Per-cell outcomes. The numbers go over the sound link. */
export const SKIP = 0;
export const MISS = 1;
export const HIT = 2;

export const STRIKE_LENGTH = 3;

/**
 * One player's own battlefield: where their units stand and what has hit them.
 * This is the defending side of the rules. It validates every incoming action
 * itself and never trusts the attacker to have checked anything.
 */
export class Board {
  constructor(terrain) {
    if (!(terrain instanceof Uint8Array) || terrain.length !== CELLS) {
      throw new RuleError('terrain must cover the whole grid');
    }
    this.terrain = terrain;
    this.placements = FLEET.map(() => null);
    this._unit = new Int8Array(CELLS).fill(-1);
    this._shot = new Uint8Array(CELLS);
    this._started = false;
    this._strikeUsed = false;
    this._scoutUsed = false;
  }

  canPlace(id, origin, orient) {
    if (this._started || !isUnitId(id) || this.placements[id]) return false;
    const cells = lineCells(origin, orient, FLEET[id].length);
    return cells !== null && cells.every((c) => this.terrain[c] === OPEN && this._unit[c] === -1);
  }

  place(id, origin, orient) {
    if (!this.canPlace(id, origin, orient)) throw new RuleError('unit cannot be placed there');
    for (const c of lineCells(origin, orient, FLEET[id].length)) this._unit[c] = id;
    this.placements[id] = { origin, orient };
  }

  remove(id) {
    if (this._started) throw new RuleError('units cannot move once the battle has started');
    if (!isUnitId(id) || !this.placements[id]) return;
    for (const c of this.cellsOf(id)) this._unit[c] = -1;
    this.placements[id] = null;
  }

  clear() {
    for (const u of FLEET) this.remove(u.id);
  }

  /** Place every unplaced unit at random. Retries from scratch if it paints itself into a corner. */
  placeRandom(rng) {
    const fixed = this.placements.map((p) => p && { ...p });
    for (let attempt = 0; attempt < 200; attempt++) {
      let ok = true;
      for (const u of FLEET) {
        if (this.placements[u.id]) continue;
        let placed = false;
        for (let tries = 0; tries < 200 && !placed; tries++) {
          const origin = rng.int(CELLS), orient = rng.int(2) ? V : H;
          if (this.canPlace(u.id, origin, orient)) {
            this.place(u.id, origin, orient);
            placed = true;
          }
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) return;
      for (const u of FLEET) if (!fixed[u.id]) this.remove(u.id);
    }
    throw new RuleError('no room for the fleet on this terrain');
  }

  isComplete() {
    return this.placements.every(Boolean);
  }

  cellsOf(id) {
    const p = this.placements[id];
    return p ? lineCells(p.origin, p.orient, FLEET[id].length) : [];
  }

  unitAt(cell) {
    return isCell(cell) ? this._unit[cell] : -1;
  }

  /** True if the cell has been shot at (hit or miss). */
  isHit(cell) {
    return isCell(cell) && this._shot[cell] === 1;
  }

  intactCount(id) {
    return this.cellsOf(id).filter((c) => !this._shot[c]).length;
  }

  isSunk(id) {
    return Boolean(this.placements[id]) && this.intactCount(id) === 0;
  }

  allSunk() {
    return this.isComplete() && FLEET.every((u) => this.isSunk(u.id));
  }

  /**
   * Apply an attacker's action and report what happened.
   * Throws RuleError, without changing anything, if the action is not legal.
   */
  resolve(action) {
    if (!action || typeof action !== 'object') throw new RuleError('no action');
    if (!this.isComplete()) throw new RuleError('the fleet is not placed yet');
    if (this.allSunk()) throw new RuleError('the battle is already over');
    const { kind, cell, orient } = action;
    if (!isCell(cell)) throw new RuleError('target is off the battlefield');

    if (kind === SCOUT) {
      if (this._scoutUsed) throw new RuleError('the scout drone was already used');
      this._scoutUsed = true;
      this._started = true;
      const count = areaCells(cell).filter((c) => this._unit[c] !== -1 && !this._shot[c]).length;
      return { kind, cells: [], sunk: [], count, over: false };
    }

    let targets;
    if (kind === SHELL) {
      if (this.terrain[cell] !== OPEN) throw new RuleError('cannot fire at rocks or lakes');
      if (this._shot[cell]) throw new RuleError('that cell was already hit');
      targets = [cell];
    } else if (kind === STRIKE) {
      if (this._strikeUsed) throw new RuleError('the air strike was already used');
      if (!isOrient(orient)) throw new RuleError('air strike needs a direction');
      targets = lineCells(cell, orient, STRIKE_LENGTH);
      if (!targets) throw new RuleError('air strike does not fit on the battlefield');
      if (!targets.some((c) => this._fresh(c))) throw new RuleError('air strike would hit nothing new');
      this._strikeUsed = true;
    } else {
      throw new RuleError('unknown action');
    }

    this._started = true;
    const damaged = new Set();
    const cells = targets.map((c) => {
      if (!this._fresh(c)) return { cell: c, outcome: SKIP };
      this._shot[c] = 1;
      const id = this._unit[c];
      if (id === -1) return { cell: c, outcome: MISS };
      damaged.add(id);
      return { cell: c, outcome: HIT };
    });
    const sunk = [...damaged].sort((a, b) => a - b).filter((id) => this.isSunk(id))
      .map((id) => ({ id, ...this.placements[id] }));
    return { kind, cells, sunk, count: 0, over: this.allSunk() };
  }

  _fresh(cell) {
    return this.terrain[cell] === OPEN && !this._shot[cell];
  }

  /** Five bytes, one per unit: origin in the high seven bits, orientation in the low bit. */
  layout() {
    if (!this.isComplete()) throw new RuleError('the fleet is not placed yet');
    return Uint8Array.from(this.placements, (p) => (p.origin << 1) | p.orient);
  }

  static fromLayout(terrain, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== FLEET.length) {
      throw new RuleError('layout must have one byte per unit');
    }
    const board = new Board(terrain);
    bytes.forEach((b, id) => board.place(id, b >> 1, b & 1));
    return board;
  }
}
