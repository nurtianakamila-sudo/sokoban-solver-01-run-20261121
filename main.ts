// Sokoban push-optimal solver.
//
// One program answers a whole set of Sokoban levels (level.txt in XSB, one
// per /input/<id>/) by writing /output/<id>/solution.txt, the player's moves
// in u/d/l/r. Scoring is by push count against the push-optimal count P*, so
// the solver chases the fewest pushes, not the fewest moves.
//
// How it works: every level the generator makes is a 1-wide hallway with
// 1-4 rooms off it, each room holding 3-4 boxes and as many goals, and a box
// pushed out of a room through its door can never come back. So each room is
// an independent problem and the level's optimum is the sum of the rooms'
// optima. The solver therefore
//   1. splits the board into rooms (connected floor components off the
//      hallway row), one door each,
//   2. solves each room on its own with a push-optimal A* over push states
//      (a state is the boxes plus the player's square; a step costs one push
//      and the estimate is the cheapest matching of boxes to goals, which
//      never overestimates), with dead-square pruning, and
//   3. stitches the rooms together with plain walks through the hallway.
//
// A whole-level push A* (same search, no split) is kept as a fallback for
// any level whose shape does not split as expected. Everything is budgeted
// by counted search expansions, never by the clock, and every tie is broken
// by a fixed order, so two runs write identical bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Up, down, left, right: [dx, dy, letter].
const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

// Search budgets, counted in expanded states (never wall time, so runs agree).
const ROOM_EXPANSIONS = 250_000;
const WHOLE_EXPANSIONS = 1_000_000;

/** A parsed level: flat w*h grid, index y*w+x. */
type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if ('.*+'.includes(ch)) goals.push(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The four neighbours of cell i, in the fixed order u, d, l, r. */
function neighbours(w: number, h: number, i: number): number[] {
  const x = i % w;
  const y = Math.floor(i / w);
  const out: number[] = [];
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
    out.push(ny * w + nx);
  }
  return out;
}

/** Every floor cell the player can walk to from `from`, boxes and walls aside. */
function reachable(
  w: number,
  h: number,
  wall: Uint8Array,
  blocked: Uint8Array,
  from: number,
): Uint8Array {
  const seen = new Uint8Array(w * h);
  const queue = [from];
  seen[from] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    for (const q of neighbours(w, h, queue[qi]!)) {
      if (!wall[q] && !blocked[q] && !seen[q]) {
        seen[q] = 1;
        queue.push(q);
      }
    }
  }
  return seen;
}

/** The walk from `from` to `to` as move letters, or null when unreachable. */
function walkPath(
  w: number,
  h: number,
  wall: Uint8Array,
  blocked: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const parent = new Int32Array(w * h).fill(-1);
  const parentDir = new Int8Array(w * h).fill(-1);
  const queue = [from];
  parent[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    const ns = neighbours(w, h, cur);
    for (let d = 0; d < ns.length; d++) {
      const q = ns[d]!;
      if (wall[q] || blocked[q] || parent[q] !== -1) continue;
      parent[q] = cur;
      parentDir[q] = d;
      if (q === to) {
        let moves = '';
        for (let t = to; t !== from; t = parent[t]!) {
          moves = DIRS[parentDir[t]!]![2] + moves;
        }
        return moves;
      }
      queue.push(q);
    }
  }
  return null;
}

/**
 * The squares a box can still reach a goal from, by pushes alone: a box on
 * any other square of `boxCells` is dead and no solution passes through it.
 * Built backwards from the goals: a box at x can step to y = x + d when the
 * player could stand at x - d, so y live and x - d open floor make x live.
 */
function liveSquares(
  w: number,
  h: number,
  floor: Uint8Array,
  boxCells: Uint8Array,
  goals: number[],
): Uint8Array {
  const live = new Uint8Array(w * h);
  const queue: number[] = [];
  for (const g of goals) {
    if (boxCells[g] && !live[g]) {
      live[g] = 1;
      queue.push(g);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const y = queue[qi]!;
    const yx = y % w;
    const yy = Math.floor(y / w);
    for (const [dx, dy] of DIRS) {
      const xx = yx - dx;
      const xy = yy - dy;
      if (xx < 0 || xx >= w || xy < 0 || xy >= h) continue;
      const x = xy * w + xx;
      if (!boxCells[x] || live[x]) continue;
      const bx = xx - dx;
      const by = xy - dy;
      if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
      if (!floor[by * w + bx]) continue;
      live[x] = 1;
      queue.push(x);
    }
  }
  return live;
}

/** Walking distance (walls only) from each goal to every box square. */
function goalDistances(
  w: number,
  h: number,
  wall: Uint8Array,
  boxCells: Uint8Array,
  goals: number[],
): Int32Array[] {
  return goals.map((g) => {
    const dist = new Int32Array(w * h).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      for (const q of neighbours(w, h, queue[qi]!)) {
        if (boxCells[q] && dist[q] < 0) {
          dist[q] = dist[queue[qi]!]! + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
}

/**
 * A lower bound on the pushes still needed: the cheapest way to match every
 * box to a distinct goal (exact for up to 5 boxes by trying every pairing,
 * otherwise each box to its nearest goal). One push moves one box one square,
 * so the match can only shrink by one a push: the bound never overestimates.
 */
function estimate(
  boxes: number[],
  goals: number[],
  dists: Int32Array[],
): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 5) {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (let g = 0; g < goals.length; g++) {
        const d = dists[g]![b]!;
        if (d >= 0 && d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  const perm = goals.map((_, i) => i);
  let best = Infinity;
  const rec = (k: number, sum: number): void => {
    if (sum >= best) return;
    if (k === n) {
      best = sum;
      return;
    }
    for (let j = k; j < n; j++) {
      [perm[k], perm[j]] = [perm[j]!, perm[k]!];
      const d = dists[perm[k]!]![boxes[k]!]!;
      if (d >= 0) rec(k + 1, sum + d);
      [perm[k], perm[j]] = [perm[j]!, perm[k]!];
    }
  };
  rec(0, 0);
  return best;
}

type Push = { box: number; dir: number };

type SearchConfig = {
  w: number;
  h: number;
  wall: Uint8Array;
  /** Squares the player may stand on (room floor plus its door squares). */
  floor: Uint8Array;
  /** Squares a box may sit on (the room floor). */
  boxCells: Uint8Array;
  goals: number[];
  boxes0: number[];
  player0: number;
  maxExpansions: number;
};

/**
 * Push-optimal A* over push states. A state is the sorted boxes plus the
 * player's square; from it, every push the player can walk up to and make.
 * Returns the pushes of a cheapest solution, or null when the budget runs out
 * (or a box starts dead).
 */
function pushAStar(cfg: SearchConfig): { pushes: Push[] } | null {
  const { w, h, wall, floor, boxCells, goals, boxes0, player0 } = cfg;
  const live = liveSquares(w, h, floor, boxCells, goals);
  for (const b of boxes0) if (!live[b]) return null;
  const dists = goalDistances(w, h, wall, boxCells, goals);
  const goalSet = new Uint8Array(w * h);
  for (const g of goals) goalSet[g] = 1;

  const keyOf = (p: number, bs: number[]): string =>
    bs.join(',') + '|' + p;
  const solved = (bs: number[]): boolean => bs.every((b) => goalSet[b]);

  // Open list: binary heap on [f, h, insertion order, state], lowest first.
  const heap: [number, number, number, number][] = [];
  const less = (
    a: [number, number, number, number],
    b: [number, number, number, number],
  ): boolean =>
    a[0] < b[0] ||
    (a[0] === b[0] &&
      (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const sp: number[] = [player0];
  const sb: number[][] = [boxes0.slice()];
  const sg: number[] = [0];
  const sh: number[] = [estimate(boxes0, goals, dists)];
  const parent: number[] = [-1];
  const madeBy: (Push | null)[] = [null];
  const best = new Map<string, number>();
  best.set(keyOf(player0, boxes0), 0);
  let counter = 0;
  heapPush([sh[0]!, sh[0]!, counter++, 0]);

  let expanded = 0;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    if (best.get(keyOf(sp[s]!, sb[s]!)) !== s) continue;
    const bs = sb[s]!;
    if (solved(bs)) {
      const pushes: Push[] = [];
      for (let t = s; t > 0; t = parent[t]!) {
        pushes.push(madeBy[t]!);
      }
      pushes.reverse();
      return { pushes };
    }
    if (++expanded > cfg.maxExpansions) return null;
    const g = sg[s]!;
    const blocked = new Uint8Array(w * h);
    for (const b of bs) blocked[b] = 1;
    const region = reachable(w, h, wall, blocked, sp[s]!);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIRS[d]!;
        const sx = bx - dx;
        const sy = by - dy;
        const tx = bx + dx;
        const ty = by + dy;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        const behind = sy * w + sx;
        const dest = ty * w + tx;
        if (!region[behind]) continue;
        if (!boxCells[dest] || blocked[dest]) continue;
        const nb = bs.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        if (nb.some((x) => !live[x])) continue;
        const h2 = estimate(nb, goals, dists);
        if (h2 === Infinity) continue;
        const k = keyOf(b, nb);
        const seen = best.get(k);
        if (seen !== undefined && sg[seen]! <= g + 1) continue;
        const t = sp.length;
        sp.push(b);
        sb.push(nb);
        sg.push(g + 1);
        sh.push(h2);
        parent.push(s);
        madeBy.push({ box: b, dir: d });
        best.set(k, t);
        heapPush([g + 1 + h2, h2, counter++, t]);
      }
    }
  }
  return null;
}

/** Turn a push list into the walk-and-push moves that play it. */
function pushesToMoves(
  w: number,
  h: number,
  wall: Uint8Array,
  floor: Uint8Array,
  boxes0: number[],
  player0: number,
  pushes: Push[],
): { moves: string; player: number; boxes: number[] } | null {
  const blocked = new Uint8Array(w * h);
  for (const b of boxes0) blocked[b] = 1;
  let player = player0;
  let moves = '';
  for (const { box, dir } of pushes) {
    const [dx, dy] = DIRS[dir]!;
    const bx = box % w;
    const by = Math.floor(box / w);
    const behind = (by - dy) * w + (bx - dx);
    const walk = walkPath(w, h, wall, blocked, player, behind);
    if (walk === null) return null;
    moves += walk + DIRS[dir]![2];
    blocked[box] = 0;
    blocked[(by + dy) * w + (bx + dx)] = 1;
    player = box;
  }
  const boxes: number[] = [];
  for (let i = 0; i < blocked.length; i++) if (blocked[i]) boxes.push(i);
  return { moves, player, boxes };
}

type Room = {
  cells: Uint8Array;
  boxes: number[];
  goals: number[];
  /** Room squares touching the hallway (the door). */
  entries: number[];
  /** Hallway squares touching an entry (where the player stands to enter). */
  doors: number[];
};

/** Split a level into its rooms, or null when it does not split cleanly. */
function roomsOf(level: Level): Room[] | null {
  const { w, h, wall, goals, boxes, player } = level;
  const hallwayRow = Math.floor(player / w);
  const comp = new Int32Array(w * h).fill(-1);
  let nComp = 0;
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || Math.floor(i / w) === hallwayRow || comp[i] !== -1) continue;
    const queue = [i];
    comp[i] = nComp;
    for (let qi = 0; qi < queue.length; qi++) {
      for (const q of neighbours(w, h, queue[qi]!)) {
        if (!wall[q] && Math.floor(q / w) !== hallwayRow && comp[q] === -1) {
          comp[q] = nComp;
          queue.push(q);
        }
      }
    }
    nComp++;
  }
  const rooms: Room[] = [];
  let seenBoxes = 0;
  let seenGoals = 0;
  for (let c = 0; c < nComp; c++) {
    const cells = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (comp[i] === c) cells[i] = 1;
    const rBoxes = boxes.filter((b) => comp[b] === c);
    if (rBoxes.length === 0) continue;
    const rGoals = goals.filter((g) => comp[g] === c);
    if (rGoals.length !== rBoxes.length) return null;
    const entries: number[] = [];
    const doors: number[] = [];
    for (let i = 0; i < w * h; i++) {
      if (!cells[i]) continue;
      for (const q of neighbours(w, h, i)) {
        if (Math.floor(q / w) === hallwayRow && !wall[q]) {
          entries.push(i);
          if (!doors.includes(q)) doors.push(q);
        }
      }
    }
    entries.sort((a, b) => a - b);
    doors.sort((a, b) => a - b);
    if (entries.length === 0 || doors.length === 0) return null;
    seenBoxes += rBoxes.length;
    seenGoals += rGoals.length;
    rooms.push({ cells, boxes: rBoxes, goals: rGoals, entries, doors });
  }
  if (seenBoxes !== boxes.length || seenGoals !== goals.length) return null;
  return rooms;
}

/** Solve one level room by room; null when a room cannot be solved. */
function solveByRooms(level: Level): string | null {
  const { w, h, wall, boxes, player } = level;
  const rooms = roomsOf(level);
  if (rooms === null || rooms.length === 0) return null;
  const blocked = new Uint8Array(w * h);
  for (const b of boxes) blocked[b] = 1;
  let moves = '';
  let curPlayer = player;
  const todo = rooms.slice();
  while (todo.length > 0) {
    // Nearest room first, by the walk to its door; ties by room order.
    let pick = -1;
    let pickWalk: string | null = null;
    let pickDoor = 0;
    for (let ri = 0; ri < todo.length; ri++) {
      for (const door of todo[ri]!.doors) {
        const walk = walkPath(w, h, wall, blocked, curPlayer, door);
        if (walk === null) continue;
        if (
          pickWalk === null ||
          walk.length < pickWalk.length ||
          (walk.length === pickWalk.length && ri < pick)
        ) {
          pick = ri;
          pickWalk = walk;
          pickDoor = door;
        }
      }
    }
    if (pick < 0 || pickWalk === null) return null;
    const room = todo[pick]!;
    todo.splice(pick, 1);
    moves += pickWalk;
    curPlayer = pickDoor;
    const floor = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (room.cells[i]) floor[i] = 1;
    }
    for (const d of room.doors) floor[d] = 1;
    const found = pushAStar({
      w,
      h,
      wall,
      floor,
      boxCells: room.cells,
      goals: room.goals,
      boxes0: room.boxes,
      player0: pickDoor,
      maxExpansions: ROOM_EXPANSIONS,
    });
    if (found === null) return null;
    const played = pushesToMoves(
      w,
      h,
      wall,
      floor,
      room.boxes,
      pickDoor,
      found.pushes,
    );
    if (played === null) return null;
    moves += played.moves;
    curPlayer = played.player;
    for (const b of room.boxes) blocked[b] = 0;
    for (const b of played.boxes) blocked[b] = 1;
  }
  return moves;
}

/** Solve a whole level at once (fallback when it does not split by rooms). */
function solveWhole(level: Level): string | null {
  const { w, h, wall, goals, boxes, player } = level;
  const floor = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (!wall[i]) floor[i] = 1;
  const found = pushAStar({
    w,
    h,
    wall,
    floor,
    boxCells: floor,
    goals,
    boxes0: boxes,
    player0: player,
    maxExpansions: WHOLE_EXPANSIONS,
  });
  if (found === null) return null;
  const played = pushesToMoves(
    w,
    h,
    wall,
    floor,
    boxes,
    player,
    found.pushes,
  );
  return played === null ? null : played.moves;
}

/** Replay moves on a level; true when every step is legal and every box ends on a goal. */
function verifySolved(level: Level, moves: string): boolean {
  const { w, wall, goals, boxes, player } = level;
  const goalSet = new Uint8Array(wall.length);
  for (const g of goals) goalSet[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of boxes) box[b] = 1;
  let p = player;
  for (const ch of moves) {
    const dir = DIRS.find((d) => d[2] === ch);
    if (dir === undefined) return false;
    const [dx, dy] = dir;
    const q = p + dy * w + dx;
    if (wall[q]) return false;
    if (box[q]) {
      const beyond = q + dy * w + dx;
      if (wall[beyond] || box[beyond]) return false;
      box[q] = 0;
      box[beyond] = 1;
    }
    p = q;
  }
  for (let i = 0; i < box.length; i++) {
    if (box[i] && !goalSet[i]) return false;
  }
  return true;
}

function solve(text: string): string {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level);
  if (byRooms !== null && verifySolved(level, byRooms)) return byRooms;
  const whole = solveWhole(level);
  if (whole !== null && verifySolved(level, whole)) return whole;
  return '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
