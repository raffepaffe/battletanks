import { CELLS, isCell, isOrient, lineCells, areaCells } from './grid.js';
import { FLEET, FLEET_CELLS, isUnitId } from './fleet.js';
import { OPEN } from './terrain.js';
import { SHELL, STRIKE, SCOUT, SKIP, MISS, HIT, STRIKE_LENGTH } from './board.js';
import { RuleError, ProtocolError } from './errors.js';

/** What the attacker knows about one enemy cell. */
export const UNKNOWN = 0;
export const T_MISS = 1;
export const T_HIT = 2;
export const T_SUNK = 3;

/**
 * The attacking side of the rules: everything one player has learned about the
 * enemy battlefield. It checks its own actions before they are sent (RuleError)
 * and checks every reported result against what it already knows (ProtocolError),
 * because the report comes from another device that may be buggy or dishonest.
 */
export class Tracker {
  constructor(terrain) {
    if (!(terrain instanceof Uint8Array) || terrain.length !== CELLS) {
      throw new RuleError('terrain must cover the whole grid');
    }
    this.terrain = terrain;
    this.state = new Uint8Array(CELLS);
    /** Cells a scout report has proven empty. */
    this.knownEmpty = new Uint8Array(CELLS);
    this.sunk = [];
    this.scouts = [];
    this.strikeUsed = false;
    this.scoutUsed = false;
    this.over = false;
    /** Every action with its reported result, for the end-of-game audit. */
    this.log = [];
  }

  isSunk(id) {
    return this.sunk.some((s) => s.id === id);
  }

  remainingIds() {
    return FLEET.map((u) => u.id).filter((id) => !this.isSunk(id));
  }

  /** A cell that can still be fired at. */
  isFresh(cell) {
    return isCell(cell) && this.terrain[cell] === OPEN && this.state[cell] === UNKNOWN;
  }

  hitCount() {
    let n = 0;
    for (const s of this.state) if (s === T_HIT || s === T_SUNK) n++;
    return n;
  }

  /** Cells an action would affect, or null if the action is not legal right now. */
  targetCells(action) {
    if (!action || typeof action !== 'object' || this.over || !isCell(action.cell)) return null;
    const { kind, cell, orient } = action;
    if (kind === SHELL) return this.isFresh(cell) ? [cell] : null;
    if (kind === SCOUT) return this.scoutUsed ? null : areaCells(cell);
    if (kind === STRIKE) {
      if (this.strikeUsed || !isOrient(orient)) return null;
      const cells = lineCells(cell, orient, STRIKE_LENGTH);
      return cells && cells.some((c) => this.isFresh(c)) ? cells : null;
    }
    return null;
  }

  canDo(action) {
    return this.targetCells(action) !== null;
  }

  /**
   * Record the reported result of one of our actions.
   * Nothing changes if the action is illegal or the report is inconsistent.
   */
  apply(action, result) {
    const targets = this.targetCells(action);
    if (targets === null) throw new RuleError('that action is not allowed now');
    const plan = this._check(action, targets, result);

    if (action.kind === SCOUT) {
      this.scoutUsed = true;
      this.scouts.push({ center: action.cell, count: result.count, found: 0 });
    } else {
      if (action.kind === STRIKE) this.strikeUsed = true;
      for (const c of plan.misses) this.state[c] = T_MISS;
      for (const c of plan.hits) {
        this.state[c] = T_HIT;
        for (const s of this.scouts) if (areaCells(s.center).includes(c)) s.found++;
      }
      for (const s of plan.sunk) {
        for (const c of lineCells(s.origin, s.orient, FLEET[s.id].length)) this.state[c] = T_SUNK;
        this.sunk.push({ id: s.id, origin: s.origin, orient: s.orient });
      }
    }
    for (const s of this.scouts) {
      if (s.found >= s.count) {
        for (const c of areaCells(s.center)) if (this.state[c] === UNKNOWN) this.knownEmpty[c] = 1;
      }
    }
    this.over = plan.over;
    this.log.push({ action: copyAction(action), result: copyResult(result) });
  }

  _check(action, targets, result) {
    const fail = (why) => { throw new ProtocolError(`inconsistent report: ${why}`); };
    if (!result || typeof result !== 'object') fail('no result');
    if (result.kind !== action.kind) fail('wrong kind of result');
    if (!Array.isArray(result.cells) || !Array.isArray(result.sunk)) fail('malformed result');
    if (typeof result.over !== 'boolean') fail('malformed result');

    if (action.kind === SCOUT) {
      if (result.cells.length || result.sunk.length || result.over) fail('a scout cannot damage anything');
      const possible = targets.filter((c) => this.isFresh(c) && !this.knownEmpty[c]).length;
      const intactLeft = FLEET_CELLS - this.hitCount();
      if (!Number.isInteger(result.count) || result.count < 0 || result.count > Math.min(possible, intactLeft)) {
        fail('impossible scout count');
      }
      return { hits: [], misses: [], sunk: [], over: false };
    }

    if (result.count !== 0) fail('only a scout reports a count');
    if (result.cells.length !== targets.length) fail('wrong number of cells');
    const hits = [], misses = [];
    targets.forEach((cell, i) => {
      const entry = result.cells[i];
      if (!entry || entry.cell !== cell) fail('wrong cell');
      const fresh = this.isFresh(cell);
      if (entry.outcome === SKIP) {
        if (fresh) fail('a fresh cell was skipped');
      } else if (entry.outcome === MISS || entry.outcome === HIT) {
        if (!fresh) fail('a blocked cell was not skipped');
        if (entry.outcome === HIT) {
          if (this.knownEmpty[cell]) fail('hit on a cell the scout reported empty');
          hits.push(cell);
        } else {
          misses.push(cell);
        }
      } else {
        fail('unknown outcome');
      }
    });

    const seen = new Set();
    const sunk = result.sunk.map((s) => {
      if (!s || !isUnitId(s.id) || this.isSunk(s.id) || seen.has(s.id)) fail('bad destroyed unit');
      seen.add(s.id);
      const cells = lineCells(s.origin, s.orient, FLEET[s.id].length);
      if (!cells) fail('destroyed unit is off the battlefield');
      // Every tank of the unit must be burning, and at least one must be from this action.
      const allHit = cells.every((c) => hits.includes(c) || this.state[c] === T_HIT);
      if (!allHit) fail('destroyed unit has tanks that were never hit');
      if (!cells.some((c) => hits.includes(c))) fail('destroyed unit was not hit by this action');
      return { id: s.id, origin: s.origin, orient: s.orient, cells };
    });
    const claimed = sunk.flatMap((s) => s.cells);
    if (new Set(claimed).size !== claimed.length) fail('destroyed units overlap');

    const totalHits = this.hitCount() + hits.length;
    const totalSunk = this.sunk.length + sunk.length;
    if (totalHits > FLEET_CELLS) fail('more hits than tanks');
    const allGone = totalSunk === FLEET.length;
    if (result.over !== allGone) fail('battle end does not match the destroyed units');
    if (allGone && totalHits !== FLEET_CELLS) fail('hits do not add up to the fleet');
    return { hits, misses, sunk, over: allGone };
  }
}

export const copyAction = (a) => (a.kind === STRIKE
  ? { kind: a.kind, cell: a.cell, orient: a.orient }
  : { kind: a.kind, cell: a.cell });

export const copyResult = (r) => ({
  kind: r.kind,
  cells: r.cells.map((c) => ({ cell: c.cell, outcome: c.outcome })),
  sunk: r.sunk.map((s) => ({ id: s.id, origin: s.origin, orient: s.orient })),
  count: r.count,
  over: r.over,
});
