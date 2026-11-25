import { generateTerrain } from '../core/terrain.js';
import { commitLayout } from '../core/commitment.js';
import { randomSeed } from '../core/rng.js';

/**
 * A human opponent on another device, reached through a paired Session.
 * Implements the same interface as ComputerOpponent (see GameController).
 */
export class LinkOpponent {
  constructor({ session, randomSalt = randomSeed }) {
    if (session.state !== 'paired') throw new Error('the devices are not paired');
    this.session = session;
    this.terrain = generateTerrain(session.seed);
    this.meFirst = session.meFirst;
    this._randomSalt = randomSalt;
    this._layout = null;
    this._salt = 0;
    this._peerCommit = null;
  }

  get onAction() { return this.session.onAction; }
  set onAction(handler) { this.session.onAction = handler; }

  /** Send the fingerprint of our fleet and wait for theirs. */
  async ready(board) {
    this._layout = board.layout();
    this._salt = this._randomSalt() >>> 0;
    const commit = commitLayout(this._layout, this._salt);
    const [, peerCommit] = await Promise.all([this.session.sendReady(commit), this.session.whenPeerReady]);
    this._peerCommit = peerCommit;
  }

  resolve(action) {
    return this.session.sendAction(action);
  }

  /** Swap fleets after the battle. The fingerprint is the one they sent before it. */
  async reveal() {
    const [, theirs] = await Promise.all([
      this.session.sendReveal({ layout: this._layout, salt: this._salt }),
      this.session.whenPeerReveal,
    ]);
    return { layout: theirs.layout, salt: theirs.salt, commit: this._peerCommit };
  }

  close() {
    this.session.close();
  }
}
