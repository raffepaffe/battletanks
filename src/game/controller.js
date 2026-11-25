import { Duel } from '../core/duel.js';
import { auditReveal } from '../core/commitment.js';
import { RuleError } from '../core/errors.js';

/**
 * Runs one match for the local player against any opponent (the computer or
 * another device). It has no knowledge of the screen: the UI calls `fire` and
 * listens to events.
 *
 * An opponent provides:
 *   terrain, meFirst            known before the battle
 *   onAction = (action) => result   set by the controller; called for each enemy action
 *   ready(board) -> Promise     resolves when both sides have placed their fleets
 *   resolve(action) -> Promise<result>
 *   reveal() -> Promise<{ layout, salt, commit }>   the enemy fleet, after the battle
 *   onFault = (error) => {}         set by the controller; called if the opponent cannot go on
 *   close()
 *
 * Events: begin, fired {action}, myResult {action, result},
 *         theirAction {action, result}, over {winner}, fault {error}.
 */
export class GameController {
  constructor({ opponent, board, onEvent = () => {}, onError = (error) => console.error(error) }) {
    this.opponent = opponent;
    this.board = board;
    this.onEvent = onEvent;
    this.onError = onError;
    this.duel = null;
    this._begun = false;
  }

  get turn() { return this._begun ? this.duel.turn : null; }
  get over() { return this._begun && this.duel.over; }
  get winner() { return this._begun ? this.duel.winner : null; }

  async begin() {
    if (this.duel) throw new RuleError('the battle has already begun');
    this.duel = new Duel({ terrain: this.opponent.terrain, board: this.board, first: this.opponent.meFirst });
    // Listen before announcing readiness: the enemy's first action may arrive at once.
    this.opponent.onAction = (action) => this._incoming(action);
    this.opponent.onFault = (error) => this._emit({ type: 'fault', error });
    await this.opponent.ready(this.board);
    this._markBegun();
  }

  _markBegun() {
    if (this._begun) return;
    this._begun = true;
    this._emit({ type: 'begin' });
  }

  /**
   * Tell the screen. A failure in the screen's own code must not look like a
   * failure of the game: the board has already changed and the opponent is
   * waiting for the report.
   */
  _emit(event) {
    try {
      this.onEvent(event);
    } catch (error) {
      this.onError(error);
    }
  }

  canFire(action) {
    return this._begun && this.duel.canAct(action);
  }

  async fire(action) {
    if (!this._begun) throw new RuleError('the battle has not started');
    const sent = this.duel.beginAction(action);
    this._emit({ type: 'fired', action: sent });
    let result;
    try {
      result = await this.opponent.resolve(sent);
      this.duel.completeAction(result);
    } catch (error) {
      this._emit({ type: 'fault', error });
      throw error;
    }
    this._emit({ type: 'myResult', action: sent, result });
    if (this.duel.over) this._emit({ type: 'over', winner: this.duel.winner });
    return result;
  }

  _incoming(action) {
    const result = this.duel.receiveAction(action);
    // A legal enemy action can only arrive once they have seen our fleet is ready.
    this._markBegun();
    this._emit({ type: 'theirAction', action, result });
    if (this.duel.over) this._emit({ type: 'over', winner: this.duel.winner });
    return result;
  }

  /** After the battle: fetch the enemy fleet and check it against everything they reported. */
  async finish() {
    if (!this.over) throw new RuleError('the battle is not over');
    const { layout, salt, commit } = await this.opponent.reveal();
    const verdict = auditReveal({
      terrain: this.duel.terrain, layout, salt, commit, log: this.duel.tracker.log,
    });
    return { layout, verdict };
  }
}
