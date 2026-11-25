import * as THREE from 'three';
import { SIZE, CELLS, H, colOf, rowOf, cellAt, lineCells, areaCells } from '../core/grid.js';
import { FLEET } from '../core/fleet.js';
import { ROCK, LAKE } from '../core/terrain.js';
import { HIT, SKIP } from '../core/board.js';
import { createRng } from '../core/rng.js';
import {
  buildTank, charTank, buildRocks, buildTree, buildCrater, buildDrone, buildPlane, textTexture,
} from './models.js';

/**
 * The 3D view: two battlefields side by side ("mine" on the left, "enemy" on
 * the right), markers, tanks and effects. It knows nothing about rules or
 * turns; the app tells it what to show and it reports which cell was tapped.
 */
const BOARD_X = { mine: -6.6, enemy: 6.6 };
const TOP = 0.06;                       // height of the tile surface
const FOV = 38;
const TILT_WIDE = (54 * Math.PI) / 180;      // camera elevation above the horizon
const TILT_TALL = (68 * Math.PI) / 180;      // steeper on upright phones, to use the height
const SLAB_OFFSET = -0.35;                   // the slab extends left and up for the labels
const DUAL_ASPECT = 1.2;                // wider than this: show both fields at once

const TILE_COLORS = {
  mine: [0x6c8a3c, 0x63803a],
  enemy: [0xb7a268, 0xab965d],
};
const LAKE_COLOR = 0x2e6c99;
const STYLES = {
  valid: { color: 0x59d66a, opacity: 0.55 },
  invalid: { color: 0xe04a3a, opacity: 0.6 },
  target: { color: 0xffc233, opacity: 0.7 },
  hover: { color: 0xffffff, opacity: 0.28 },
  area: { color: 0x58d0ff, opacity: 0.45 },
};

const easeInOut = (t) => t * t * (3 - 2 * t);

export class BattleScene {
  constructor(container, { sfx = null } = {}) {
    this.container = container;
    this.sfx = sfx;
    this.onCell = () => {};
    this.view = 'enemy';
    this.dual = false;
    this._tweens = [];
    this._fires = [];
    this._time = 0;
    /** Speeds up every animation; used by automated checks (?speed=8). */
    this.timeScale = 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc3da);
    this.scene.fog = new THREE.Fog(0x9fc3da, 45, 110);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 300);
    this._target = new THREE.Vector3(0, 0, SLAB_OFFSET);
    this._distance = 30;
    this._snapCamera = true;

    this._buildWorld();
    this.boards = { mine: this._buildBoard('mine'), enemy: this._buildBoard('enemy') };
    this._highlights = { select: this._highlightPool(), hover: this._highlightPool(), area: this._highlightPool() };
    this.setTerrain(new Uint8Array(CELLS));

    this._bindPointer();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(container);
    this._resize();

    this._lastFrame = performance.now();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  // --- construction ------------------------------------------------------------

  _buildWorld() {
    this.scene.add(new THREE.HemisphereLight(0xdcecff, 0x5b5a3c, 1.25));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
    sun.position.set(-9, 16, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -15; s.right = 15; s.top = 9; s.bottom = -9; s.near = 1; s.far = 50;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x566b3a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.3;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const rng = createRng(1917);
    for (let i = 0; i < 46; i++) {
      const x = (rng.next() - 0.5) * 60, z = -7.5 - rng.next() * 22;
      const tree = buildTree(rng);
      tree.position.set(x, -0.3, z);
      tree.scale.setScalar(1 + rng.next() * 0.8);
      this.scene.add(tree);
    }
    for (let i = 0; i < 14; i++) {
      const side = i % 2 ? 1 : -1;
      const tree = buildTree(rng);
      tree.position.set(side * (14.5 + rng.next() * 12), -0.3, -7 + rng.next() * 12);
      tree.scale.setScalar(1 + rng.next() * 0.8);
      this.scene.add(tree);
    }
  }

  _buildBoard(side) {
    const group = new THREE.Group();
    group.position.x = BOARD_X[side];
    this.scene.add(group);

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(11.3, 0.3, 11.3),
      new THREE.MeshStandardMaterial({ color: side === 'mine' ? 0x3d4a2a : 0x6b5c3a, roughness: 1 }),
    );
    slab.position.set(-0.35, -0.15, -0.35);
    slab.receiveShadow = true;
    group.add(slab);

    const tiles = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.94, 0.12, 0.94),
      new THREE.MeshStandardMaterial({ roughness: 0.95 }),
      CELLS,
    );
    tiles.receiveShadow = true;
    group.add(tiles);

    // Column letters along the far edge, row numbers along the left edge.
    const labelMaterial = (texture) => new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
    const letters = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, 0.6), labelMaterial(this._edgeTexture(true)));
    letters.rotation.x = -Math.PI / 2;
    letters.position.set(0, 0.012, -5.45);
    const numbers = new THREE.Mesh(new THREE.PlaneGeometry(0.6, SIZE), labelMaterial(this._edgeTexture(false)));
    numbers.rotation.x = -Math.PI / 2;
    numbers.position.set(-5.45, 0.012, 0);
    group.add(letters, numbers);

    const title = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 0.9),
      labelMaterial(textTexture(side === 'mine' ? 'YOUR FIELD' : 'ENEMY FIELD', {
        width: 768, height: 116, font: 'bold 84px system-ui, sans-serif', color: '#fff8e0', stroke: 'rgba(30,30,20,0.85)',
      })),
    );
    title.position.set(0, 1.0, -6.5);
    title.rotation.x = -0.35;
    group.add(title);

    const props = new THREE.Group(), marks = new THREE.Group(), units = new THREE.Group();
    group.add(props, marks, units);
    return { side, group, tiles, props, marks, units, tanks: new Array(CELLS).fill(null), scorched: new Uint8Array(CELLS) };
  }

  _edgeTexture(lettersAlongX) {
    const canvas = document.createElement('canvas');
    canvas.width = lettersAlongX ? 1000 : 60;
    canvas.height = lettersAlongX ? 60 : 1000;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,248,224,0.92)';
    for (let i = 0; i < SIZE; i++) {
      if (lettersAlongX) ctx.fillText(String.fromCharCode(65 + i), i * 100 + 50, 32);
      else ctx.fillText(String(i + 1), 30, i * 100 + 52);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  _highlightPool() {
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false });
    const geometry = new THREE.BoxGeometry(0.94, 0.03, 0.94);
    const meshes = Array.from({ length: 9 }, () => {
      const m = new THREE.Mesh(geometry, material);
      m.visible = false;
      m.renderOrder = 2;
      this.scene.add(m);
      return m;
    });
    return { material, meshes, baseOpacity: 0.5 };
  }

  // --- board content -----------------------------------------------------------------

  cellPosition(side, cell, y = TOP) {
    return new THREE.Vector3(BOARD_X[side] + colOf(cell) - 4.5, y, rowOf(cell) - 4.5);
  }

  _local(cell, y = TOP) {
    return new THREE.Vector3(colOf(cell) - 4.5, y, rowOf(cell) - 4.5);
  }

  /** Lay out rocks and lakes on both fields and remove everything from the last battle. */
  setTerrain(terrain) {
    this.terrain = terrain;
    for (const board of Object.values(this.boards)) {
      board.props.clear();
      board.marks.clear();
      board.units.clear();
      board.tanks.fill(null);
      board.scorched.fill(0);
      for (let cell = 0; cell < CELLS; cell++) {
        this._paintTile(board, cell);
        if (terrain[cell] === ROCK) {
          const rocks = buildRocks(createRng(cell * 7919 + 13));
          rocks.position.copy(this._local(cell));
          board.props.add(rocks);
        }
      }
      board.tiles.instanceMatrix.needsUpdate = true;
      board.tiles.instanceColor.needsUpdate = true;
    }
    this._fires = [];
    for (const layer of Object.keys(this._highlights)) this.setHighlight(layer, null, []);
  }

  _paintTile(board, cell) {
    const lake = this.terrain[cell] === LAKE;
    const matrix = new THREE.Matrix4().makeTranslation(colOf(cell) - 4.5, lake ? -0.05 : 0, rowOf(cell) - 4.5);
    board.tiles.setMatrixAt(cell, matrix);
    const shade = TILE_COLORS[board.side][(colOf(cell) + rowOf(cell)) % 2];
    const color = new THREE.Color(lake ? LAKE_COLOR : shade);
    if (board.scorched[cell]) color.multiplyScalar(0.42);
    board.tiles.setColorAt(cell, color);
  }

  _scorch(board, cell) {
    board.scorched[cell] = 1;
    this._paintTile(board, cell);
    board.tiles.instanceColor.needsUpdate = true;
  }

  /** Show the player's own tanks according to a Board's placements. */
  showOwnFleet(board) {
    const mine = this.boards.mine;
    mine.units.clear();
    mine.tanks.fill(null);
    board.placements.forEach((placement, id) => {
      if (!placement) return;
      for (const cell of lineCells(placement.origin, placement.orient, FLEET[id].length)) {
        mine.tanks[cell] = this._addTank(mine, id, cell, placement.orient);
      }
    });
  }

  _addTank(board, id, cell, orient) {
    const tank = buildTank(FLEET[id].key);
    tank.position.copy(this._local(cell));
    tank.rotation.y = orient === H ? 0 : -Math.PI / 2;
    board.units.add(tank);
    return tank;
  }

  /** A shell that hit nothing: leave a crater. */
  markMiss(side, cell) {
    const board = this.boards[side];
    const crater = buildCrater();
    crater.position.copy(this._local(cell));
    board.marks.add(crater);
  }

  /** A burning tank. On our own field the tank model itself is charred. */
  markHit(side, cell) {
    const board = this.boards[side];
    this._scorch(board, cell);
    if (board.tanks[cell]) charTank(board.tanks[cell]);
    this._addFire(board, cell);
  }

  /** Reveal a destroyed enemy unit as a row of wrecks. */
  showWreck(side, unit) {
    const board = this.boards[side];
    for (const cell of lineCells(unit.origin, unit.orient, FLEET[unit.id].length)) {
      if (board.tanks[cell]) continue;
      board.tanks[cell] = charTank(this._addTank(board, unit.id, cell, unit.orient));
    }
  }

  /** After the battle: show the rest of the enemy fleet, burnt out where it was hit. */
  revealFleet(placements, isHit) {
    const board = this.boards.enemy;
    placements.forEach((placement, id) => {
      for (const cell of lineCells(placement.origin, placement.orient, FLEET[id].length) || []) {
        if (board.tanks[cell]) continue;
        board.tanks[cell] = this._addTank(board, id, cell, placement.orient);
        if (isHit(cell)) charTank(board.tanks[cell]);
      }
    });
  }

  _addFire(board, cell) {
    const group = new THREE.Group();
    group.position.copy(this._local(cell));
    // A red ring that reads as "hit" from straight above, whatever stands on the cell.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 20),
      new THREE.MeshBasicMaterial({ color: 0xe5382a, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    group.add(ring);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.5, 6),
      new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.92 }),
    );
    flame.position.y = 0.5;
    group.add(flame);
    const puffs = [0, 1, 2].map(() => {
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 7, 5),
        new THREE.MeshBasicMaterial({ color: 0x2b2927, transparent: true, opacity: 0.4, depthWrite: false }),
      );
      group.add(puff);
      return puff;
    });
    board.marks.add(group);
    this._fires.push({ flame, puffs, phase: (cell * 0.37) % 1 });
  }

  // --- highlights ----------------------------------------------------------------------

  /** Light up cells on a field. Layers: select (pulsing), hover, area. Empty list clears. */
  setHighlight(layer, side, cells, style = 'hover') {
    const pool = this._highlights[layer];
    const look = STYLES[style];
    pool.material.color.setHex(look.color);
    pool.material.opacity = look.opacity;
    pool.baseOpacity = look.opacity;
    pool.meshes.forEach((m, i) => {
      m.visible = Boolean(side) && i < cells.length;
      if (m.visible) m.position.copy(this.cellPosition(side, cells[i], TOP + 0.03 + (layer === 'select' ? 0.01 : 0)));
    });
  }

  // --- animated events -------------------------------------------------------------------

  _tween(seconds, step) {
    return new Promise((resolve) => {
      this._tweens.push({ t: 0, seconds, step, resolve });
      step(0);
    });
  }

  wait(seconds) {
    return this._tween(seconds, () => {});
  }

  _burst(position, { color, size, seconds = 0.45 }) {
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false }),
    );
    ball.position.copy(position);
    this.scene.add(ball);
    return this._tween(seconds, (t) => {
      ball.scale.setScalar(0.15 + size * easeInOut(t));
      ball.material.opacity = 1 - t;
      if (t === 1) {
        this.scene.remove(ball);
        ball.geometry.dispose();
        ball.material.dispose();
      }
    });
  }

  _debris(position) {
    const bits = Array.from({ length: 6 }, (_, i) => {
      const bit = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.07), new THREE.MeshBasicMaterial({ color: 0x2a2520 }));
      const angle = (i / 6) * Math.PI * 2 + position.x;
      bit.userData.dir = new THREE.Vector3(Math.cos(angle) * 0.9, 1.6 + (i % 3) * 0.4, Math.sin(angle) * 0.9);
      this.scene.add(bit);
      return bit;
    });
    return this._tween(0.7, (t) => {
      for (const bit of bits) {
        bit.position.copy(position).addScaledVector(bit.userData.dir, t);
        bit.position.y -= 2.6 * t * t;
        bit.rotation.x = bit.rotation.z = t * 6;
        if (t === 1) { this.scene.remove(bit); bit.geometry.dispose(); bit.material.dispose(); }
      }
    });
  }

  /** What a single cell looks like when something lands on it. */
  _land(side, cell, outcome) {
    const at = this.cellPosition(side, cell, TOP + 0.15);
    if (outcome === HIT) {
      this.sfx?.explosion();
      this.markHit(side, cell);
      this._debris(at);
      return this._burst(at, { color: 0xffa531, size: 0.85 });
    }
    this.sfx?.miss();
    this.markMiss(side, cell);
    return this._burst(at, { color: 0x8a775a, size: 0.55, seconds: 0.5 });
  }

  /** A shell flies in from the other field and lands on a cell. */
  async shell(side, cell, outcome) {
    const target = this.cellPosition(side, cell, TOP + 0.1);
    const from = target.clone().add(new THREE.Vector3(side === 'enemy' ? -11 : 11, 0.5, 1.5));
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: 0x1b1b1b }));
    this.scene.add(shell);
    this.sfx?.fire();
    await this._tween(0.6, (t) => {
      shell.position.lerpVectors(from, target, t);
      shell.position.y += Math.sin(Math.PI * t) * 4.2;
    });
    this.scene.remove(shell);
    shell.geometry.dispose();
    shell.material.dispose();
    await this._land(side, cell, outcome);
  }

  /** An aircraft flies along the line and bombs each cell as it passes. */
  async strike(side, cells, orient) {
    const first = this.cellPosition(side, cells[0].cell), last = this.cellPosition(side, cells[cells.length - 1].cell);
    const direction = orient === H ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const centre = first.clone().add(last).multiplyScalar(0.5);
    const from = centre.clone().addScaledVector(direction, -13).setY(2.6);
    const to = centre.clone().addScaledVector(direction, 13).setY(2.6);
    const plane = buildPlane();
    plane.rotation.y = orient === H ? 0 : -Math.PI / 2;
    this.scene.add(plane);
    this.sfx?.plane();
    const dropped = new Set();
    const landings = [];
    await this._tween(1.7, (t) => {
      plane.position.lerpVectors(from, to, t);
      plane.rotation.x = Math.sin(t * 20) * 0.03;
      for (const entry of cells) {
        const along = this.cellPosition(side, entry.cell).sub(from).dot(direction) / 26;
        if (t >= along && !dropped.has(entry.cell)) {
          dropped.add(entry.cell);
          if (entry.outcome !== SKIP) landings.push(this._land(side, entry.cell, entry.outcome));
        }
      }
    });
    this.scene.remove(plane);
    await Promise.all(landings);
  }

  /** The scout drone circles an area, then leaves a number: intact tanks seen there. */
  async scout(side, centre, count) {
    const cells = areaCells(centre);
    const middle = this.cellPosition(side, centre, 1.7);
    const from = middle.clone().add(new THREE.Vector3(side === 'enemy' ? -9 : 9, 3, -5));
    const drone = buildDrone();
    drone.scale.setScalar(1.5);
    this.scene.add(drone);
    this.setHighlight('area', side, cells, 'area');
    this.sfx?.drone();
    const onCircle = (angle) => middle.clone().add(new THREE.Vector3(Math.cos(angle) * 1.25, 0, Math.sin(angle) * 1.25));
    await this._tween(2.2, (t) => {
      if (t < 0.25) drone.position.lerpVectors(from, onCircle(0), easeInOut(t / 0.25));
      else if (t < 0.8) drone.position.copy(onCircle(((t - 0.25) / 0.55) * Math.PI * 2));
      else drone.position.lerpVectors(onCircle(0), from, easeInOut((t - 0.8) / 0.2));
      drone.rotation.y = t * 9;
    });
    this.scene.remove(drone);
    this.setHighlight('area', null, []);
    this._scoutReport(side, cells, count);
  }

  _scoutReport(side, cells, count) {
    const board = this.boards[side];
    const cols = cells.map(colOf), rows = cells.map(rowOf);
    const x0 = Math.min(...cols) - 5, x1 = Math.max(...cols) - 4, z0 = Math.min(...rows) - 5, z1 = Math.max(...rows) - 4;
    const y = TOP + 0.025;
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0), new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y, z1),
      ]),
      new THREE.LineBasicMaterial({ color: 0x58d0ff }),
    );
    board.marks.add(outline);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: textTexture(String(count), { width: 128, height: 128, color: '#e9faff', stroke: '#0b4a66' }),
      depthTest: false, transparent: true,
    }));
    label.renderOrder = 5;
    label.scale.set(0.8, 0.8, 1);
    // In the far-left corner of the area, so it does not cover the cells themselves.
    label.position.set(x0 + 0.05, 0.55, z0 + 0.05);
    board.marks.add(label);
    this.sfx?.blip();
  }

  /** A bigger blast when a whole unit is gone. */
  finale(side, unit) {
    const cells = lineCells(unit.origin, unit.orient, FLEET[unit.id].length);
    const middle = this.cellPosition(side, cells[Math.floor(cells.length / 2)], 0.5);
    this.sfx?.explosion(1.4);
    return this._burst(middle, { color: 0xffd27a, size: 1.6, seconds: 0.6 });
  }

  // --- camera and input ---------------------------------------------------------------------

  /** Which field the camera centres on when only one fits the screen. */
  setView(view) {
    this.view = view;
  }

  _resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const dual = w / h >= DUAL_ASPECT;
    if (dual !== this.dual) {
      this.dual = dual;
      this.onLayout?.(dual);
    }
  }

  _updateCamera(dt) {
    const aspect = this.camera.aspect;
    const tilt = aspect < 0.8 ? TILT_TALL : TILT_WIDE;
    const tanHalf = Math.tan((FOV * Math.PI) / 360);
    // Half the width and depth of what must stay in view, measured from the camera target.
    const halfWidth = this.dual ? BOARD_X.enemy + 5.95 : 5.95;
    const halfDepth = 5.95;
    const towardsCamera = halfDepth * Math.cos(tilt);     // the near edge is this much closer
    const fitWidth = halfWidth / (tanHalf * aspect) + towardsCamera;
    const fitDepth = (halfDepth * Math.sin(tilt)) / tanHalf + towardsCamera;
    const distance = Math.max(fitWidth, fitDepth);
    const targetX = (this.dual ? 0 : BOARD_X[this.view]) + SLAB_OFFSET;

    const k = this._snapCamera ? 1 : 1 - Math.exp(-dt * 5);
    this._snapCamera = false;
    this._target.x += (targetX - this._target.x) * k;
    this._target.z = SLAB_OFFSET;
    this._distance += (distance - this._distance) * k;
    this._tilt = this._tilt === undefined ? tilt : this._tilt + (tilt - this._tilt) * k;
    this.camera.position.set(
      this._target.x,
      this._target.y + Math.sin(this._tilt) * this._distance,
      this._target.z + Math.cos(this._tilt) * this._distance,
    );
    this.camera.lookAt(this._target);
  }

  _bindPointer() {
    const canvas = this.renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TOP);
    const point = new THREE.Vector3();
    const pick = (event) => {
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, this.camera);
      if (!raycaster.ray.intersectPlane(plane, point)) return null;
      for (const side of ['mine', 'enemy']) {
        const col = Math.floor(point.x - BOARD_X[side] + 5), row = Math.floor(point.z + 5);
        if (col >= 0 && col < SIZE && row >= 0 && row < SIZE) return { side, cell: cellAt(col, row) };
      }
      return null;
    };
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const hit = pick(e);
      this.onCell(hit ? hit.side : null, hit ? hit.cell : null, 'hover');
    });
    canvas.addEventListener('pointerleave', () => this.onCell(null, null, 'hover'));
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) return;
      down = null;
      const hit = pick(e);
      if (hit) this.onCell(hit.side, hit.cell, 'tap');
    });
  }

  // --- frame loop ----------------------------------------------------------------------------

  _frame() {
    const now = performance.now();
    const dt = Math.min((now - this._lastFrame) / 1000, 0.1);
    this._lastFrame = now;
    this._time += dt;

    for (const tween of [...this._tweens]) {
      tween.t = Math.min(1, tween.t + (dt * this.timeScale) / tween.seconds);
      tween.step(tween.t);
      if (tween.t === 1) {
        this._tweens.splice(this._tweens.indexOf(tween), 1);
        tween.resolve();
      }
    }

    for (const fire of this._fires) {
      const flicker = 0.85 + 0.25 * Math.sin(this._time * 17 + fire.phase * 40);
      fire.flame.scale.set(flicker, 0.8 + 0.35 * Math.sin(this._time * 11 + fire.phase * 20), flicker);
      fire.puffs.forEach((puff, i) => {
        const life = (this._time * 0.45 + fire.phase + i / 3) % 1;
        puff.position.set(Math.sin(life * 5 + i) * 0.12, 0.7 + life * 1.6, 0);
        puff.scale.setScalar(0.6 + life * 1.5);
        puff.material.opacity = 0.5 * (1 - life);
      });
    }

    const pulse = 0.75 + 0.25 * Math.sin(this._time * 6);
    this._highlights.select.material.opacity = this._highlights.select.baseOpacity * pulse;

    this._updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
