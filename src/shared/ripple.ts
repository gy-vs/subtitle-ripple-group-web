import {
  AppliedCue,
  Cue,
  Intent,
  MIN_DURATION,
  MIN_GAP,
  ResizeStartIntent,
  RippleIntent,
  SolveResult,
  TRACK_ORIGIN,
  durationOk,
} from './model';

// ---------------------------------------------------------------------------
// Pure ripple solver. Shared by the client (optimistic prediction) and the
// server (authoritative recomputation against the latest revision), so the
// two can never disagree about what a drag means.
//
// Model: cues are rigid intervals on a line. Locked cues are immovable
// barriers; the space between two barriers (or track origin / open end) is a
// segment. Moving a selection by d keeps the selection rigid, keeps unlocked
// followers pushed away from the drag direction (no overlaps, no pull), and is
// clamped to whatever the tightest locked barrier allows.
// ---------------------------------------------------------------------------

type Segment = {
  cues: Cue[]; // unlocked cues in chronological order
  leftBound: number; // end of the previous locked cue, or TRACK_ORIGIN
  rightBound: number; // start of the next locked cue, or +Infinity
  leftLock: Cue | null;
  rightLock: Cue | null;
};

export type RippleError = {
  error: 'anchor_missing' | 'anchor_locked' | 'invalid_track';
  affected: [];
  touchedIds: string[];
  appliedDelta: number;
  requestedDelta: number;
  inverse: Intent;
};

export type RippleOutcome = SolveResult | RippleError;

export function trackViolations(cues: Cue[]): string[] {
  const violations: string[] = [];
  const sorted = [...cues].sort(compareCue);
  let prevEnd = TRACK_ORIGIN;
  for (const cue of sorted) {
    if (cue.start < TRACK_ORIGIN) violations.push(`${cue.id}: starts before track origin`);
    if (!durationOk(cue)) violations.push(`${cue.id}: duration below ${MIN_DURATION}ms`);
    if (cue.start < prevEnd - MIN_GAP) violations.push(`${cue.id}: overlaps earlier cue`);
    prevEnd = cue.end;
  }
  return violations;
}

function compareCue(a: Cue, b: Cue): number {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function buildSegments(cues: Cue[]): Segment[] {
  const sorted = [...cues].sort(compareCue);
  const segments: Segment[] = [];
  let current: Cue[] = [];
  let leftLock: Cue | null = null;
  const flush = (rightLock: Cue | null) => {
    segments.push({
      cues: current,
      leftLock,
      rightLock,
      leftBound: leftLock ? leftLock.end : TRACK_ORIGIN,
      rightBound: rightLock ? rightLock.start : Infinity,
    });
    current = [];
  };
  for (const cue of sorted) {
    if (cue.locked) {
      flush(cue);
      leftLock = cue;
    } else {
      current.push(cue);
    }
  }
  flush(null);
  return segments.filter((segment) => segment.cues.length > 0);
}

const identity = (intent: RippleIntent, delta: number): RippleOutcome => ({
  affected: [],
  touchedIds: intent.selectedIds,
  appliedDelta: 0,
  requestedDelta: delta,
  inverse: {...intent},
});

export function solveRipple(cues: Cue[], intent: RippleIntent): RippleOutcome {
  if (trackViolations(cues).length > 0) {
    return {
      error: 'invalid_track',
      affected: [],
      touchedIds: intent.selectedIds,
      appliedDelta: 0,
      requestedDelta: 0,
      inverse: {...intent},
    };
  }

  const anchor = cues.find((cue) => cue.id === intent.anchorId);
  if (!anchor) {
    return {
      error: 'anchor_missing',
      affected: [],
      touchedIds: intent.selectedIds,
      appliedDelta: 0,
      requestedDelta: 0,
      inverse: {...intent},
    };
  }
  if (anchor.locked) {
    return {
      error: 'anchor_locked',
      affected: [],
      touchedIds: intent.selectedIds,
      appliedDelta: 0,
      requestedDelta: 0,
      inverse: {...intent},
    };
  }

  const requested = intent.anchorStart - anchor.start;
  if (requested === 0) return identity(intent, requested);

  // Locked members of the selection are barriers, not movers.
  const selected = new Set(intent.selectedIds.filter((id) => {
    const cue = cues.find((value) => value.id === id);
    return cue && !cue.locked;
  }));
  selected.add(anchor.id);

  const segments = buildSegments(cues);
  const relevant = segments.filter((segment) =>
    segment.cues.some((cue) => selected.has(cue.id)),
  );

  // Per-segment clamp, expressed as positive travel in the drag direction.
  let maxTravel = Infinity;
  for (const segment of relevant) {
    const n = segment.cues.length;
    const durations = segment.cues.map((cue) => cue.end - cue.start);
    if (requested > 0) {
      // Latest possible start of cue k when k..n-1 are packed against the
      // right lock: rightBound - suffixDurations - gaps. Current gaps only
      // compress during a rightward move, so they never extend the bound.
      const latest = new Array<number>(n);
      latest[n - 1] = segment.rightBound - MIN_GAP - durations[n - 1];
      for (let i = n - 2; i >= 0; i--) {
        latest[i] = latest[i + 1] - MIN_GAP - durations[i];
      }
      segment.cues.forEach((cue, index) => {
        if (selected.has(cue.id)) {
          maxTravel = Math.min(maxTravel, latest[index] - cue.start);
        }
      });
    } else {
      // Earliest possible start of cue k when 0..k are packed against the
      // left lock: leftBound + prefixDurations + gaps. A leftward drag
      // presses the unselected predecessor chain; the leftmost selected cue
      // in each segment sees the tightest bound.
      const earliest = new Array<number>(n);
      earliest[0] = segment.leftBound + MIN_GAP;
      for (let i = 1; i < n; i++) {
        earliest[i] = earliest[i - 1] + MIN_GAP + durations[i - 1];
      }
      segment.cues.forEach((cue, index) => {
        if (selected.has(cue.id)) {
          maxTravel = Math.min(maxTravel, cue.start - earliest[index]);
        }
      });
    }
  }
  if (maxTravel < 0) maxTravel = 0;
  const applied =
    requested > 0
      ? Math.min(requested, maxTravel)
      : Math.max(requested, -maxTravel) || 0;

  const affectedById = new Map<string, AppliedCue>();
  const touched = new Set<string>();

  for (const segment of relevant) {
    if (segment.leftLock) touched.add(segment.leftLock.id);
    if (segment.rightLock) touched.add(segment.rightLock.id);
    const moved = new Array<{cue: Cue; start: number}>(segment.cues.length);

    if (applied >= 0) {
      // Left -> right: followers are pushed, gaps ahead are never closed by pull.
      let prevEnd = segment.leftBound;
      segment.cues.forEach((cue, index) => {
        const base = cue.start + (selected.has(cue.id) ? applied : 0);
        const start = Math.max(base, prevEnd + MIN_GAP);
        moved[index] = {cue, start};
        prevEnd = start + (cue.end - cue.start);
      });
    } else {
      // Right -> left: selected cues translate by -travel; unselected
      // predecessors are pushed back only on contact (open gaps never close).
      let nextStart = segment.rightBound;
      for (let index = segment.cues.length - 1; index >= 0; index--) {
        const cue = segment.cues[index];
        const duration = cue.end - cue.start;
        const base = cue.start + (selected.has(cue.id) ? applied : 0);
        const start = Math.min(base, nextStart - MIN_GAP - duration);
        moved[index] = {cue, start};
        nextStart = start;
      }
    }

    for (const {cue, start} of moved) {
      touched.add(cue.id);
      if (start !== cue.start) {
        affectedById.set(cue.id, {
          id: cue.id,
          kind: 'timing',
          start,
          end: start + (cue.end - cue.start),
          locked: false,
        });
      }
    }
  }

  // Inverse: send the anchor back to its original absolute start. Re-solving
  // on the new layout re-runs every constraint instead of restoring a snapshot.
  const inverse: RippleIntent = {
    type: 'ripple',
    anchorId: anchor.id,
    selectedIds: intent.selectedIds,
    anchorStart: anchor.start,
  };

  return {
    affected: [...affectedById.values()].sort((a, b) =>
      a.kind === 'timing' && b.kind === 'timing' ? a.start - b.start : 0,
    ),
    touchedIds: [...touched],
    appliedDelta: applied,
    requestedDelta: requested,
    inverse,
  };
}

// ---------------------------------------------------------------------------
// Single-cue start-edge resize. Only this cue changes; the edge is capped by
// the track origin, MIN_DURATION and the preceding cue's tail (no overlap).
// ---------------------------------------------------------------------------

export function solveResizeStart(cues: Cue[], intent: ResizeStartIntent): RippleOutcome {
  if (trackViolations(cues).length > 0) {
    return {
      error: 'invalid_track',
      affected: [],
      touchedIds: [intent.cueId],
      appliedDelta: 0,
      requestedDelta: 0,
      inverse: {...intent},
    };
  }
  const sorted = [...cues].sort(compareCue);
  const index = sorted.findIndex((cue) => cue.id === intent.cueId);
  const cue = sorted[index];
  if (!cue) {
    return {
      error: 'anchor_missing',
      affected: [],
      touchedIds: [intent.cueId],
      appliedDelta: 0,
      requestedDelta: 0,
      inverse: {...intent},
    };
  }
  if (cue.locked) {
    return {
      error: 'anchor_locked',
      affected: [],
      touchedIds: [intent.cueId],
      appliedDelta: 0,
      requestedDelta: 0,
      inverse: {...intent},
    };
  }

  const predecessor = index > 0 ? sorted[index - 1] : null;
  const lowerBound = Math.max(
    TRACK_ORIGIN + MIN_GAP,
    predecessor ? predecessor.end + MIN_GAP : TRACK_ORIGIN,
  );
  const upperBound = cue.end - MIN_DURATION;
  const start = Math.min(upperBound, Math.max(lowerBound, Math.round(intent.start)));

  const touchedIds = [cue.id];
  if (predecessor) touchedIds.push(predecessor.id);
  const inverse: ResizeStartIntent = {type: 'resize-start', cueId: cue.id, start: cue.start};

  if (start === cue.start) {
    return {affected: [], touchedIds, appliedDelta: 0, requestedDelta: intent.start - cue.start, inverse};
  }
  return {
    affected: [{id: cue.id, kind: 'timing', start, end: cue.end, locked: false}],
    touchedIds,
    appliedDelta: start - cue.start,
    requestedDelta: intent.start - cue.start,
    inverse,
  };
}

export function solve(cues: Cue[], intent: Intent): RippleOutcome {
  switch (intent.type) {
    case 'ripple':
      return solveRipple(cues, intent);
    case 'resize-start':
      return solveResizeStart(cues, intent);
    case 'lock': {
      const cue = cues.find((value) => value.id === intent.cueId);
      if (!cue) {
        return {
          error: 'anchor_missing',
          affected: [],
          touchedIds: [intent.cueId],
          appliedDelta: 0,
          requestedDelta: 0,
          inverse: {...intent, locked: !intent.locked},
        };
      }
      if (cue.locked === intent.locked) {
        return {
          affected: [],
          touchedIds: [cue.id],
          appliedDelta: 0,
          requestedDelta: 0,
          inverse: {...intent, locked: !intent.locked},
        };
      }
      return {
        affected: [{id: cue.id, kind: 'lock', locked: intent.locked}],
        touchedIds: [cue.id],
        appliedDelta: 0,
        requestedDelta: 0,
        inverse: {...intent, locked: !intent.locked},
      };
    }
  }
}

// Apply a solver result to a cue list, returning the new list. Lock updates
// only flip the flag; timing updates move start/end.
export function applyAffected(cues: Cue[], affected: AppliedCue[]): Cue[] {
  const byId = new Map(affected.map((cue) => [cue.id, cue]));
  return cues.map((cue) => {
    const update = byId.get(cue.id);
    if (!update) return cue;
    if (update.kind === 'lock') return {...cue, locked: update.locked};
    return {...cue, start: update.start, end: update.end};
  });
}
