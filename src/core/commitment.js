import { Board } from './board.js';

/**
 * Fair play between two devices.
 *
 * Before the first shot each device sends a 32-bit fingerprint of its layout
 * mixed with a secret salt. After the battle it reveals layout and salt, and the
 * other device checks the fingerprint and replays every report it was given.
 *
 * This catches bugs and casual cheating. It is not cryptographically strong: a
 * 32-bit fingerprint can be forged by someone prepared to write code for it.
 */
export function commitLayout(layout, salt) {
  let h = 0x811c9dc5;
  const mix = (byte) => { h = Math.imul(h ^ byte, 0x01000193) >>> 0; };
  for (const b of layout) mix(b);
  for (let shift = 0; shift < 32; shift += 8) mix((salt >>> shift) & 0xff);
  // Final avalanche so every input bit affects every output bit.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Check a revealed enemy layout against the fingerprint they sent before the
 * battle and against every report they made (`log` is Tracker.log).
 */
export function auditReveal({ terrain, layout, salt, commit, log }) {
  const fail = (reason) => ({ ok: false, reason });
  if (commitLayout(layout, salt) !== commit) {
    return fail('The revealed battlefield does not match the fingerprint sent before the battle.');
  }
  let board;
  try {
    board = Board.fromLayout(terrain, layout);
  } catch {
    return fail('The revealed battlefield is not a legal placement.');
  }
  for (let i = 0; i < log.length; i++) {
    let expected;
    try {
      expected = board.resolve(log[i].action);
    } catch {
      expected = null;
    }
    if (!expected || !sameResult(expected, log[i].result)) {
      return fail(`The report for move ${i + 1} does not match the revealed battlefield.`);
    }
  }
  return { ok: true, reason: null };
}

function sameResult(a, b) {
  if (a.kind !== b.kind || a.count !== b.count || a.over !== b.over) return false;
  if (a.cells.length !== b.cells.length || a.sunk.length !== b.sunk.length) return false;
  if (!a.cells.every((c, i) => c.cell === b.cells[i].cell && c.outcome === b.cells[i].outcome)) return false;
  const byId = (x, y) => x.id - y.id;
  const sa = [...a.sunk].sort(byId), sb = [...b.sunk].sort(byId);
  return sa.every((s, i) => s.id === sb[i].id && s.origin === sb[i].origin && s.orient === sb[i].orient);
}
