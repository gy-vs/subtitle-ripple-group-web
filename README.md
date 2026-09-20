# Subtitle Timing Studio

Ripple-group cue timing editor with revision-safe collaborative commits.

Run `npm install`, then `npm run dev` (server on `:4174`, Vite on `:4173`).
`npm test` runs the solver unit tests and the HTTP API tests.

## Interaction model

- **Drag a cue body** — ripple move: the selection translates rigidly, unlocked
  cues in the drag direction are pushed so nothing ever overlaps. Open gaps
  are never closed by a pull.
- **Shift-click** — add/remove cues from the selection; disjoint intervals move
  together with fixed intra-group spacing.
- **Drag a cue's left edge** — move only that cue's start; clamped to the
  track origin, `MIN_DURATION` (500 ms), and the preceding cue's tail.
- **Lock toggle** — a locked cue is an immovable barrier; ripple propagation
  stops against it (backward and forward).
- **Undo** — submits the server-provided **inverse intent** and re-runs all
  constraints against the live track; it is never a whole-track snapshot
  restore, so a lock or edit added meanwhile makes undo best-effort.

## Concurrency

- The client paints a **local prediction** immediately and posts
  `{revision, intent, base}` to `POST /api/tracks/:id/intent`.
- The server solves the intent against its current cues (the shared solver in
  `src/shared/ripple.ts`) and returns only the affected cues, bumping the
  revision. A stale revision whose result is unchanged auto-rebases
  (`rebased: true`).
- If recomputation on the new state diverges, the server returns **409 with
  the minimal conflict set** plus the preserved intent. The client rolls back
  the prediction, highlights the conflicting cues, and offers
  "Refresh & replay" to re-enter the same drag target on the new revision
  instead of overwriting the other page.

## Layout

- `src/shared/model.ts`, `src/shared/ripple.ts` — domain + pure constraint
  solver used identically by client prediction and server recomputation.
- `src/server/index.ts` — express store, revision handling, conflict detection.
- `src/client/App.tsx` — timeline UI, prediction, replay, inverse undo.
- `test/ripple.test.ts` — forward/backward moves, locks, origin, multi-range
  selections, min duration, inverse undo, randomized invariants.
- `test/api.test.ts` — authoritative apply, auto-rebase, minimal conflicts,
  anchor-locked conflicts, intent replay, zero-delta no-op.
