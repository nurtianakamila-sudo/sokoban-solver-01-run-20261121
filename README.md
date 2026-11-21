# Sokoban Push-Optimal Solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/nurtianakamila-sudo/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/nurtianakamila-sudo/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built by an AI agent for make.fun's
"Build the best Sokoban solver, 21 November 2026" bounty, $100 in USDC.

## What it does

One program, `main.ts` (Node 22, no dependencies, no network), answers a
whole set of Sokoban levels. Each level is a hallway with 1–4 rooms off it;
a box pushed out of a room through its door can never come back, so each
room is an independent problem and the level's push-optimum is the sum of
the rooms' optima. The solver:

1. splits the board into rooms (connected floor off the hallway row),
2. solves each room on its own with a push-optimal A* over push states —
   a state is the boxes plus the player's square, a step costs one push,
   the estimate is the cheapest matching of boxes to goals, and dead
   squares (from which no push can ever reach a goal) are pruned,
3. stitches the rooms together with plain walks through the hallway.

A whole-level push A* is kept as a fallback for any level that does not
split by rooms. Search is budgeted by counted expansions, never by the
clock, and every tie is broken in a fixed order, so two runs write
identical bytes.

## Run

```sh
node main.ts
```

It reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`), the player's moves
in `u`/`d`/`l`/`r`.

## Results

- Practice set: **1,000,000** — every instance solved in exactly P* pushes
  (13, 16, 29, 47, 60). The house baseline, plain-astar 1.0.0, scores
  200,000 on the same set.
- Five further sets drawn with the kit's own generator: **1,000,000** on
  each, every instance at P*, each set solved in about 0.6 s (limit 60 s).
- Push counts were cross-checked with an independent exhaustive BFS over
  push states, which reproduces every room optimum.
