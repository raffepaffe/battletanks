import { BattleScene } from './scene.js';
import { Sfx, audioContext } from './sfx.js';
import { Board, SHELL, STRIKE, SCOUT, HIT, STRIKE_LENGTH } from '../core/board.js';
import { FLEET } from '../core/fleet.js';
import { SIZE, CELLS, H, V, colOf, rowOf, cellAt, lineCells, areaCells, cellName } from '../core/grid.js';
import { createRng, randomSeed } from '../core/rng.js';
import { T_HIT, T_SUNK } from '../core/tracker.js';
import { ProtocolError } from '../core/errors.js';
import { GameController } from '../game/controller.js';
import { ComputerOpponent } from '../game/opponent-computer.js';
import { LinkOpponent } from '../game/opponent-link.js';
import { Session, PROTO } from '../link/session.js';
import { AudioTransport, TabTransport } from '../link/audio-transport.js';
import { VERSION } from '../version.js';

/**
 * Screens, buttons and the order of things. All rules live in src/core and
 * src/game; this file only turns taps into actions and game events into
 * pictures and words.
 */
const $ = (id) => document.getElementById(id);
const SHORT_NAMES = ['T-34', 'Sherman', 'Churchill', 'Tiger', 'FT'];
const unitName = (id) => `${FLEET[id].name} ${FLEET[id].unit}`;
const LEVEL_NAMES = { easy: 'Recruit', medium: 'Veteran', hard: 'General' };
const EC_KEY = 'battletanks.echoCancellation';

const timeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
]);

class App {
  constructor() {
    this.sfx = new Sfx();
    this.scene = new BattleScene($('stage'), { sfx: this.sfx });
    this.scene.onCell = (side, cell, kind) => this.onCell(side, cell, kind);
    this.scene.onLayout = () => this.refresh();
    this.rng = createRng(randomSeed());
    const params = new URLSearchParams(location.search);
    this.useTabs = params.get('link') === 'tabs';
    // ?speed=8 runs animations and the computer's thinking faster, for automated checks.
    this.speed = Math.max(1, Math.min(20, Number(params.get('speed')) || 1));
    this.scene.timeScale = this.speed;

    this.phase = 'menu';
    this.mode = null;
    this.level = 'medium';
    this.opponent = null;
    this.board = null;
    this.game = null;
    this.session = null;
    this.transport = null;
    this.work = { busy: 0, chain: Promise.resolve() };
    this.placing = { unit: 0, orient: H };
    this.weapon = SHELL;
    this.strikeOrient = H;
    this.target = null;
    this.pendingFire = false;
    this.peerReady = false;

    this.bind();
    $('version').textContent = `Version ${VERSION} · link protocol ${PROTO}`;
    this.showModal('menu');
    this.refresh();
  }

  // --- wiring ---------------------------------------------------------------------

  bind() {
    document.addEventListener('pointerdown', () => this.sfx.unlock(), { once: true });
    const click = (id, handler) => $(id).addEventListener('click', () => { this.sfx.click(); handler(); });

    for (const button of document.querySelectorAll('[data-level]')) {
      button.addEventListener('click', () => this.startComputer(button.dataset.level));
    }
    click('btn-link', () => this.openLobby());
    click('btn-help', () => this.showModal('help'));
    for (const button of document.querySelectorAll('[data-close]')) {
      button.addEventListener('click', () => this.showModal(this.phase === 'menu' ? 'menu' : null));
    }
    click('btn-menu', () => {
      if (this.phase === 'menu') this.showModal('menu');
      else if (this.phase === 'over' && this.overReady) this.showModal('over');
      else this.showModal('leave');
    });
    click('btn-leave', () => this.toMenu());
    click('btn-error-menu', () => this.toMenu());
    click('btn-over-menu', () => this.toMenu());
    click('btn-again', () => this.playAgain());
    click('btn-look', () => this.showModal(null));
    $('btn-mute').addEventListener('click', () => {
      this.sfx.setMuted(!this.sfx.muted);
      this.sfx.click();
      this.refresh();
    });

    click('btn-rotate', () => { this.placing.orient = this.placing.orient === H ? V : H; this.refresh(); });
    click('btn-random', () => {
      this.board.clear();
      this.board.placeRandom(this.rng);
      this.placing.unit = null;
      this.boardChanged();
    });
    click('btn-clear', () => { this.board.clear(); this.placing.unit = 0; this.boardChanged(); });
    click('btn-ready', () => this.startBattle());

    for (const button of document.querySelectorAll('[data-weapon]')) {
      button.addEventListener('click', () => {
        this.sfx.click();
        this.weapon = Number(button.dataset.weapon);
        this.say(this.weaponHint(), true);
        this.setTarget(null);
      });
    }
    click('btn-strike-rotate', () => {
      this.strikeOrient = this.strikeOrient === H ? V : H;
      this.setTarget(this.target ? this.actionAt(this.targetCell) : null);
    });
    click('btn-view', () => { this.scene.setView(this.scene.view === 'enemy' ? 'mine' : 'enemy'); this.refresh(); });
    $('btn-fire').addEventListener('click', () => {
      if (this.phase !== 'over') this.fire();
      else if (this.overReady) this.showModal('over');
    });

    click('btn-mic', () => this.enableLink());
    click('btn-call', () => this.call());
    click('btn-lobby-cancel', () => this.toMenu());

    document.addEventListener('keydown', (event) => {
      if (this.modal || event.repeat) return;
      const key = event.key.toLowerCase();
      if (this.phase === 'placement' && key === 'r') $('btn-rotate').click();
      if (this.phase === 'battle') {
        if (key === 'r' && this.weapon === STRIKE) $('btn-strike-rotate').click();
        if (key === 'enter' || key === ' ') { event.preventDefault(); this.fire(); }
        if (['1', '2', '3'].includes(key)) document.querySelector(`[data-weapon="${Number(key) - 1}"]`).click();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.session) {
        audioContext();
        this.keepAwake();
      }
    });
  }

  showModal(name) {
    this.modal = name;
    $('overlay').hidden = !name;
    for (const modal of document.querySelectorAll('.modal')) modal.hidden = modal.id !== `modal-${name}`;
  }

  /** Run UI steps (mostly animations) one after another. Steps of an abandoned game are dropped. */
  enqueue(step) {
    const work = this.work;
    work.busy++;
    work.chain = work.chain
      .then(() => (work === this.work ? step() : undefined))
      .catch((error) => console.error(error))
      .finally(() => {
        work.busy--;
        if (work === this.work) this.refresh();
      });
  }

  // --- starting and leaving games ---------------------------------------------------

  resetGame() {
    this.opponent?.close();
    this.work = { busy: 0, chain: Promise.resolve() };
    this.opponent = null;
    this.game = null;
    this.board = null;
    this.target = null;
    this.targetCell = null;
    this.weapon = SHELL;
    this.strikeOrient = H;
    this.pendingFire = false;
    this.peerReady = false;
    this.overReady = false;
    this.say('');
  }

  toMenu() {
    this.resetGame();
    this.closeLink();
    this.phase = 'menu';
    this.mode = null;
    this.scene.setTerrain(new Uint8Array(CELLS));
    this.showModal('menu');
    this.refresh();
  }

  startComputer(level) {
    this.sfx.click();
    this.resetGame();
    this.closeLink();
    this.mode = 'computer';
    this.level = level;
    this.sfx.setLinkSafe(false);
    this.opponent = new ComputerOpponent({
      seed: randomSeed(), level, rng: createRng(randomSeed()), thinkMs: [900 / this.speed, 1700 / this.speed],
    });
    this.beginPlacement();
  }

  playAgain() {
    if (this.mode === 'computer') this.startComputer(this.level);
    else this.openLobby();
  }

  beginPlacement() {
    this.phase = 'placement';
    this.board = new Board(this.opponent.terrain);
    this.placing = { unit: 0, orient: H };
    this.scene.setTerrain(this.opponent.terrain);
    this.scene.setView('mine');
    this.showModal(null);
    this.boardChanged();
  }

  boardChanged() {
    this.scene.showOwnFleet(this.board);
    this.scene.setHighlight('hover', null, []);
    this.refresh();
  }

  startBattle() {
    if (!this.board.isComplete() || this.phase !== 'placement') return;
    this.phase = 'waiting';
    this.scene.setHighlight('hover', null, []);
    const game = new GameController({
      opponent: this.opponent,
      board: this.board,
      onEvent: (event) => { if (game === this.game) this.onGameEvent(event); },
    });
    this.game = game;
    game.begin().catch((error) => { if (game === this.game) this.fail(error); });
    this.refresh();
  }

  // --- placement ------------------------------------------------------------------------

  onCell(side, cell, kind) {
    if (this.modal) return;
    if (this.phase === 'placement') this.onPlacementCell(side, cell, kind);
    else if (this.phase === 'battle') this.onBattleCell(side, cell, kind);
  }

  onPlacementCell(side, cell, kind) {
    const { unit, orient } = this.placing;
    if (side !== 'mine') {
      if (kind === 'hover') this.scene.setHighlight('hover', null, []);
      return;
    }
    const occupant = this.board.unitAt(cell);
    if (kind === 'tap' && occupant >= 0) {
      // Pick a placed unit up again.
      this.placing = { unit: occupant, orient: this.board.placements[occupant].orient };
      this.board.remove(occupant);
      this.sfx.click();
      this.boardChanged();
      return;
    }
    if (unit === null) {
      if (kind === 'hover') this.scene.setHighlight('hover', null, []);
      return;
    }
    const cells = lineCells(cell, orient, FLEET[unit].length);
    const valid = this.board.canPlace(unit, cell, orient);
    if (kind === 'hover') {
      this.scene.setHighlight('hover', 'mine', cells || [cell], valid ? 'valid' : 'invalid');
      return;
    }
    if (!valid) {
      this.sfx.error();
      this.scene.setHighlight('hover', 'mine', cells || [cell], 'invalid');
      setTimeout(() => { if (this.phase === 'placement') this.scene.setHighlight('hover', null, []); }, 500);
      return;
    }
    this.board.place(unit, cell, orient);
    this.sfx.place();
    const next = FLEET.find((u) => !this.board.placements[u.id]);
    this.placing.unit = next ? next.id : null;
    this.boardChanged();
  }

  // --- battle input ------------------------------------------------------------------------

  canInput() {
    return this.phase === 'battle' && this.game.turn === 'me' && !this.pendingFire && this.work.busy === 0;
  }

  /** The action a tap on an enemy cell means with the current weapon. */
  actionAt(cell) {
    if (this.weapon === SHELL) return { kind: SHELL, cell };
    if (this.weapon === SCOUT) return { kind: SCOUT, cell };
    // The tapped cell is the middle of the strike; slide it inwards at the edges.
    const clamp = (n) => Math.max(0, Math.min(SIZE - STRIKE_LENGTH, n - 1));
    const origin = this.strikeOrient === H ? cellAt(clamp(colOf(cell)), rowOf(cell)) : cellAt(colOf(cell), clamp(rowOf(cell)));
    return { kind: STRIKE, cell: origin, orient: this.strikeOrient };
  }

  cellsOf(action) {
    if (action.kind === SHELL) return [action.cell];
    if (action.kind === SCOUT) return areaCells(action.cell);
    return lineCells(action.cell, action.orient, STRIKE_LENGTH) || [];
  }

  setTarget(action, cell = this.targetCell) {
    this.target = action;
    this.targetCell = action ? cell : null;
    this.refresh();
  }

  onBattleCell(side, cell, kind) {
    if (side !== 'enemy' || !this.canInput()) {
      if (kind === 'hover') this.scene.setHighlight('hover', null, []);
      return;
    }
    const action = this.actionAt(cell);
    const legal = this.game.canFire(action);
    if (kind === 'hover') {
      this.scene.setHighlight('hover', 'enemy', this.cellsOf(action), legal ? 'hover' : 'invalid');
      return;
    }
    if (!legal) {
      this.sfx.error();
      this.scene.setHighlight('hover', 'enemy', this.cellsOf(action), 'invalid');
      setTimeout(() => this.scene.setHighlight('hover', null, []), 400);
      return;
    }
    if (this.target && this.targetCell === cell) {
      this.fire();           // second tap on the same cell
      return;
    }
    this.sfx.click();
    this.scene.setHighlight('hover', null, []);
    this.setTarget(action, cell);
  }

  async fire() {
    if (!this.canInput() || !this.target || !this.game.canFire(this.target)) return;
    const action = this.target, game = this.game;
    this.target = null;
    this.targetCell = null;
    this.pendingFire = true;
    this.refresh();
    try {
      await game.fire(action);
    } catch {
      // The controller has already reported it as a "fault" event; see onGameEvent.
    } finally {
      if (game === this.game) {
        this.pendingFire = false;
        this.refresh();
      }
    }
  }

  // --- game events -> pictures ------------------------------------------------------------------

  onGameEvent(event) {
    switch (event.type) {
      case 'begin':
        this.enqueue(() => {
          this.phase = 'battle';
          this.scene.setView(this.game.turn === 'me' ? 'enemy' : 'mine');
          this.say(this.game.turn === 'me' ? 'You fire first.' : 'The enemy fires first.');
        });
        break;
      case 'myResult':
        this.enqueue(() => this.animate('enemy', event.action, event.result));
        break;
      case 'theirAction':
        this.enqueue(async () => {
          const game = this.game;
          if (!this.scene.dual && this.scene.view !== 'mine') {
            this.scene.setView('mine');
            await this.scene.wait(0.55);
          }
          await this.animate('mine', event.action, event.result);
          if (game !== this.game || game.over) return;
          await this.scene.wait(0.5);
          if (game === this.game) this.scene.setView('enemy');
        });
        break;
      case 'over':
        this.enqueue(() => this.endGame(event.winner));
        break;
      case 'fault':
        this.fail(event.error);
        break;
      default:
        break;
    }
  }

  async animate(side, action, result) {
    // Leaving the game cancels the scene's animations; each step below then stops too.
    const game = this.game;
    const left = () => game !== this.game;
    if (left()) return;
    const who = side === 'enemy' ? 'You' : 'Enemy';
    if (action.kind === SCOUT) {
      this.say(`${who === 'You' ? 'Your' : 'Enemy'} scout drone over ${cellName(action.cell)}…`);
      await this.scene.scout(side, action.cell, result.count);
      if (left()) return;
      this.say(side === 'enemy'
        ? `Scout report: ${result.count} intact tank${result.count === 1 ? '' : 's'} around ${cellName(action.cell)}.`
        : `The enemy scouted around ${cellName(action.cell)}.`);
    } else if (action.kind === SHELL) {
      const hit = result.cells[0].outcome === HIT;
      await this.scene.shell(side, action.cell, result.cells[0].outcome);
      if (left()) return;
      this.say(`${who} fired at ${cellName(action.cell)}: ${hit ? 'hit!' : 'miss.'}`);
    } else {
      this.say(`${who === 'You' ? 'Your' : 'Enemy'} air strike incoming…`);
      await this.scene.strike(side, result.cells, action.orient);
      if (left()) return;
      const hits = result.cells.filter((c) => c.outcome === HIT).length;
      this.say(`${who === 'You' ? 'Your' : 'Enemy'} air strike: ${hits} hit${hits === 1 ? '' : 's'}.`);
    }
    for (const unit of result.sunk) {
      if (left()) return;
      this.scene.showWreck(side, unit);
      this.say(side === 'enemy' ? `Enemy ${unitName(unit.id)} destroyed!` : `Your ${unitName(unit.id)} is destroyed.`);
      await this.scene.finale(side, unit);
    }
  }

  async endGame(winner) {
    const game = this.game;
    this.phase = 'over';
    this.scene.setHighlight('select', null, []);
    this.refresh();
    if (winner === 'me') this.sfx.win(); else this.sfx.lose();
    await this.scene.wait(0.9);
    if (game !== this.game) return;

    let reveal = null;
    if (this.mode === 'link') this.say('Comparing battlefields with the other device…');
    try {
      reveal = await timeout(game.finish(), 30000);
    } catch { /* the other device left or went quiet: finish without the comparison */ }
    if (game !== this.game) return;

    const tracker = game.duel.tracker;
    if (reveal) {
      try {
        const theirs = Board.fromLayout(game.duel.terrain, reveal.layout);
        this.scene.revealFleet(theirs.placements, (cell) => tracker.state[cell] === T_HIT || tracker.state[cell] === T_SUNK);
      } catch { /* an illegal layout is reported by the audit below */ }
    }

    $('over-title').textContent = winner === 'me' ? 'Victory' : 'Defeat';
    $('over-text').textContent = winner === 'me'
      ? 'Every enemy unit is destroyed.'
      : 'Your last tank is burning. The surviving enemy tanks are now shown on their field.';
    const shots = tracker.log.length, hits = tracker.hitCount();
    let lost = 0;
    for (let c = 0; c < CELLS; c++) if (this.board.isHit(c) && this.board.unitAt(c) >= 0) lost++;
    const stats = [
      ['Your moves', shots],
      ['Enemy tanks destroyed', `${hits} of 17`],
      ['Your tanks lost', `${lost} of 17`],
      ['Opponent', this.mode === 'computer' ? `Computer (${LEVEL_NAMES[this.level]})` : 'Other device'],
    ];
    $('over-stats').replaceChildren(...stats.flatMap(([label, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      return [dt, dd];
    }));

    const audit = $('over-audit');
    audit.hidden = this.mode !== 'link';
    if (this.mode === 'link') {
      audit.classList.toggle('bad', Boolean(reveal) && !reveal.verdict.ok);
      if (!reveal) audit.textContent = 'The other device did not reveal its battlefield, so its reports could not be checked.';
      else if (reveal.verdict.ok) audit.textContent = 'Fair play check passed: the other device\'s reports match its revealed battlefield.';
      else audit.textContent = `Fair play check failed. ${reveal.verdict.reason}`;
    }
    $('btn-again').textContent = this.mode === 'link' ? 'Connect again' : 'Play again';
    this.say(winner === 'me' ? 'You won the battle.' : 'You lost the battle.');
    this.overReady = true;
    this.showModal('over');
  }

  fail(error) {
    console.error(error);
    if (this.phase === 'menu' || /closed|left/.test(error?.message || '')) return;
    const protocol = error instanceof ProtocolError;
    $('error-title').textContent = protocol ? 'The reports do not add up' : 'Something went wrong';
    $('error-text').textContent = protocol
      ? 'The other device sent a report that cannot be true, so this battle cannot continue.'
      : (error?.message || 'The battle cannot continue.');
    this.showModal('error');
  }

  // --- sound link ------------------------------------------------------------------------------

  openLobby() {
    this.resetGame();
    this.closeLink();
    this.phase = 'lobby';
    this.mode = 'link';
    this.scene.setTerrain(new Uint8Array(CELLS));
    const Transport = this.useTabs ? TabTransport : AudioTransport;
    const reason = Transport.unavailableReason();
    $('btn-mic').hidden = false;
    $('btn-mic').disabled = Boolean(reason);
    $('btn-mic').textContent = this.useTabs ? 'Connect tabs (test mode)' : 'Turn on the microphone';
    $('btn-call').hidden = true;
    $('lobby-meter').hidden = true;
    $('lobby-status').textContent = reason || '';
    this.showModal('lobby');
    this.refresh();
  }

  async enableLink() {
    const button = $('btn-mic');
    // A token for this attempt: cancelling and reopening the lobby while the
    // microphone prompt is open must not leave two transports running.
    const attempt = Symbol('link attempt');
    this.linkAttempt = attempt;
    button.disabled = true;
    $('lobby-status').textContent = this.useTabs ? 'Connecting…' : 'Asking for the microphone…';
    let echoCancellation = false;
    try { echoCancellation = localStorage.getItem(EC_KEY) === '1'; } catch { /* private mode */ }
    const transport = this.useTabs
      ? new TabTransport()
      : new AudioTransport({ context: audioContext(), echoCancellation });
    try {
      await transport.start();
    } catch (error) {
      transport.stop();
      if (this.linkAttempt !== attempt) return;
      button.disabled = false;
      $('lobby-status').textContent = error?.name === 'NotAllowedError'
        ? 'The microphone was not allowed. Allow it in the browser and try again.'
        : `The microphone could not be started (${error?.message || error}).`;
      return;
    }
    if (this.linkAttempt !== attempt || this.phase !== 'lobby') { transport.stop(); return; }

    this.transport = transport;
    transport.onActivity = (activity) => this.onLinkActivity(activity);
    this.session = new Session({ transport, onEvent: (event) => this.onLinkEvent(event) });
    this.session.listen();
    this.sfx.setLinkSafe(true);
    this.keepAwake();
    button.hidden = true;
    $('btn-call').hidden = false;
    $('btn-call').disabled = false;
    $('lobby-meter').hidden = this.useTabs;
    $('lobby-status').textContent = 'Listening. Tap Call on one of the two devices.';
    this.meterTimer = setInterval(() => {
      for (const band of [0, 1]) {
        const level = transport.level(band);
        const width = Math.max(0, Math.min(1, (20 * Math.log10(level + 1e-6) + 70) / 60));
        $(`meter-${band}`).style.width = `${Math.round(width * 100)}%`;
      }
    }, 100);
    this.refresh();
  }

  call() {
    if (!this.session || this.session.state !== 'listening') return;
    this.session.call();
    $('btn-call').disabled = true;
    $('lobby-status').textContent = 'Calling. You should hear chirps; the other device answers by itself.';
  }

  onLinkEvent(event) {
    if (event.type === 'paired') {
      this.linkPaired = true;
      clearInterval(this.meterTimer);
      this.opponent = new LinkOpponent({ session: this.session });
      this.session.whenPeerReady.then(() => { this.peerReady = true; this.refresh(); }, () => {});
      this.say('Connected to the other device.');
      this.beginPlacement();
    } else if (event.type === 'version') {
      $('lobby-status').textContent = 'The two devices run different versions of the game. Reload the page on both and try again.';
    } else if (event.type === 'trouble') {
      $('banner').textContent = 'Cannot hear the other device. Bring the devices closer together and turn the volume up.';
      $('banner').hidden = false;
    } else if (event.type === 'recovered') {
      $('banner').hidden = true;
    } else if (event.type === 'fault') {
      this.fail(new Error(event.message));
    } else if (event.type === 'left') {
      $('banner').hidden = true;
      // After the battle it does not matter; before that, the game cannot go on.
      if (this.phase === 'placement' || this.phase === 'waiting' || this.phase === 'battle') {
        $('error-title').textContent = 'The other player left';
        $('error-text').textContent = 'The other device ended the game.';
        this.showModal('error');
      }
    }
  }

  onLinkActivity(activity) {
    const light = $('link-light');
    light.classList.toggle('tx', activity.type === 'tx');
    light.classList.toggle('rx', activity.type === 'rx');
    if (activity.type === 'rx') {
      clearTimeout(this.lightTimer);
      this.lightTimer = setTimeout(() => light.classList.remove('rx'), 350);
    }
  }

  keepAwake() {
    navigator.wakeLock?.request('screen').then((lock) => {
      if (this.session) this.wakeLock = lock; else lock.release();
    }).catch(() => {});
  }

  closeLink() {
    clearInterval(this.meterTimer);
    this.linkAttempt = null;
    const transport = this.transport;
    this.session?.close();
    // A paired session says goodbye with a few chirps; give them time to be played.
    if (transport && this.linkPaired) setTimeout(() => transport.stop(), 2800);
    else transport?.stop();
    this.linkPaired = false;
    this.session = null;
    this.transport = null;
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    $('banner').hidden = true;
    $('link-light').className = '';
    this.sfx.setLinkSafe(false);
  }

  // --- what the screen says ------------------------------------------------------------------

  /** The small line under the status. A hint is replaced by the next hint; other lines stay. */
  say(text, hint = false) {
    $('last').textContent = text;
    this.lastIsHint = hint;
  }

  weaponHint() {
    if (this.weapon === SCOUT) return 'Tap the centre of the area to scout, then Launch.';
    if (this.weapon === STRIKE) return 'Tap the middle cell of the air strike, then Strike.';
    return 'Tap a cell on the enemy field, then Fire.';
  }

  refresh() {
    const phase = this.phase;
    $('placement-bar').hidden = phase !== 'placement';
    $('battle-bar').hidden = phase !== 'battle' && phase !== 'over';
    $('fleets').hidden = phase !== 'battle' && phase !== 'over';
    $('link-light').hidden = !this.session;
    $('btn-mute').classList.toggle('off', this.sfx.muted);

    const status = $('status');
    status.classList.remove('mine');
    if (phase === 'menu' || phase === 'lobby') {
      status.textContent = 'Battle Tanks';
    } else if (phase === 'placement') {
      this.refreshPlacement();
    } else if (phase === 'waiting') {
      status.textContent = this.mode === 'link' ? 'Waiting for the other player' : 'Starting';
      this.say(this.mode === 'link' ? 'The battle starts when both fleets are placed.' : '');
    } else if (phase === 'battle') {
      this.refreshBattle();
    } else if (phase === 'over') {
      status.textContent = this.game.winner === 'me' ? 'Victory' : 'Defeat';
      this.refreshBattle();
    }
    if (this.game && (phase === 'battle' || phase === 'over')) this.refreshFleets();
  }

  refreshPlacement() {
    const { unit, orient } = this.placing;
    $('status').textContent = 'Place your tanks';
    const direction = orient === H ? 'left to right' : 'top to bottom';
    if (unit !== null) this.say(`Tap your field to place the ${unitName(unit)} (${FLEET[unit].length} tanks, ${direction}).`);
    else if (this.peerReady) this.say('The other player is ready. Tap a unit to move it, or press Ready.');
    else this.say('Tap a unit to move it, or press Ready.');

    const buttons = $('unit-buttons');
    if (buttons.children.length === 0) {
      for (const u of FLEET) {
        const button = document.createElement('button');
        button.type = 'button';
        const name = document.createElement('b'), size = document.createElement('span');
        name.textContent = SHORT_NAMES[u.id];
        size.textContent = `${u.length} tanks`;
        button.append(name, size);
        button.addEventListener('click', () => {
          this.sfx.click();
          const placed = this.board.placements[u.id];
          if (placed) {
            this.placing.orient = placed.orient;
            this.board.remove(u.id);
          }
          this.placing.unit = u.id;
          this.boardChanged();
        });
        buttons.append(button);
      }
    }
    [...buttons.children].forEach((button, id) => {
      button.classList.toggle('selected', unit === id);
      button.classList.toggle('placed', Boolean(this.board.placements[id]));
    });
    $('btn-rotate').disabled = unit === null;
    $('btn-ready').disabled = !this.board.isComplete();
  }

  refreshBattle() {
    const over = this.phase === 'over';
    const tracker = this.game.duel.tracker;
    const status = $('status');
    const canInput = this.canInput();
    if (!canInput) this.scene.setHighlight('hover', null, []);
    if (!over) {
      if (this.pendingFire) status.textContent = this.mode === 'link' ? 'Sending orders' : 'Firing';
      else if (this.work.busy > 0) status.textContent = 'Battle';
      else if (this.game.turn === 'me') { status.textContent = 'Your turn'; status.classList.add('mine'); }
      else status.textContent = this.mode === 'link' ? 'Enemy\'s turn' : 'Enemy is aiming';
    }

    $('weapon-buttons').hidden = over;
    const used = { [SHELL]: false, [STRIKE]: tracker.strikeUsed, [SCOUT]: tracker.scoutUsed };
    if (used[this.weapon]) this.weapon = SHELL;
    for (const button of document.querySelectorAll('[data-weapon]')) {
      const weapon = Number(button.dataset.weapon);
      button.classList.toggle('selected', weapon === this.weapon);
      button.classList.toggle('used', used[weapon]);
      button.disabled = used[weapon] || !canInput;
      const badge = button.querySelector('small');
      if (badge) badge.textContent = used[weapon] ? '0' : '1';
    }
    $('btn-strike-rotate').hidden = over || this.weapon !== STRIKE;
    $('btn-strike-rotate').disabled = !canInput;
    $('btn-strike-rotate').textContent = this.strikeOrient === H ? 'Strike: across' : 'Strike: down';
    $('btn-view').hidden = this.scene.dual;
    $('btn-view').textContent = this.scene.view === 'enemy' ? 'Show my field' : 'Show enemy field';

    const fire = $('btn-fire');
    if (over) {
      fire.textContent = 'Results';
      fire.disabled = !this.overReady;   // the results are still being put together
    } else {
      const ready = canInput && this.target && this.game.canFire(this.target);
      if (!ready) { this.target = null; this.targetCell = null; }
      fire.disabled = !ready;
      fire.textContent = this.weapon === SCOUT ? 'Launch' : this.weapon === STRIKE ? 'Strike' : 'Fire';
      if (ready) {
        this.scene.setHighlight('select', 'enemy', this.cellsOf(this.target), this.target.kind === SCOUT ? 'area' : 'target');
      } else {
        this.scene.setHighlight('select', null, []);
      }
      if (canInput && !this.target && (this.lastIsHint || !$('last').textContent)) this.say(this.weaponHint(), true);
    }
  }

  refreshFleets() {
    const tracker = this.game.duel.tracker;
    const render = (container, describe) => {
      container.replaceChildren(...FLEET.map((u) => {
        const { gone, hits } = describe(u);
        const chip = document.createElement('div');
        chip.className = `chip${gone ? ' gone' : ''}`;
        chip.title = `${unitName(u.id)} (${u.nation}, ${u.year})`;
        const name = document.createElement('b');
        name.textContent = SHORT_NAMES[u.id];
        const pips = document.createElement('span');
        pips.className = 'pips';
        for (let i = 0; i < u.length; i++) {
          const pip = document.createElement('i');
          if (gone || i < hits) pip.className = 'hit';
          pips.append(pip);
        }
        chip.append(name, pips);
        return chip;
      }));
    };
    render($('fleet-enemy').querySelector('.chips'), (u) => ({ gone: tracker.isSunk(u.id), hits: 0 }));
    render($('fleet-mine').querySelector('.chips'), (u) => {
      const hits = this.board.cellsOf(u.id).filter((c) => this.board.isHit(c)).length;
      return { gone: hits === u.length, hits };
    });
  }
}

window.battletanks = new App();
