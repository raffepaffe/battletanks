import { Tracker, copyAction } from './tracker.js';
import { RuleError } from './errors.js';

/**
 * One player's side of a match: their own board, what they know about the enemy,
 * and whose turn it is. Each device (and the computer opponent) runs its own
 * Duel; the two only exchange actions and results.
 */
export class Duel {
  constructor({ terrain, board, first }) {
    if (!board.isComplete()) throw new RuleError('the fleet is not placed yet');
    this.terrain = terrain;
    this.board = board;
    this.tracker = new Tracker(terrain);
    this.turn = first ? 'me' : 'them';
    this.pending = null;
    this.over = false;
    this.winner = null;
  }

  canAct(action) {
    return !this.over && this.turn === 'me' && !this.pending && this.tracker.canDo(action);
  }

  /** Commit to one of our own actions. It then waits for the enemy's report. */
  beginAction(action) {
    if (this.over) throw new RuleError('the battle is over');
    if (this.turn !== 'me') throw new RuleError('it is not your turn');
    if (this.pending) throw new RuleError('still waiting for the last report');
    if (!this.tracker.canDo(action)) throw new RuleError('that action is not allowed now');
    this.pending = copyAction(action);
    return this.pending;
  }

  /** Record the enemy's report for the pending action and pass the turn. */
  completeAction(result) {
    if (!this.pending) throw new RuleError('no action is waiting for a report');
    this.tracker.apply(this.pending, result);
    this.pending = null;
    if (this.tracker.over) this._end('me');
    else this.turn = 'them';
  }

  /** Resolve an enemy action on our board and return the report to send back. */
  receiveAction(action) {
    if (this.over) throw new RuleError('the battle is over');
    if (this.turn !== 'them') throw new RuleError('it is not the enemy\'s turn');
    const result = this.board.resolve(action);
    if (result.over) this._end('them');
    else this.turn = 'me';
    return result;
  }

  _end(winner) {
    this.over = true;
    this.winner = winner;
    this.turn = null;
  }
}
