/** Battlefield geometry: a 10x10 grid, cells numbered row by row from 0 to 99. */
export const SIZE = 10;
export const CELLS = SIZE * SIZE;

/** Orientations: horizontal runs towards higher columns, vertical towards higher rows. */
export const H = 0;
export const V = 1;

export const cellAt = (col, row) => row * SIZE + col;
export const colOf = (cell) => cell % SIZE;
export const rowOf = (cell) => Math.floor(cell / SIZE);
export const isCell = (n) => Number.isInteger(n) && n >= 0 && n < CELLS;
export const isOrient = (o) => o === H || o === V;

/** Cells of a straight line, or null if it does not fit on the grid. */
export function lineCells(origin, orient, length) {
  if (!isCell(origin) || !isOrient(orient) || !Number.isInteger(length) || length < 1) return null;
  const col = colOf(origin), row = rowOf(origin);
  const endCol = orient === H ? col + length - 1 : col;
  const endRow = orient === V ? row + length - 1 : row;
  if (endCol >= SIZE || endRow >= SIZE) return null;
  const step = orient === H ? 1 : SIZE;
  return Array.from({ length }, (_, i) => origin + i * step);
}

/** The 3x3 area around a cell, clipped at the edges, in ascending order. */
export function areaCells(center) {
  if (!isCell(center)) return [];
  const col = colOf(center), row = rowOf(center);
  const out = [];
  for (let r = row - 1; r <= row + 1; r++) {
    for (let c = col - 1; c <= col + 1; c++) {
      if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) out.push(cellAt(c, r));
    }
  }
  return out;
}

/** Orthogonal neighbours of a cell. */
export function neighbours(cell) {
  const col = colOf(cell), row = rowOf(cell);
  const out = [];
  if (col > 0) out.push(cell - 1);
  if (col < SIZE - 1) out.push(cell + 1);
  if (row > 0) out.push(cell - SIZE);
  if (row < SIZE - 1) out.push(cell + SIZE);
  return out;
}

/** Human name of a cell: column letter A-J and row number 1-10. */
export const cellName = (cell) => `${String.fromCharCode(65 + colOf(cell))}${rowOf(cell) + 1}`;
