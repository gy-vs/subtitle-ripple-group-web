import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {Cue, CueBase, Intent} from '../src/shared/model';

type TrackJson = Cue & {};
const bases = (cues: Pick<Cue, 'id' | 'start' | 'end' | 'locked'>[]): CueBase[] =>
  cues.map(({id, start, end, locked}) => ({id, start, end, locked}));

const getTrack = async (app: ReturnType<typeof createApp>, id = 'alpha') => {
  const response = await request(app).get('/api/tracks/' + id).expect(200);
  return response.body as {id: string; revision: number; cues: TrackJson[]};
};

const postIntent = (
  app: ReturnType<typeof createApp>,
  track: {id: string; revision: number; cues: CueBase[]},
  intent: Intent,
) =>
  request(app)
    .post(`/api/tracks/${track.id}/intent`)
    .send({revision: track.revision, intent, base: bases(track.cues)});

describe('service – authoritative ripple application', () => {
  it('recomputes on the server, bumps revision and returns only affected cues', async () => {
    const app = createApp();
    const before = await getTrack(app);
    const intent: Intent = {type: 'ripple', anchorId: 'c2', selectedIds: ['c2'], anchorStart: 2500};
    const response = await postIntent(app, before, intent).expect(200);
    expect(response.body.revision).toBe(before.revision + 1);
    expect(response.body.appliedDelta).toBe(500);
    expect(response.body.requestedDelta).toBe(500);
    expect(response.body.rebased).toBe(false);
    const ids = response.body.affected.map((cue: CueBase) => cue.id).sort();
    expect(ids).toEqual(['c2', 'c3']);
    expect(response.body.inverse.type).toBe('ripple');
    expect(response.body.inverse.anchorStart).toBe(2000);
  });

  it('stops propagation at a locked cue and clamps the move', async () => {
    const app = createApp();
    const track = await getTrack(app);
    const intent: Intent = {type: 'ripple', anchorId: 'c3', selectedIds: ['c3'], anchorStart: 9000};
    const response = await postIntent(app, track, intent).expect(200);
    expect(response.body.appliedDelta).toBe(400); // locked c4 (start 5400) blocks further travel
    const after = await getTrack(app);
    const c3 = after.cues.find((cue) => cue.id === 'c3')!;
    const c4 = after.cues.find((cue) => cue.id === 'c4')!;
    expect(c3.end).toBe(c4.start);
    expect(c4.locked).toBe(true);
  });

  it('applies backward moves including follower push-back', async () => {
    const app = createApp();
    const track = await getTrack(app);
    // Wants -900 but c5 (which is in the way) bottoms out on locked c4,
    // so the group is clamped to -500.
    const intent: Intent = {type: 'ripple', anchorId: 'c6', selectedIds: ['c6'], anchorStart: 7600};
    const response = await postIntent(app, track, intent).expect(200);
    expect(response.body.appliedDelta).toBe(-500);
    const map = new Map<string, CueBase>(
      response.body.affected.map((cue: CueBase) => [cue.id, cue]),
    );
    expect(map.get('c5')!.start).toBe(6800);
    expect(map.get('c6')!.start).toBe(8000);
  });

  it('respects minimum duration on start-edge resizes', async () => {
    const app = createApp();
    const track = await getTrack(app);
    const intent: Intent = {type: 'resize-start', cueId: 'c2', start: 99999};
    const response = await postIntent(app, track, intent).expect(200);
    const c2 = response.body.affected[0];
    expect(c2.end - c2.start).toBe(500);
  });

  it('treats undo as the inverse intent re-entered against the new state', async () => {
    const app = createApp();
    const before = await getTrack(app);
    const intent: Intent = {
      type: 'ripple', anchorId: 'c1', selectedIds: ['c1', 'c3', 'c6'], anchorStart: 1000,
    };
    const applied = await postIntent(app, before, intent).expect(200);
    const after = await getTrack(app);
    await postIntent(app, after, applied.body.inverse).expect(200);
    const restored = await getTrack(app);
    for (const cue of restored.cues) {
      const original = before.cues.find((value) => value.id === cue.id)!;
      expect([cue.start, cue.end, cue.locked]).toEqual([original.start, original.end, original.locked]);
    }
  });

  it('toggles locks without moving cues', async () => {
    const app = createApp();
    const track = await getTrack(app);
    const response = await postIntent(app, track, {type: 'lock', cueId: 'c2', locked: true}).expect(200);
    expect(response.body.affected).toEqual([
      expect.objectContaining({id: 'c2', locked: true}),
    ]);
    const after = await getTrack(app);
    const c2 = after.cues.find((cue) => cue.id === 'c2')!;
    expect(c2.start).toBe(2000);
    expect(c2.locked).toBe(true);
  });
});

describe('service – revision-based conflicts', () => {
  it('auto-rebases when another page changed only an unrelated cue', async () => {
    const app = createApp();
    const stale = await getTrack(app); // revision 3

    // Another page moves c7 (the open-end tail beyond the locked bridge).
    const fresh = await getTrack(app);
    await postIntent(app, fresh, {
      type: 'ripple', anchorId: 'c7', selectedIds: ['c7'], anchorStart: 11600,
    }).expect(200);

    // The stale drag around c2/c3 applies cleanly on the new revision.
    const response = await postIntent(app, stale, {
      type: 'ripple', anchorId: 'c2', selectedIds: ['c2'], anchorStart: 2500,
    }).expect(200);
    expect(response.body.rebased).toBe(true);
    expect(response.body.touchedIds).not.toContain('c7');
  });

  it('returns the minimal conflict set when a touched cue changed elsewhere', async () => {
    const app = createApp();
    const stale = await getTrack(app); // revision 3

    // Another page shortens c3's tail (resize keeps its end at 5000): on the
    // base state the c2 drag is clamped to 3700 by c3's tail, but the new
    // state lets c2 reach 2500 — projections diverge.
    const fresh = await getTrack(app);
    await postIntent(app, fresh, {
      type: 'resize-start', cueId: 'c3', start: 4500,
    }).expect(200);

    const conflict = await postIntent(app, stale, {
      type: 'ripple', anchorId: 'c2', selectedIds: ['c2'], anchorStart: 2500,
    }).expect(409);
    expect(conflict.body.error).toBe('revision_conflict');
    const ids = conflict.body.conflicts.map((cue: CueBase) => cue.id);
    expect(ids).toContain('c3');
    // Only c3 diverged; c2 itself and the untouched lock c4 stay out of it.
    expect(ids).not.toContain('c2');
    expect(ids).not.toContain('c4');
    // The server preserves the drag intent verbatim so the client can replay.
    expect(conflict.body.intent.anchorStart).toBe(2500);
  });

  it('allows replaying the preserved intent on top of the new revision', async () => {
    const app = createApp();
    const stale = await getTrack(app);
    const fresh = await getTrack(app);
    // Another page only resizes c3 within the slack, leaving the c2→2500
    // target physically satisfiable.
    await postIntent(app, fresh, {
      type: 'resize-start', cueId: 'c3', start: 3450, // end stays 5000, duration 1550
    }).expect(200);
    const conflict = await postIntent(app, stale, {
      type: 'ripple', anchorId: 'c2', selectedIds: ['c2'], anchorStart: 2500,
    }).expect(409);
    expect(conflict.body.conflicts.map((cue: CueBase) => cue.id)).toEqual(['c3']);
    // Client refreshes and replays the *same* desired target on the new state.
    const current = await getTrack(app);
    const replay = await postIntent(app, current, conflict.body.intent).expect(200);
    expect(replay.body.intent.anchorStart).toBe(2500);
    expect(replay.body.rebased).toBe(false);
    const after = await getTrack(app);
    const sorted = [...after.cues].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
    }
  });

  it('reports a conflict when the anchor became locked in another page', async () => {
    const app = createApp();
    const stale = await getTrack(app);
    const fresh = await getTrack(app);
    await postIntent(app, fresh, {type: 'lock', cueId: 'c2', locked: true}).expect(200);
    const response = await postIntent(app, stale, {
      type: 'ripple', anchorId: 'c2', selectedIds: ['c2'], anchorStart: 2600,
    }).expect(409);
    expect(response.body.reason).toBe('anchor_locked');
    expect(response.body.conflicts.map((cue: CueBase) => cue.id)).toEqual(['c2']);
  });

  it('does not bump revision when constraints clamp the move to zero', async () => {
    const app = createApp();
    const track = await getTrack(app);
    const response = await postIntent(app, track, {
      type: 'ripple', anchorId: 'c3', selectedIds: ['c3'], anchorStart: track.cues.find((c) => c.id === 'c3')!.start,
    }).expect(200);
    expect(response.body.appliedDelta).toBe(0);
    expect(response.body.revision).toBe(track.revision);
  });
});
