import {beforeEach, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const A1 = 'alpha-1';
const A2 = 'alpha-2';
const A3 = 'alpha-3'; // locked
const A4 = 'alpha-4';
const A5 = 'alpha-5';
const A6 = 'alpha-6'; // locked
const A7 = 'alpha-7';

describe('track protocol', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp();
  });

  async function load() {
    const res = await request(app).get('/api/tracks/alpha').expect(200);
    return res.body as {
      id: string;
      revision: number;
      cues: Array<{id: string; start: number; end: number; locked: boolean}>;
    };
  }

  const ripple = (
    revision: number,
    anchorId: string,
    selection: string[],
    desiredAnchorStart: number,
  ) =>
    request(app)
      .post('/api/tracks/alpha/operations')
      .send({revision, intent: {type: 'ripple', anchorId, selection, desiredAnchorStart}});

  const cueMap = (body: any) =>
    new Map<string, any>(body.track.cues.map((c: any) => [c.id, c]));

  it('loads seeded tracks that satisfy all constraints', async () => {
    const track = await load();
    expect(track.revision).toBe(1);
    expect(track.cues.find((c) => c.id === A3)?.locked).toBe(true);
    const health = await request(app).get('/api/health').expect(200);
    expect(health.body.ok).toBe(true);
  });

  it('commits a forward ripple, pushes unlocked cues and returns the inverse', async () => {
    const before = await load();
    const res = await ripple(before.revision, A1, [A1], 400).expect(200);
    expect(res.body.rebased).toBe(false);
    const byId = cueMap(res.body);
    expect([byId.get(A1).start, byId.get(A1).end]).toEqual([400, 1600]);
    expect([byId.get(A2).start, byId.get(A2).end]).toEqual([1800, 3400]);
    expect([byId.get(A3).start, byId.get(A3).end]).toEqual([3500, 5000]);
    expect(res.body.inverse.type).toBe('ripple');
    expect(res.body.inverse.selection).toEqual(expect.arrayContaining([A1, A2]));
    expect(res.body.track.revision).toBe(2);
  });

  it('server recomputes and clamps when forward propagation reaches a locked cue', async () => {
    const before = await load();
    const res = await ripple(before.revision, A1, [A1], 99999).expect(200);
    expect(res.body.ripple.clamped).toBe(true);
    expect(res.body.ripple.barrier).toBe(A3);
    const byId = cueMap(res.body);
    // gap between A1/A2 preserved (200ms); A2 ends exactly on the locked A3
    expect([byId.get(A1).start, byId.get(A2).end]).toEqual([500, 3500]);
    expect(byId.get(A3).start).toBe(3500);
  });

  it('handles backward ripples against the track start and against a locked predecessor', async () => {
    const before = await load();
    // A1 currently starts at 100: the run can only move to 0
    const toStart = await ripple(before.revision, A2, [A2], 0).expect(200);
    expect(toStart.body.ripple.appliedDelta).toBe(-100);
    expect(toStart.body.ripple.barrier).toBe('TRACK_START');
    let byId = cueMap(toStart.body);
    expect([byId.get(A1).start, byId.get(A1).end]).toEqual([0, 1200]);
    expect([byId.get(A2).start, byId.get(A2).end]).toEqual([1400, 3000]);

    // pulling A4 left: the run is bounded by locked A3 ending at 5000
    const toLock = await ripple(toStart.body.track.revision, A4, [A4], 0).expect(200);
    expect(toLock.body.ripple.appliedDelta).toBe(-200);
    expect(toLock.body.ripple.barrier).toBe(A3);
    byId = cueMap(toLock.body);
    expect([byId.get(A4).start, byId.get(A4).end]).toEqual([5000, 7000]);
    // A5 is a successor: backward drags never pull right-side cues
    expect([byId.get(A5).start, byId.get(A5).end]).toEqual([7400, 9200]);
    expect([byId.get(A3).start, byId.get(A3).end]).toEqual([3500, 5000]);
  });

  it('propagates a multi-interval selection with the tightest bound', async () => {
    const before = await load();
    const res = await ripple(
      before.revision,
      A1,
      [A1, A4, A5],
      before.cues[0].start + 1000,
    ).expect(200);
    // block 1 has 400ms room, block 2 only 300ms before locked A6
    expect(res.body.ripple.appliedDelta).toBe(300);
    const byId = cueMap(res.body);
    expect(byId.get(A1).start).toBe(400);
    expect(byId.get(A2).end).toBe(3400);
    expect(byId.get(A4).start).toBe(5500);
    expect(byId.get(A5).end).toBe(9500);
    expect(byId.get(A7).start).toBe(11200); // behind locked A6, never pushed
  });

  it('enforces minimum duration on trim', async () => {
    const before = await load();
    const res = await request(app)
      .post('/api/tracks/alpha/operations')
      .send({revision: before.revision, intent: {type: 'trim', cueId: A1, edge: 'start', desired: 1000}})
      .expect(200);
    const cue = res.body.track.cues.find((c: any) => c.id === A1);
    expect(cue.end - cue.start).toBe(500);
    expect(cue.start).toBe(800);
  });

  it('rejects a stale revision with the minimal conflict set and preserves the intent', async () => {
    const before = await load();
    // another page moves A2 (inside the next operation's closure)
    await request(app)
      .post('/api/tracks/alpha/debug/external-touch')
      .send({cueId: A2, offset: 100})
      .expect(200);

    // stale client attempts to drag A1
    const conflict = await ripple(before.revision, A1, [A1], 400).expect(409);
    expect(conflict.body.reason).toBe('conflicting_cues');
    expect(conflict.body.conflicts).toEqual([A2]); // minimal set, not the whole track
    expect(conflict.body.track.revision).toBe(2);
    expect(conflict.body.outcome ?? null).toBeNull(); // nothing committed

    // replay the same drag intent against the new revision: A2 has shifted,
    // recompute against fresh state instead of overwriting it
    const replay = await ripple(conflict.body.track.revision, A1, [A1], 300).expect(200);
    expect(replay.body.track.revision).toBe(3);
    const byId = cueMap(replay.body);
    expect(byId.get(A1).start).toBe(300);
    expect(byId.get(A3).start).toBe(3500); // locked anchor of the external edit preserved
  });

  it('automatically rebases when the concurrent edit is outside the closure', async () => {
    const before = await load();
    // A7 lives behind locked A6, far from an A1 drag whose closure is A1,A2,A3
    await request(app)
      .post('/api/tracks/alpha/debug/external-touch')
      .send({cueId: A7, offset: 200})
      .expect(200);
    const res = await ripple(before.revision, A1, [A1], 400).expect(200);
    expect(res.body.rebased).toBe(true);
    expect(res.body.track.revision).toBe(3);
    const byId = cueMap(res.body);
    expect(byId.get(A1).start).toBe(400);
    expect(byId.get(A7).start).toBe(11400);
  });

  it('undo is an inverse operation re-run through constraints, not a snapshot restore', async () => {
    const before = await load();
    const done = await ripple(before.revision, A1, [A1], 400).expect(200);
    const inverse = done.body.inverse;
    expect(inverse.desiredAnchorStart).toBe(100);
    // meanwhile another page nudges A7 (outside the undo closure): undo must
    // still apply, rebased, and A7's change must survive
    await request(app)
      .post('/api/tracks/alpha/debug/external-touch')
      .send({cueId: A7, offset: 100})
      .expect(200);
    const undone = await request(app)
      .post('/api/tracks/alpha/operations')
      .send({revision: done.body.track.revision, intent: inverse})
      .expect(200);
    // client is stale after the external touch: server diffs the undo closure,
    // finds it untouched, and rebases automatically
    expect(undone.body.rebased).toBe(true);
    const byId = cueMap(undone.body);
    expect([byId.get(A1).start, byId.get(A1).end]).toEqual([100, 1300]);
    expect([byId.get(A2).start, byId.get(A2).end]).toEqual([1500, 3100]);
    expect(byId.get(A7).start).toBe(11300);
  });

  it('a fully clamped drag commits no change and does not bump the revision', async () => {
    const before = await load();
    // first push A4 left until it touches locked A3 (gap is 200ms)
    const touching = await ripple(before.revision, A4, [A4], 0).expect(200);
    const revAfter = touching.body.track.revision;
    // now A4 has a locked predecessor in direct contact: the drag cannot move at all
    const res = await ripple(revAfter, A4, [A4], -99999).expect(200);
    expect(res.body.ripple?.appliedDelta).toBe(0);
    expect(res.body.changed).toEqual([]);
    expect(res.body.inverse).toBeNull();
    expect(res.body.track.revision).toBe(revAfter);
  });

  it('rejects invalid intents and unknown revisions', async () => {
    const before = await load();
    await request(app)
      .post('/api/tracks/alpha/operations')
      .send({revision: before.revision, intent: {type: 'ripple', anchorId: A3, selection: [A3], desiredAnchorStart: 0}})
      .expect(422); // locked anchor
    const old = await request(app)
      .post('/api/tracks/alpha/operations')
      .send({revision: 999, intent: {type: 'lock', cueId: A1, locked: true}})
      .expect(409);
    expect(old.body.reason).toBe('unknown_base_revision');
    expect(old.body.conflicts).toBeNull();
    await request(app)
      .post('/api/tracks/alpha/operations')
      .send({revision: 'nope'})
      .expect(400);
  });
});
