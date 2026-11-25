import { Board } from '../core/board.js';
import { Duel } from '../core/duel.js';
import { generateTerrain } from '../core/terrain.js';
import { commitLayout } from '../core/commitment.js';
import { chooseAction } from '../computer/strategy.js';

const realDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The computer opponent. It plays through the same Duel rules as a human on
 * another device would, with its own hidden board.
 */
export class ComputerOpponent {
  constructor({ seed, level, rng, delay = realDelay, meFirst = true, thinkMs = [900, 1700] }) {
    this.terrain = generateTerrain(seed);
    this.meFirst = meFirst;
    this.level = level;
    this.onAction = null;
    this.onFault = null;
    this._rng = rng;
    this._delay = delay;
    this._thinkMs = thinkMs;
    this._closed = false;
    this.duel = null;
  }

  async ready() {
    const board = new Board(this.terrain);
    board.placeRandom(this._rng);
    this._salt = Math.floor(this._rng.next() * 4294967296) >>> 0;
    this._commit = commitLayout(board.layout(), this._salt);
    this.duel = new Duel({ terrain: this.terrain, board, first: !this.meFirst });
    if (!this.meFirst) this._startMove();
  }

  async resolve(action) {
    const result = this.duel.receiveAction(action);
    if (!this.duel.over) this._startMove();
    return result;
  }

  _startMove() {
    this._move().catch((error) => {
      if (this.onFault) this.onFault(error);
      else throw error;
    });
  }

  async _move() {
    const [min, max] = this._thinkMs;
    await this._delay(min + this._rng.next() * (max - min));
    // Always yield a full task so the player's side has finished recording its own result.
    await nextTask();
    if (this._closed || this.duel.over) return;
    const action = this.duel.beginAction(chooseAction(this.duel.tracker, this._rng, this.level));
    const result = await this.onAction(action);
    this.duel.completeAction(result);
  }

  async reveal() {
    return { layout: this.duel.board.layout(), salt: this._salt, commit: this._commit };
  }

  close() {
    this._closed = true;
  }
}
