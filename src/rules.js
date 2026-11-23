// The grid rules of the arena, free of drawing: the board, blasts, danger and path finding.
// Tiles: c (column, x) and r (row, z). Cells: EMPTY, WALL (indestructible), CRATE (breakable).
export const EMPTY = 0;
export const WALL = 1;
export const CRATE = 2;

export const W = 15;
export const H = 13;
export const SPAWNS = [
  [1, 1],
  [W - 2, H - 2],
  [W - 2, 1],
  [1, H - 2],
];
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const idx = (c, r) => r * W + c;
export const inside = (c, r) => c >= 0 && r >= 0 && c < W && r < H;

/** A seeded random source, so a round can be replayed with the same layout. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Border walls, a pillar on every even interior tile, crates on the rest except by the spawns. */
export function makeBoard(density, random) {
  const cells = new Uint8Array(W * H);
  const keep = new Set();
  for (const [c, r] of SPAWNS) {
    for (const [dc, dr] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ]) {
      keep.add(idx(c + dc, r + dr));
    }
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = idx(c, r);
      if (c === 0 || r === 0 || c === W - 1 || r === H - 1 || (c % 2 === 0 && r % 2 === 0)) {
        cells[i] = WALL;
      } else if (!keep.has(i) && random() < density) {
        cells[i] = CRATE;
      }
    }
  }
  return cells;
}

/**
 * The tiles a bomb's blast reaches: its own and up to `range` along each arm, stopping at a wall,
 * and at the first crate or other bomb, which it reaches. Each tile says which arm it is on.
 */
export function blastTiles(cells, bombAt, c, r, range) {
  const tiles = [{ c, r, arm: null, end: false }];
  for (const [dc, dr] of DIRS) {
    for (let k = 1; k <= range; k++) {
      const tc = c + dc * k;
      const tr = r + dr * k;
      const cell = cells[idx(tc, tr)];
      if (cell === WALL) break;
      const stop = cell === CRATE || bombAt(tc, tr);
      tiles.push({ c: tc, r: tr, arm: [dc, dr], end: stop || k === range });
      if (stop) break;
    }
  }
  return tiles;
}

/**
 * For each tile, the seconds until a flame is on it (0 while one burns; Infinity when safe), with
 * chain reactions: a bomb inside another's blast goes off when that one does.
 */
export function dangerMap(cells, bombs, flames) {
  const danger = new Float32Array(W * H).fill(Infinity);
  for (const f of flames) danger[idx(f.c, f.r)] = 0;
  const at = new Map(bombs.map((b) => [idx(b.c, b.r), b]));
  const when = new Map(bombs.map((b) => [b, b.t]));
  // Settle chains: repeat until no bomb's time drops.
  let changed = true;
  for (let pass = 0; changed && pass < 8; pass++) {
    changed = false;
    for (const b of bombs) {
      const t = when.get(b);
      for (const tile of blastTiles(cells, (tc, tr) => at.has(idx(tc, tr)), b.c, b.r, b.range)) {
        const other = at.get(idx(tile.c, tile.r));
        if (other && other !== b && when.get(other) > t) {
          when.set(other, t);
          changed = true;
        }
      }
    }
  }
  for (const b of bombs) {
    const t = when.get(b);
    for (const tile of blastTiles(cells, (tc, tr) => at.has(idx(tc, tr)), b.c, b.r, b.range)) {
      const i = idx(tile.c, tile.r);
      danger[i] = Math.min(danger[i], t);
    }
  }
  return danger;
}

/**
 * Breadth-first search over walkable tiles from (c, r). `ok(i, steps)` may refuse a tile by the
 * steps it takes to reach it. Returns each reached tile's step count and the tile it came from.
 */
export function search(cells, bombSet, c, r, ok = () => true) {
  const dist = new Int16Array(W * H).fill(-1);
  const prev = new Int16Array(W * H).fill(-1);
  const start = idx(c, r);
  const queue = [start];
  dist[start] = 0;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const ic = i % W;
    const ir = (i / W) | 0;
    for (const [dc, dr] of DIRS) {
      const n = idx(ic + dc, ir + dr);
      if (dist[n] !== -1 || cells[n] !== EMPTY || bombSet.has(n)) continue;
      if (!ok(n, dist[i] + 1)) continue;
      dist[n] = dist[i] + 1;
      prev[n] = i;
      queue.push(n);
    }
  }
  return { dist, prev };
}

/** The steps from the search's start to tile `goal`, as tile indices, the start left out. */
export function pathTo(prev, goal) {
  const path = [];
  for (let i = goal; prev[i] !== -1; i = prev[i]) path.unshift(i);
  return path;
}

/** Whether a fresh bomb at (c, r) still leaves its owner a way out in time. */
export function canEscape(cells, bombs, flames, c, r, range, fuse, speed) {
  const extra = [...bombs, { c, r, range, t: fuse }];
  const danger = dangerMap(cells, extra, flames);
  const bombSet = new Set(extra.map((b) => idx(b.c, b.r)));
  bombSet.delete(idx(c, r));
  const perStep = 1 / speed;
  const { dist } = search(cells, bombSet, c, r, (i, steps) => danger[i] > steps * perStep + 0.15);
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] >= 0 && danger[i] === Infinity && dist[i] * perStep < fuse - 0.3) return true;
  }
  return false;
}

export { DIRS };
