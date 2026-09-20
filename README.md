# Subtitle Timing Studio

Local workbench for timed cues with ripple moves, locked barriers and
revision-aware multi-tab sync.

Run `npm install`, then `npm run dev` (API on `:4174`, Vite on `:4173`).
Tests: `npm test`. Type check + build: `npm run build`.

## Model

- Cue: `{id, start, end, locked, text}` (times in ms). Every state the system
  produces satisfies: `start >= 0`, `end - start >= 500`, no overlaps between
  cues ordered by start, locked cues never move.
- `src/shared/engine.ts` is the single pure constraint engine used both for the
  client's optimistic local prediction and the server's authoritative
  recompute.

## Ripple semantics

Dragging a cue's start applies a `ripple` intent:

- the anchor plus every selected unlocked cue seeds a block; each block is the
  maximal contiguous run of unlocked cues from its seed in the drag direction;
- all cues in a block translate by one shared delta — in-group gaps are
  preserved and unlocked successors (forward) / predecessors (backward) are
  pushed along;
- propagation stops at the first locked cue (or the track start going back),
  and the tightest block bound clamps the whole gesture so overlaps are
  impossible; disjoint selection intervals share one delta;
- cues behind a locked barrier never move.

Side handles issue `trim` intents clamped to the neighbour boundary, track
start and the 500 ms minimum duration.

## Sync protocol

`POST /api/tracks/:id/operations` takes `{revision, intent}`. The server
always recomputes the intent against current state:

- current revision → commit, return the new track, changed/affected cue ids,
  the clamp detail and the **inverse intent**;
- stale revision but the concurrent edit is outside the operation's closure
  (affected cues + barrier) → automatically rebase and commit (`rebased:
  true`);
- stale revision with an edit inside the closure → `409` carrying the
  **minimal conflict set** and the current track; nothing is committed. The
  client keeps the drag intent alive and can replay it against the new
  revision ("Replay" button) instead of overwriting the other page;
- base revision unknown → `409` with `conflicts: null` for a full rebase.

`POST /api/tracks/:id/debug/external-touch` simulates another page moving a
cue so the conflict flow can be exercised from the UI.

## Undo

Undo is not a whole-track snapshot restore: each committed operation returns
an inverse intent, and undo submits that inverse as a new operation that is
re-validated and re-constrained on the server (it can itself be rebased or
clamped by later edits/locks).
