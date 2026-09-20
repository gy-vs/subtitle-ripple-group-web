import {describe, expect, it} from 'vitest';
import {
  Cue,
  MIN_DURATION,
  cueTimingEqual,
  diffCues,
  simulate,
  validateCues,
} from '../src/shared/engine';

let seq = 0;
function mkCue(start: number, end: number, locked = false): Cue {
  seq += 1;
  return {id: `c${seq}`, start, end, locked, text: `cue ${seq}`};
}

function timings(cues: Cue[]): Record<string, [number, number]> {
  return Object.fromEntries(cues.map((cue) => [cue.id, [cue.start, cue.end]]));
}

describe('ripple engine', () => {
  it('moves forward, preserves in-group gaps and pushes unlocked successors', () => {
    const a = mkCue(0, 1000);
    const b = mkCue(1000, 2000);
    const l = mkCue(3000, 4000, true);
    const d = mkCue(4000, 5000);
    const cues = [a, b, l, d];

    const out = simulate(cues, {
      type: 'ripple',
      anchorId: a.id,
      selection: [a.id],
      desiredAnchorStart: 300,
    });
    expect(out.ok).toBe(true);
    const map = timings(out.cues);
    expect(map[a.id]).toEqual([300, 1300]);
    expect(map[b.id]).toEqual([1300, 2300]); // pushed, gap to a preserved (touching)
    expect(map[l.id]).toEqual([3000, 4000]); // locked never moves
    expect(map[d.id]).toEqual([4000, 5000]); // behind the locked barrier, untouched
    expect(out.ripple?.clamped).toBe(false);
    expect(validateCues(out.cues)).toEqual([]);
  });

  it('clamps forward propagation at the locked barrier (no overlap)', () => {
    const a = mkCue(0, 1000);
    const b = mkCue(1000, 2000);
    const l = mkCue(3000, 4000, true);
    const out = simulate([a, b, l], {
      type: 'ripple',
      anchorId: a.id,
      selection: [a.id],
      desiredAnchorStart: 9999,
    });
    expect(out.ok).toBe(true);
    expect(out.ripple?.appliedDelta).toBe(1000);
    expect(out.ripple?.barrier).toBe(l.id);
    const map = timings(out.cues);
    expect(map[a.id]).toEqual([1000, 2000]);
    expect(map[b.id]).toEqual([2000, 3000]); // touching the locked cue, never overlapping
    expect(validateCues(out.cues)).toEqual([]);
  });

  it('moves backward and pulls the unlocked run toward the track start', () => {
    const a = mkCue(200, 1000);
    const b = mkCue(1000, 2000);
    const l = mkCue(3000, 4000, true);
    const out = simulate([a, b, l], {
      type: 'ripple',
      anchorId: b.id,
      selection: [b.id],
      desiredAnchorStart: 600,
    });
    expect(out.ok).toBe(true);
    expect(out.ripple?.appliedDelta).toBe(-200); // TRACK_START binds, not the -400 asked
    expect(out.ripple?.barrier).toBe('TRACK_START');
    const map = timings(out.cues);
    expect(map[a.id]).toEqual([0, 800]);
    expect(map[b.id]).toEqual([800, 1800]);
    expect(validateCues(out.cues)).toEqual([]);
  });

  it('stops backward propagation at a locked predecessor', () => {
    const l = mkCue(0, 1000, true);
    const a = mkCue(1000, 2000);
    const b = mkCue(2000, 3000);
    const out = simulate([l, a, b], {
      type: 'ripple',
      anchorId: b.id,
      selection: [b.id],
      desiredAnchorStart: 500,
    });
    expect(out.ok).toBe(true);
    expect(out.ripple?.appliedDelta).toBe(0);
    expect(out.ripple?.barrier).toBe(l.id);
    expect(out.changed).toEqual([]);
  });

  it('handles multiple disjoint selection intervals with one shared, tightest-bound delta', () => {
    const a = mkCue(0, 1200);
    const b = mkCue(1400, 3000);
    const l3 = mkCue(3500, 5000, true);
    const d = mkCue(5000, 7000);
    const e = mkCue(7200, 9000);
    const l6 = mkCue(9500, 11000, true);
    const g = mkCue(11000, 12500);
    const out = simulate([a, b, l3, d, e, l6, g], {
      type: 'ripple',
      anchorId: a.id,
      selection: [a.id, d.id],
      desiredAnchorStart: a.start + 1000,
    });
    expect(out.ok).toBe(true);
    // each block has exactly 500ms room before its locked barrier
    expect(out.ripple?.appliedDelta).toBe(500);
    const map = timings(out.cues);
    expect(map[a.id]).toEqual([500, 1700]);
    expect(map[b.id]).toEqual([1900, 3500]);
    expect(map[l3.id]).toEqual([3500, 5000]);
    expect(map[d.id]).toEqual([5500, 7500]);
    expect(map[e.id]).toEqual([7700, 9500]);
    expect(map[l6.id]).toEqual([9500, 11000]);
    expect(map[g.id]).toEqual([11000, 12500]);
  });

  it('rejects a locked anchor', () => {
    const l = mkCue(0, 1000, true);
    const out = simulate([l], {
      type: 'ripple',
      anchorId: l.id,
      selection: [l.id],
      desiredAnchorStart: 100,
    });
    expect(out.ok).toBe(false);
  });

  it('undo intent replays through the engine and restores timings', () => {
    const a = mkCue(0, 1000);
    const b = mkCue(1000, 2000);
    const first = simulate([a, b], {
      type: 'ripple',
      anchorId: a.id,
      selection: [a.id],
      desiredAnchorStart: 300,
    });
    expect(first.inverse).not.toBeNull();
    const undone = simulate(first.cues, first.inverse!);
    expect(undone.ok).toBe(true);
    expect(timings(undone.cues)[a.id]).toEqual([0, 1000]);
    expect(timings(undone.cues)[b.id]).toEqual([1000, 2000]);
  });
});

describe('trim constraints', () => {
  it('enforces minimum duration on both edges', () => {
    const a = mkCue(1000, 3000);
    const start = simulate([a], {type: 'trim', cueId: a.id, edge: 'start', desired: 9999});
    expect(start.cues[0].start).toBe(3000 - MIN_DURATION);
    const end = simulate([a], {type: 'trim', cueId: a.id, edge: 'end', desired: 0});
    expect(end.cues[0].end).toBe(1000 + MIN_DURATION);
  });

  it('clamps trim at adjacent cues and track start instead of overlapping', () => {
    const prev = mkCue(0, 1000);
    const a = mkCue(1200, 3000);
    const next = mkCue(3500, 4200);
    const start = simulate([prev, a, next], {
      type: 'trim',
      cueId: a.id,
      edge: 'start',
      desired: 0,
    });
    expect(start.cues.find((c) => c.id === a.id)!.start).toBe(1000);
    const end = simulate([prev, a, next], {
      type: 'trim',
      cueId: a.id,
      edge: 'end',
      desired: 9999,
    });
    expect(end.cues.find((c) => c.id === a.id)!.end).toBe(3500);
  });

  it('refuses to trim a locked cue', () => {
    const a = mkCue(0, 1000, true);
    const out = simulate([a], {type: 'trim', cueId: a.id, edge: 'start', desired: 0});
    expect(out.ok).toBe(false);
  });
});

describe('lock toggle and validation', () => {
  it('toggles lock and inverts', () => {
    const a = mkCue(0, 1000);
    const out = simulate([a], {type: 'lock', cueId: a.id, locked: true});
    expect(out.ok).toBe(true);
    expect(out.cues[0].locked).toBe(true);
    const back = simulate(out.cues, out.inverse!);
    expect(back.cues[0].locked).toBe(false);
  });

  it('reports overlap, minimum-duration and track-start violations', () => {
    expect(validateCues([mkCue(-10, 100)]).some((m) => m.includes('before track start'))).toBe(true);
    expect(validateCues([mkCue(0, 10)]).some((m) => m.includes('minimum duration'))).toBe(true);
    expect(validateCues([mkCue(0, 1000), mkCue(900, 1500)]).some((m) => m.includes('overlaps'))).toBe(true);
  });
});

describe('minimal conflict set', () => {
  it('reports only changed cues inside the operation closure', () => {
    const a = mkCue(0, 1000);
    const b = mkCue(1000, 2000);
    const l = mkCue(3000, 4000, true);
    const d = mkCue(4000, 5000);
    const base = [a, b, l, d];
    // another page moves d, which is outside the [a,b -> l] closure
    const current = base.map((c) => (c.id === d.id ? {...c, start: 4100, end: 5100} : {...c}));
    const closure = [a.id, b.id, l.id];
    expect(diffCues(base, current, closure)).toEqual([]);
    // if the moved cue is in the closure, it is reported
    const current2 = base.map((c) => (c.id === b.id ? {...c, start: 1050, end: 2050} : {...c}));
    expect(diffCues(base, current2, closure)).toEqual([b.id]);
  });

  it('treats cue timing equality structurally', () => {
    const a = mkCue(0, 1000);
    expect(cueTimingEqual({...a, text: 'x'}, {...a, text: 'y'})).toBe(true);
    expect(cueTimingEqual(a, {...a, locked: true})).toBe(false);
  });
});
