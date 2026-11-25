import { CELLS, lineCells } from '../core/grid.js';
import { FLEET, isUnitId } from '../core/fleet.js';
import { SHELL, STRIKE, SCOUT, STRIKE_LENGTH } from '../core/board.js';

/**
 * Payload layouts for every message that crosses the link. Decoders return null
 * for anything malformed; they check ranges only. Whether a well-formed message
 * makes sense in the current game is for the rules (Board, Tracker) to decide.
 */
export const HELLO = 1;    // caller -> anyone: nonce(2) proto(1)
export const WELCOME = 2;  // answerer -> caller: nonce(2) proto(1)
export const READY = 3;    // fleet placed: fingerprint(4)
export const ACK = 4;      // acknowledges READY or REVEAL: type(1)
export const ACTION = 5;   // turn(1) kind+orient(1) cell(1)
export const RESULT = 6;   // turn(1) flags(1) outcomes-or-count(1) [unit(1) placement(1)]*
export const REVEAL = 7;   // layout(5) salt(4)
export const PING = 8;     // radio check: counter(1) sender(1)

const u16 = (hi, lo) => (hi << 8) | lo;

function encodePairing({ nonce, proto }) {
  return Uint8Array.of(nonce >> 8, nonce & 0xff, proto & 0xff);
}
function decodePairing(p) {
  if (p.length !== 3) return null;
  const nonce = u16(p[0], p[1]);
  return nonce === 0 ? null : { nonce, proto: p[2] };
}
export const encodeHello = encodePairing;
export const decodeHello = decodePairing;
export const encodeWelcome = encodePairing;
export const decodeWelcome = decodePairing;

export function encodeReady(commit) {
  return Uint8Array.of(commit >>> 24, (commit >>> 16) & 0xff, (commit >>> 8) & 0xff, commit & 0xff);
}
export function decodeReady(p) {
  if (p.length !== 4) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export const encodeAck = (type) => Uint8Array.of(type);
export const decodeAck = (p) => (p.length === 1 ? p[0] : null);

export function encodeAction(turn, action) {
  if (!Number.isInteger(turn) || turn < 0 || turn > 255) throw new RangeError('turn must be 0-255');
  const orient = action.kind === STRIKE ? action.orient : 0;
  return Uint8Array.of(turn, (action.kind << 1) | orient, action.cell);
}
export function decodeAction(p) {
  if (p.length !== 3) return null;
  const kind = p[1] >> 1, orient = p[1] & 1, cell = p[2];
  if (kind > SCOUT || cell >= CELLS) return null;
  if (kind !== STRIKE && orient !== 0) return null;
  const action = kind === STRIKE ? { kind, cell, orient } : { kind, cell };
  return { turn: p[0], action };
}

export function encodeResult(turn, result) {
  if (!Number.isInteger(turn) || turn < 0 || turn > 255) throw new RangeError('turn must be 0-255');
  if (result.sunk.length > 3 || result.cells.length > STRIKE_LENGTH) throw new RangeError('result is too large');
  const flags = (result.kind << 6) | (result.over ? 0x20 : 0) | (result.sunk.length << 3);
  let third = result.count;
  if (result.kind !== SCOUT) {
    third = 0;
    result.cells.forEach((c, i) => { third |= c.outcome << (4 - 2 * i); });
  }
  const out = [turn, flags, third];
  for (const s of result.sunk) out.push(s.id, (s.origin << 1) | s.orient);
  return Uint8Array.from(out);
}

/** The turn a RESULT payload answers, without needing the action. */
export const resultTurn = (p) => (p.length >= 3 ? p[0] : null);

/**
 * Decode a RESULT. The cells are not transmitted: the attacker rebuilds them
 * from the action it sent, so the action is needed here.
 */
export function decodeResult(p, action) {
  if (p.length < 3) return null;
  const kind = p[1] >> 6, over = Boolean(p[1] & 0x20), sunkCount = (p[1] >> 3) & 3;
  if (kind !== action.kind || (p[1] & 7) !== 0 || p.length !== 3 + 2 * sunkCount) return null;

  let cells = [], count = 0;
  if (kind === SCOUT) {
    count = p[2];
    if (count > 9) return null;
  } else {
    const targets = kind === SHELL ? [action.cell] : lineCells(action.cell, action.orient, STRIKE_LENGTH);
    if (!targets || p[2] > 0x3f) return null;
    const outcomes = [(p[2] >> 4) & 3, (p[2] >> 2) & 3, p[2] & 3];
    if (outcomes.some((o) => o === 3) || outcomes.slice(targets.length).some((o) => o !== 0)) return null;
    cells = targets.map((cell, i) => ({ cell, outcome: outcomes[i] }));
  }

  const sunk = [];
  for (let i = 0; i < sunkCount; i++) {
    const id = p[3 + 2 * i], placement = p[4 + 2 * i];
    if (!isUnitId(id) || (placement >> 1) >= CELLS) return null;
    sunk.push({ id, origin: placement >> 1, orient: placement & 1 });
  }
  return { kind, cells, sunk, count, over };
}

export function encodeReveal({ layout, salt }) {
  if (layout.length !== FLEET.length) throw new RangeError('layout must have one byte per unit');
  return Uint8Array.of(...layout, salt >>> 24, (salt >>> 16) & 0xff, (salt >>> 8) & 0xff, salt & 0xff);
}
export function decodeReveal(p) {
  const n = FLEET.length;
  if (p.length !== n + 4) return null;
  const salt = ((p[n] << 24) | (p[n + 1] << 16) | (p[n + 2] << 8) | p[n + 3]) >>> 0;
  return { layout: p.slice(0, n), salt };
}

export const encodePing = ({ counter, sender }) => Uint8Array.of(counter & 0xff, sender & 0xff);
export const decodePing = (p) => (p.length === 2 ? { counter: p[0], sender: p[1] } : null);
