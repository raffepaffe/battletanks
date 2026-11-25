import * as THREE from 'three';

/**
 * Low-poly models built from primitives, so the game ships no art files.
 * Every tank faces +X, stands on y = 0 and fits inside one cell (1 x 1).
 */
const TRACK = 0x2a2a25;
const CHARRED = 0x1c1a18;

const material = (color, extra = {}) => new THREE.MeshStandardMaterial({
  color, roughness: 0.85, metalness: 0.08, flatShading: true, ...extra,
});

function mesh(geometry, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const box = (w, h, d, mat, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);

/** A cylinder standing upright. */
const drum = (rTop, rBottom, h, segments, mat, x, y, z) => mesh(
  new THREE.CylinderGeometry(rTop, rBottom, h, segments), mat, x, y, z,
);

/** A cylinder lying along the X axis: gun barrels. */
function barrel(radius, length, mat, x, y, z = 0) {
  const m = mesh(new THREE.CylinderGeometry(radius, radius, length, 8), mat, x, y, z);
  m.rotation.z = Math.PI / 2;
  return m;
}

/** A cylinder lying along the Z axis: wheels. */
function wheel(radius, width, mat, x, y, z) {
  const m = mesh(new THREE.CylinderGeometry(radius, radius, width, 12), mat, x, y, z);
  m.rotation.x = Math.PI / 2;
  return m;
}

function tracks(length, height, width, spread) {
  const mat = material(TRACK, { roughness: 1 });
  const group = new THREE.Group();
  for (const side of [-1, 1]) {
    group.add(box(length - height, height, width, mat, 0, height / 2, side * spread));
    group.add(wheel(height / 2, width, mat, (length - height) / 2, height / 2, side * spread));
    group.add(wheel(height / 2, width, mat, -(length - height) / 2, height / 2, side * spread));
  }
  return group;
}

/** A flat five-pointed star lying on top of something. */
function star(radius, color, x, y, z) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.42;
    const a = (i / 10) * Math.PI * 2;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

/** Three thin coloured bars lying flat: a recognition flash. */
function flash(colors, x, y, z) {
  const group = new THREE.Group();
  colors.forEach((color, i) => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.004, 0.09), new THREE.MeshBasicMaterial({ color }));
    bar.position.set(x + (i - 1) * 0.035, y, z);
    group.add(bar);
  });
  return group;
}

const builders = {
  /** T-34: low, sloped front, turret set well forward, long gun. */
  t34() {
    const green = material(0x4d6238);
    const g = new THREE.Group();
    g.add(tracks(0.8, 0.14, 0.13, 0.2));
    g.add(box(0.7, 0.11, 0.32, green, 0, 0.195, 0));
    const glacis = box(0.22, 0.09, 0.32, green, 0.29, 0.2, 0);
    glacis.rotation.z = -0.55;
    g.add(glacis);
    g.add(drum(0.105, 0.135, 0.1, 6, green, 0.09, 0.3, 0));
    g.add(barrel(0.018, 0.4, green, 0.4, 0.3));
    g.add(star(0.05, 0xc0281c, 0.09, 0.352, 0));
    return g;
  },

  /** M4 Sherman: tall hull, rounded turret, short gun, white star. */
  sherman() {
    const olive = material(0x6b6b3a);
    const g = new THREE.Group();
    g.add(tracks(0.72, 0.16, 0.12, 0.19));
    g.add(box(0.66, 0.13, 0.3, olive, 0, 0.215, 0));
    g.add(box(0.42, 0.08, 0.3, olive, -0.03, 0.31, 0));
    const nose = box(0.14, 0.1, 0.3, olive, 0.29, 0.27, 0);
    nose.rotation.z = -0.7;
    g.add(nose);
    g.add(drum(0.11, 0.125, 0.11, 12, olive, 0, 0.405, 0));
    g.add(barrel(0.016, 0.26, olive, 0.25, 0.41));
    g.add(star(0.055, 0xf2f2e8, 0, 0.462, 0));
    return g;
  },

  /** Churchill: very long, tracks as tall as the hull, small square turret. */
  churchill() {
    const bronze = material(0x3d4b33);
    const g = new THREE.Group();
    g.add(tracks(0.86, 0.22, 0.12, 0.21));
    g.add(box(0.8, 0.15, 0.3, bronze, 0, 0.135, 0));
    g.add(box(0.26, 0.1, 0.22, bronze, 0.03, 0.27, 0));
    g.add(box(0.05, 0.08, 0.14, bronze, 0.17, 0.27, 0));
    g.add(barrel(0.016, 0.28, bronze, 0.33, 0.27));
    g.add(flash([0xb3261e, 0xf2f2e8, 0xb3261e], 0.03, 0.323, 0));
    return g;
  },

  /** Tiger I: wide, boxy, big round turret and a long gun with a muzzle brake. */
  tiger() {
    const yellow = material(0xa8935a);
    const brown = material(0x6f5a3a);
    const g = new THREE.Group();
    g.add(tracks(0.82, 0.16, 0.16, 0.23));
    g.add(box(0.78, 0.15, 0.34, yellow, 0, 0.205, 0));
    g.add(box(0.5, 0.06, 0.42, yellow, -0.04, 0.31, 0));
    g.add(box(0.2, 0.062, 0.14, brown, -0.2, 0.311, 0.12));
    const turret = drum(0.15, 0.16, 0.12, 10, yellow, -0.03, 0.4, 0);
    turret.scale.z = 0.88;
    g.add(turret);
    g.add(box(0.06, 0.1, 0.2, brown, 0.13, 0.4, 0));
    g.add(barrel(0.022, 0.44, yellow, 0.37, 0.4));
    g.add(barrel(0.034, 0.06, brown, 0.6, 0.4));
    return g;
  },

  /** Renault FT: tiny, tall, a big front wheel, a tail skid and the first rotating turret. */
  ft() {
    const khaki = material(0x7c764a);
    const patch = material(0x5a4630);
    const dark = material(TRACK, { roughness: 1 });
    const g = new THREE.Group();
    for (const side of [-1, 1]) {
      g.add(box(0.36, 0.16, 0.09, dark, -0.05, 0.08, side * 0.14));
      g.add(wheel(0.12, 0.09, dark, 0.2, 0.12, side * 0.14));
      g.add(wheel(0.08, 0.09, dark, -0.23, 0.08, side * 0.14));
    }
    g.add(box(0.4, 0.17, 0.19, khaki, -0.02, 0.215, 0));
    g.add(box(0.16, 0.172, 0.192, patch, -0.12, 0.215, 0));
    g.add(drum(0.075, 0.085, 0.1, 8, khaki, 0.02, 0.35, 0));
    g.add(drum(0.035, 0.04, 0.035, 8, patch, 0.02, 0.415, 0));
    g.add(barrel(0.012, 0.14, dark, 0.15, 0.35));
    const skid = box(0.2, 0.02, 0.1, dark, -0.33, 0.17, 0);
    skid.rotation.z = -0.5;
    g.add(skid);
    g.add(flash([0x2a4d9c, 0xf2f2e8, 0xb3261e], -0.02, 0.303, 0));
    return g;
  },
};

const prototypes = new Map();
const charredMaterial = material(CHARRED, { roughness: 1 });

/** A fresh copy of a tank model. Copies share geometry and materials. */
export function buildTank(key) {
  if (!builders[key]) throw new Error(`no model for tank "${key}"`);
  if (!prototypes.has(key)) prototypes.set(key, builders[key]());
  const tank = prototypes.get(key).clone();
  tank.userData.key = key;
  return tank;
}

/** Turn a tank into a burnt-out wreck: black, sagging, turret knocked askew. */
export function charTank(tank) {
  tank.traverse((node) => {
    if (node.isMesh) node.material = charredMaterial;
  });
  tank.rotation.z = 0.06;
  tank.rotation.x = -0.05;
  return tank;
}

/** A small pile of boulders for a rock cell. `rng` keeps both boards identical. */
export function buildRocks(rng) {
  const g = new THREE.Group();
  const grey = material(0x7b7b78);
  const count = 2 + rng.int(2);
  for (let i = 0; i < count; i++) {
    const r = 0.16 + rng.next() * 0.16;
    const rock = mesh(new THREE.IcosahedronGeometry(r, 0), grey,
      (rng.next() - 0.5) * 0.45, r * 0.7, (rng.next() - 0.5) * 0.45);
    rock.rotation.set(rng.next() * 3, rng.next() * 3, rng.next() * 3);
    rock.scale.y = 0.8;
    g.add(rock);
  }
  return g;
}

export function buildTree(rng) {
  const g = new THREE.Group();
  const h = 0.9 + rng.next() * 0.9;
  g.add(drum(0.06, 0.09, 0.4, 6, material(0x5a4630), 0, 0.2, 0));
  const leaves = material(rng.next() < 0.5 ? 0x3f6b35 : 0x4f7a3a);
  g.add(mesh(new THREE.ConeGeometry(0.42, h, 7), leaves, 0, 0.4 + h / 2, 0));
  g.add(mesh(new THREE.ConeGeometry(0.3, h * 0.7, 7), leaves, 0, 0.6 + h * 0.75, 0));
  return g;
}

/** A crater left by a shell that hit nothing. */
export function buildCrater() {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.06, 5, 10), material(0x4a3d2a, { roughness: 1 }));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.02;
  rim.receiveShadow = true;
  const pit = new THREE.Mesh(new THREE.CircleGeometry(0.2, 10), new THREE.MeshBasicMaterial({ color: 0x1b1611 }));
  pit.rotation.x = -Math.PI / 2;
  pit.position.y = 0.012;
  g.add(rim, pit);
  return g;
}

/** The scout drone: an early-style spotter with a body and four rotors. */
export function buildDrone() {
  const g = new THREE.Group();
  const body = material(0x2f3640);
  g.add(box(0.3, 0.08, 0.3, body, 0, 0, 0));
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    g.add(box(0.3, 0.02, 0.04, body, x * 0.2, 0.02, z * 0.2));
    const rotor = drum(0.14, 0.14, 0.01, 12, material(0xd8dde2, { transparent: true, opacity: 0.55 }), x * 0.3, 0.06, z * 0.3);
    rotor.castShadow = false;
    g.add(rotor);
  }
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: 0x6fd3ff }));
  eye.position.y = -0.06;
  g.add(eye);
  return g;
}

/** The ground-attack aircraft for the air strike. Faces +X. */
export function buildPlane() {
  const g = new THREE.Group();
  const skin = material(0x56624a);
  const fuselage = mesh(new THREE.CylinderGeometry(0.1, 0.05, 1.3, 8), skin);
  fuselage.rotation.z = -Math.PI / 2;
  g.add(fuselage);
  g.add(box(0.36, 0.03, 1.7, skin, 0.15, 0, 0));
  g.add(box(0.2, 0.03, 0.6, skin, -0.58, 0.02, 0));
  g.add(box(0.2, 0.24, 0.03, skin, -0.58, 0.12, 0));
  const prop = drum(0.2, 0.2, 0.01, 12, material(0xd8dde2, { transparent: true, opacity: 0.4 }), 0.66, 0, 0);
  prop.rotation.z = Math.PI / 2;
  prop.castShadow = false;
  g.add(prop);
  return g;
}

/** Text drawn on a canvas, as a texture. */
export function textTexture(text, { width = 256, height = 128, font = 'bold 96px system-ui, sans-serif', color = '#fff', stroke = null } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (stroke) {
    ctx.lineWidth = 10;
    ctx.strokeStyle = stroke;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, width / 2, height / 2);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
