import {describe, expect, it} from 'vitest';
import {Cue, Intent, MIN_DURATION, RippleIntent} from '../src/shared/model';
import {applyAffected, solve, solveRipple, trackViolations} from '../src/shared/ripple';

const cue = (id: string, start: number, end: number, locked = false): Cue => ({
  id, start, end, locked, text: id,
});

const fixture = (): Cue[] => [
  cue('c1', 0, 1500),
  cue('c2', 2000, 3200),
  cue('c3', 3600, 5000),
  cue('c4', 5400, 6800, true),
  cue('c5', 7000, 8200),
  cue('c6', 8500, 9800),
  cue('c7', 10200, 11500),
];

const ripple = (cues: Cue[], anchorId: string, anchorStart: number, selectedIds?: string[]) => {
  const intent: RippleIntent = {
    type: 'ripple',
    anchorId,
    selectedIds: selectedIds ?? [anchorId],
    anchorStart,
  };
  const result = solveRipple(cues, intent);
  if ('error' in result) throw new Error('unexpected solver error: ' + result.error);
  return result;
};

const run = (cues: Cue[], intent: Intent) => {
  const result = solve(cues, intent);
  if ('error' in result) throw new Error('unexpected solver error: ' + result.error);
  return {cues: applyAffected(cues, result.affected), result};
};

const valid = (cues: Cue[]) => expect(trackViolations(cues)).toEqual([]);
const byId = (cues: Cue[]) => new Map(cues.map((cue) => [cue.id, cue]));

describe('ripple solver – forward moves', () => {
  it('pushes unlocked followers and leaves earlier cues untouched', () => {
    const result = ripple(fixture(), 'c2', 2500);
    expect(result.appliedDelta).toBe(500);
    const next = applyAffected(fixture(), result.affected);
    const map = byId(next);
    expect(map.get('c1')!.start).toBe(0);
    expect(map.get('c2')!.start).toBe(2500);
    // c3 was 400ms away, so it must be pushed by 100ms (3600 -> 3700).
    expect(map.get('c3')!.start).toBe(3700);
    // locked bridge c4 stops the chain: c3 (end 5100) still clears 5400...
    expect(map.get('c4')!.start).toBe(5400);
    valid(next);
    expect(result.affected.map((cue) => cue.id).sort()).toEqual(['c2', 'c3']);
  });

  it('is clamped by a locked barrier in the drag direction (no overlap)', () => {
    // c3 wants to jump to 5600 but locked c4 starts at 5400.
    const result = ripple(fixture(), 'c3', 5600);
    expect(result.requestedDelta).toBe(2000);
    expect(result.appliedDelta).toBe(400);
    const next = applyAffected(fixture(), result.affected);
    const map = byId(next);
    expect(map.get('c3')!.start).toBe(4000);
    expect(map.get('c3')!.end).toBe(5400);
    expect(map.get('c3')!.end).toBeLessThanOrEqual(map.get('c4')!.start);
    valid(next);
  });

  it('keeps the whole selection rigid when the tightest member is blocked', () => {
    // Lock-free fixture so the group is clamped only by track origin/end.
    const cues = [
      cue('c1', 0, 1500),
      cue('c2', 2000, 3200),
      cue('c3', 3600, 5000),
      cue('c4', 5400, 6800),
      cue('c5', 7000, 8200),
    ];
    // Two disjoint selection intervals: {c1, c3}. Move forward 1000ms.
    const result = ripple(cues, 'c1', 1000, ['c1', 'c3']);
    expect(result.appliedDelta).toBe(1000);
    const next = applyAffected(cues, result.affected);
    const map = byId(next);
    expect(map.get('c1')!.start).toBe(1000);
    expect(map.get('c3')!.start).toBe(4600); // +1000, rigid spacing
    expect(map.get('c2')!.start).toBe(2500); // pushed by c1
    expect(map.get('c4')!.start).toBe(6000); // pushed by c3 (touch, gap 0)
    expect(map.get('c5')!.start).toBe(7400); // pushed through contact
    valid(next);
  });

  it('never pulls followers to close trailing gaps', () => {
    // Moving c1 forward alone must not drag c2 backwards.
    const result = ripple(fixture(), 'c1', 500);
    const next = applyAffected(fixture(), result.affected);
    expect(byId(next).get('c2')!.start).toBe(2000);
    valid(next);
  });
});

describe('ripple solver – backward moves', () => {
  it('pulls only through direct contact and never overlaps', () => {
    // c6 wants to move -900, but c5 (in the way) bottoms out on the locked
    // c4.end=6800, so the chain clamps the whole move to -500.
    const result = ripple(fixture(), 'c6', 7600);
    expect(result.requestedDelta).toBe(-900);
    expect(result.appliedDelta).toBe(-500);
    const next = applyAffected(fixture(), result.affected);
    const map = byId(next);
    expect(map.get('c5')!.start).toBe(6800);
    expect(map.get('c6')!.start).toBe(8000);
    expect(map.get('c7')!.start).toBe(10200); // trailing cue untouched
    valid(next);
  });

  it('is clamped by a locked barrier behind the group', () => {
    const result = ripple(fixture(), 'c5', 2000); // requests -5000, lock ends 6800
    expect(result.appliedDelta).toBe(-200);
    const next = applyAffected(fixture(), result.affected);
    expect(byId(next).get('c5')!.start).toBe(6800);
    valid(next);
  });

  it('pushes the predecessor chain on contact and is clamped by the track origin', () => {
    const cues = [cue('a', 500, 2000), cue('b', 2500, 4000)];
    // b wants -1500; a starts at 500 so the packed chain only allows -1000,
    // and a is pushed back to the origin in the process.
    const result = ripple(cues, 'b', 1000);
    expect(result.appliedDelta).toBe(-1000);
    const next = applyAffected(cues, result.affected);
    const map = byId(next);
    expect(map.get('a')!.start).toBe(0);
    expect(map.get('b')!.start).toBe(1500);
    expect(map.get('b')!.start).toBe(map.get('a')!.end);
    valid(next);

    // An open trailing gap is never closed by pull: move a alone, b stays.
    const alone = ripple(cues, 'a', -5000);
    expect(alone.appliedDelta).toBe(-500);
    const onlyA = applyAffected(cues, alone.affected);
    expect(byId(onlyA).get('a')!.start).toBe(0);
    expect(byId(onlyA).get('b')!.start).toBe(2500);
    valid(onlyA);
  });

  it('keeps disjoint selection intervals rigid when moving back', () => {
    // c2 and c6 selected (c4 locked between them).
    const result = ripple(fixture(), 'c2', 1500, ['c2', 'c6']);
    // Segment [c1,c2,c3]: c2 back 500 → c1 already at 0, packed left allows
    // c2 = 1500 exactly; segment [c5,c6,c7]: c6 back 900 → c5 pushed to 6800.
    expect(result.appliedDelta).toBe(-500);
    const next = applyAffected(fixture(), result.affected);
    const map = byId(next);
    expect(map.get('c2')!.start).toBe(1500);
    expect(map.get('c6')!.start).toBe(8000);
    expect(map.get('c5')!.start).toBe(6800);
    expect(map.get('c1')!.start).toBe(0);
    valid(next);
  });
});

describe('ripple solver – minimum duration and locks', () => {
  it('never shortens a cue: durations are preserved through any ripple', () => {
    for (const target of [100, 3000, -2000, 5600, 12000]) {
      const result = ripple(fixture(), 'c3', target);
      const next = applyAffected(fixture(), result.affected);
      for (const cue of next) {
        const original = fixture().find((value) => value.id === cue.id)!;
        expect(cue.end - cue.start).toBe(original.end - original.start);
        expect(cue.end - cue.start).toBeGreaterThanOrEqual(MIN_DURATION);
      }
      valid(next);
    }
  });

  it('clamps a start-edge resize to MIN_DURATION and predecessor tail', () => {
    const cues = fixture();
    // try to start c2 after its own end: capped to end - MIN_DURATION
    let {cues: next, result} = run(cues, {type: 'resize-start', cueId: 'c2', start: 9999});
    const c2 = byId(next).get('c2')!;
    expect(c2.start).toBe(c2.end - MIN_DURATION);
    expect(result.affected).toHaveLength(1);

    // try to start before c1 ends: capped to c1.end (gap 0 allowed)
    ({cues: next} = run(cues, {type: 'resize-start', cueId: 'c2', start: 0}));
    expect(byId(next).get('c2')!.start).toBe(1500);
    valid(next);

    // negative start clamps to the track origin
    ({cues: next} = run(cues, {type: 'resize-start', cueId: 'c1', start: -9000}));
    expect(byId(next).get('c1')!.start).toBe(0);
  });

  it('refuses to move locked anchors', () => {
    const result = solveRipple(fixture(), {
      type: 'ripple', anchorId: 'c4', selectedIds: ['c4'], anchorStart: 8000,
    });
    expect('error' in result && result.error).toBe('anchor_locked');
  });
});

describe('ripple solver – undo is an inverse operation', () => {
  it('inverse intent exactly restores the pre-move layout', () => {
    const original = fixture();
    const moved = ripple(original, 'c1', 1000, ['c1', 'c3', 'c6']);
    const after = applyAffected(original, moved.affected);
    valid(after);

    const undone = ripple(after, 'c1', moved.inverse.type === 'ripple' ? moved.inverse.anchorStart : 0,
      ['c1', 'c3', 'c6']);
    const restored = applyAffected(after, undone.affected);
    for (const cue of restored) {
      const before = original.find((value) => value.id === cue.id)!;
      expect([cue.start, cue.end]).toEqual([before.start, before.end]);
    }
    valid(restored);
  });

  it('inverse re-runs constraints: a lock added meanwhile makes undo best-effort, never a snapshot restore', () => {
    const original = [
      cue('a', 0, 1000),
      cue('b', 1000, 2000),
      cue('c', 2000, 3000),
    ];
    // Drag c forward into open space: no followers, exact +1000.
    const moved = ripple(original, 'c', 3000);
    expect(moved.appliedDelta).toBe(1000);
    const after = applyAffected(original, moved.affected);
    // Another page locks the vacated slot c is asked to return into.
    const barrier = cue('x', 2000, 2500, true);
    const meanwhile = [...after, barrier].sort((p, q) => p.start - q.start);
    expect(trackViolations(meanwhile)).toEqual([]);
    const inverseStart = moved.inverse.type === 'ripple' ? moved.inverse.anchorStart : 0;
    const undo = ripple(meanwhile, 'c', inverseStart);
    const restored = applyAffected(meanwhile, undo.affected);
    valid(restored);
    // c cannot return to 2000: the new lock forces it to stop at 2500.
    expect(byId(restored).get('c')!.start).toBe(2500);
    expect(byId(restored).get('x')!.locked).toBe(true);
  });
});

describe('ripple solver – randomized invariant', () => {
  it('never produces overlaps, sub-min durations or negative starts', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(rand() * 6);
      const cues: Cue[] = [];
      let t = 0;
      for (let i = 0; i < n; i++) {
        const duration = 500 + Math.floor(rand() * 1500);
        t += Math.floor(rand() * 800);
        cues.push(cue('q' + i, t, t + duration, rand() < 0.25 && i > 0 && i < n - 1));
        t += duration;
      }
      const anchor = cues.find((value) => !value.locked)!;
      const selectedIds = cues.filter((value) => !value.locked && rand() < 0.5).map((value) => value.id);
      if (!selectedIds.includes(anchor.id)) selectedIds.push(anchor.id);
      const target = anchor.start + Math.floor(rand() * 12_000) - 6000;
      const result = ripple(cues, anchor.id, target, selectedIds);
      const next = applyAffected(cues, result.affected);
      valid(next);
      const map = byId(next);
      for (const id of selectedIds) {
        // every selected cue moved by exactly the same (clamped) delta
        const delta = map.get(id)!.start - byId(cues).get(id)!.start || 0;
        expect(delta).toBe(result.appliedDelta);
      }
    }
  });
});
