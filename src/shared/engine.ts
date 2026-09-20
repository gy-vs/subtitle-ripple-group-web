/**
 * Pure timing/ripple engine shared by the client (optimistic prediction)
 * and the server (authoritative recompute). No I/O, no React, no Express.
 *
 * Time unit: integer milliseconds.
 *
 * Invariants enforced on every produced cue list:
 *  - cue.start >= TRACK_START
 *  - cue.end - cue.start >= MIN_DURATION
 *  - for cues ordered by start: prev.end <= next.start (touching is allowed,
 *    overlap is not)
 *  - locked cues never move
 */

export const TRACK_START = 0;
export const MIN_DURATION = 500;

export type Cue = {
  id: string;
  start: number;
  end: number;
  locked: boolean;
  text: string;
};

export type Track = {
  id: string;
  name: string;
  revision: number;
  cues: Cue[];
  updatedAt: string;
};

/** Drag the start of the anchor cue; the whole selection moves rigidly. */
export type RippleIntent = {
  type: 'ripple';
  anchorId: string;
  selection: string[];
  desiredAnchorStart: number;
};

/** Drag one edge of a single cue (clamped, never moves neighbours). */
export type TrimIntent = {
  type: 'trim';
  cueId: string;
  edge: 'start' | 'end';
  desired: number;
};

export type LockIntent = {
  type: 'lock';
  cueId: string;
  locked: boolean;
};

export type Intent = RippleIntent | TrimIntent | LockIntent;

export type RippleDetail = {
  requestedDelta: number;
  appliedDelta: number;
  direction: 1 | -1 | 0;
  clamped: boolean;
  /** Id of the locked cue that bound the clamp, or 'TRACK_START'. */
  barrier: string | null;
  anchorRequestedStart: number;
  anchorActualStart: number;
};

export type ApplyOutcome = {
  ok: boolean;
  error?: string;
  cues: Cue[];
  /** Cues whose start/end/locked state actually changed. */
  changed: string[];
  /**
   * Cues involved in the computation: moving cues, the barrier that stopped
   * propagation and trim neighbours. This is the closure used to compute the
   * minimal conflict set on the server.
   */
  affected: string[];
  inverse: Intent | null;
  ripple: RippleDetail | null;
};

const failed = (cues: Cue[], error: string): ApplyOutcome => ({
  ok: false,
  error,
  cues,
  changed: [],
  affected: [],
  inverse: null,
  ripple: null,
});

export function sortedCues(cues: Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
}

function clone(cues: Cue[]): Cue[] {
  return cues.map((cue) => ({...cue}));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Validate the global cue list; returns human-readable violations. */
export function validateCues(cues: Cue[]): string[] {
  const errors: string[] = [];
  const order = sortedCues(cues);
  for (const cue of order) {
    if (cue.start < TRACK_START) errors.push(`${cue.id}: cue starts before track start (${cue.start})`);
    if (cue.end - cue.start < MIN_DURATION) errors.push(`${cue.id}: shorter than minimum duration`);
    if (cue.end <= cue.start) errors.push(`${cue.id}: non-positive duration`);
  }
  for (let i = 1; i < order.length; i += 1) {
    if (order[i - 1].end > order[i].start) {
      errors.push(`${order[i - 1].id} overlaps ${order[i].id}`);
    }
  }
  return errors;
}

/* ------------------------------------------------------------------ */
/* ripple                                                              */
/* ------------------------------------------------------------------ */

function applyRipple(input: Cue[], intent: RippleIntent): ApplyOutcome {
  const cues = clone(input);
  const byId = new Map(cues.map((cue) => [cue.id, cue]));
  const anchor = byId.get(intent.anchorId);
  if (!anchor) return failed(input, `unknown anchor cue ${intent.anchorId}`);
  if (anchor.locked) return failed(input, `anchor cue ${intent.anchorId} is locked`);

  const order = sortedCues(cues);
  const index = new Map(order.map((cue, i) => [cue.id, i]));
  const anchorIndex = index.get(anchor.id)!;

  const selected = new Set(intent.selection);
  selected.add(anchor.id);

  const requestedStart = Math.round(intent.desiredAnchorStart);
  if (!Number.isFinite(requestedStart)) return failed(input, 'desiredAnchorStart is not finite');
  const requestedDelta = requestedStart - anchor.start;
  if (requestedDelta === 0) {
    return {ok: true, cues, changed: [], affected: [anchor.id], inverse: null, ripple: null};
  }
  const direction: 1 | -1 = requestedDelta > 0 ? 1 : -1;

  /*
   * Every selected unlocked cue seeds a block: starting at the seed, walk in
   * the drag direction across a contiguous run of unlocked cues. Everything in
   * that walk moves by the same delta (gaps inside the block are preserved),
   * propagation stops at the first locked cue. Disjoint selection intervals
   * separated by a locked cue produce independent blocks sharing one delta, and
   * the tightest block binds the clamp.
   */
  const n = order.length;
  const moving = new Array<boolean>(n).fill(false);
  const affected = new Set<string>();
  let minDelta = -Infinity;
  let maxDelta = Infinity;
  let forwardBarrier: string | null = null;
  let backwardBarrier: string | null = null;

  const isMovableSeed = (cue: Cue) => selected.has(cue.id) && !cue.locked;

  for (let s = 0; s < n; s += 1) {
    if (!isMovableSeed(order[s])) continue;
    let e = s;
    if (direction === 1) {
      while (e + 1 < n && !order[e + 1].locked) e += 1;
      for (let k = s; k <= e; k += 1) {
        moving[k] = true;
        affected.add(order[k].id);
      }
      const barrier = e + 1 < n ? order[e + 1] : null; // necessarily locked
      const room = barrier ? barrier.start - order[e].end : Infinity;
      if (room < maxDelta) {
        maxDelta = room;
        forwardBarrier = barrier ? barrier.id : null;
      }
      if (barrier) affected.add(barrier.id);
    } else {
      // Walk left across unlocked predecessors. A locked predecessor is the
      // barrier: it stays out of the moving block.
      while (e - 1 >= 0 && !order[e - 1].locked) e -= 1;      for (let k = e; k <= s; k += 1) {
        moving[k] = true;
        affected.add(order[k].id);
      }
      const barrier = e - 1 >= 0 ? order[e - 1] : null; // necessarily locked
      const bound = barrier ? barrier.end : TRACK_START;
      const room = bound - order[e].start; // <= 0
      if (room > minDelta) {
        minDelta = room;
        backwardBarrier = barrier ? barrier.id : 'TRACK_START';
      }
      if (barrier) affected.add(barrier.id);
    }
  }

  const appliedDelta = Math.round(clamp(requestedDelta, minDelta, maxDelta));

  const changed: string[] = [];
  if (appliedDelta !== 0) {
    for (let i = 0; i < n; i += 1) {
      if (!moving[i]) continue;
      const cue = order[i];
      cue.start += appliedDelta;
      cue.end += appliedDelta;
      changed.push(cue.id);
    }
  }

  const errors = validateCues(cues);
  if (errors.length) return failed(input, `ripple would violate constraints: ${errors.join('; ')}`);

  const detail: RippleDetail = {
    requestedDelta,
    appliedDelta,
    direction,
    clamped: appliedDelta !== requestedDelta,
    barrier: direction === 1 ? forwardBarrier : backwardBarrier,
    anchorRequestedStart: requestedStart,
    anchorActualStart: anchor.start,
  };

  const inverse: RippleIntent | null =
    changed.length === 0
      ? null
      : {
          type: 'ripple',
          anchorId: anchor.id,
          // forward ripples can push unselected successors; the inverse seeds
          // the cues that ACTUALLY moved so the drag reverses symmetrically
          selection: changed,
          desiredAnchorStart: input.find((cue) => cue.id === anchor.id)!.start,
        };

  return {ok: true, cues, changed, affected: [...affected], inverse, ripple: detail};
}

/* ------------------------------------------------------------------ */
/* trim                                                                */
/* ------------------------------------------------------------------ */

function applyTrim(input: Cue[], intent: TrimIntent): ApplyOutcome {
  const cues = clone(input);
  const cue = cues.find((value) => value.id === intent.cueId);
  if (!cue) return failed(input, `unknown cue ${intent.cueId}`);
  if (cue.locked) return failed(input, `cue ${intent.cueId} is locked`);
  const desired = Math.round(intent.desired);
  if (!Number.isFinite(desired)) return failed(input, 'desired edge is not finite');

  const order = sortedCues(cues);
  const i = order.findIndex((value) => value.id === cue.id);
  const prev = i > 0 ? order[i - 1] : null;
  const next = i < order.length - 1 ? order[i + 1] : null;
  const affected = new Set<string>([cue.id]);
  if (prev) affected.add(prev.id);
  if (next) affected.add(next.id);

  if (intent.edge === 'start') {
    const lower = Math.max(TRACK_START, prev ? prev.end : TRACK_START);
    cue.start = clamp(desired, lower, cue.end - MIN_DURATION);
  } else {
    const upper = next ? next.start : Infinity;
    cue.end = clamp(desired, cue.start + MIN_DURATION, upper);
  }

  const changed =
    cue.start === input.find((value) => value.id === cue.id)!.start &&
    cue.end === input.find((value) => value.id === cue.id)!.end
      ? []
      : [cue.id];

  const original = input.find((value) => value.id === cue.id)!;
  const inverse: TrimIntent = {
    type: 'trim',
    cueId: cue.id,
    edge: intent.edge,
    desired: intent.edge === 'start' ? original.start : original.end,
  };

  return {
    ok: true,
    cues,
    changed,
    affected: [...affected],
    inverse: changed.length ? inverse : null,
    ripple: null,
  };
}

/* ------------------------------------------------------------------ */
/* lock                                                                */
/* ------------------------------------------------------------------ */

function applyLock(input: Cue[], intent: LockIntent): ApplyOutcome {
  const cues = clone(input);
  const cue = cues.find((value) => value.id === intent.cueId);
  if (!cue) return failed(input, `unknown cue ${intent.cueId}`);
  if (cue.locked === intent.locked) {
    return {ok: true, cues, changed: [], affected: [cue.id], inverse: null, ripple: null};
  }
  cue.locked = intent.locked;
  const inverse: LockIntent = {type: 'lock', cueId: cue.id, locked: !intent.locked};
  return {
    ok: true,
    cues,
    changed: [cue.id],
    affected: [cue.id],
    inverse,
    ripple: null,
  };
}

/* ------------------------------------------------------------------ */

export function simulate(input: Cue[] | Track, intent: Intent): ApplyOutcome {
  const cues = Array.isArray(input) ? input : input.cues;
  switch (intent.type) {
    case 'ripple':
      return applyRipple(cues, intent);
    case 'trim':
      return applyTrim(cues, intent);
    case 'lock':
      return applyLock(cues, intent);
    default:
      return failed(cues, 'unknown intent type');
  }
}

/** Structural equality for the timing-relevant fields of a cue. */
export function cueTimingEqual(a: Cue, b: Cue): boolean {
  return a.start === b.start && a.end === b.end && a.locked === b.locked;
}

/**
 * Minimal conflict set: cues inside `affected` whose timing/lock state differs
 * between the client's base revision and the server's current state.
 * Cues outside the computation closure are irrelevant even if they changed.
 */
export function diffCues(base: Cue[], current: Cue[], affected: string[]): string[] {
  const baseById = new Map(base.map((cue) => [cue.id, cue]));
  const currentById = new Map(current.map((cue) => [cue.id, cue]));
  const conflicts: string[] = [];
  for (const id of affected) {
    const before = baseById.get(id);
    const now = currentById.get(id);
    if (!before || !now || !cueTimingEqual(before, now)) conflicts.push(id);
  }
  return conflicts;
}
