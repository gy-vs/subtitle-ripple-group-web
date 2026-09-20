import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  Cue,
  CueBase,
  Intent,
  Track,
} from '../shared/model';
import {solve, applyAffected, trackViolations} from '../shared/ripple';

// In-memory store. Revision is bumped only when at least one cue changes.
type StoredTrack = Track;

let clock = 1_700_000_000_000;
const now = () => new Date(clock += 1).toISOString();

function makeCue(
  id: string,
  start: number,
  end: number,
  text: string,
  locked = false,
): Cue {
  return {id, start, end, text, locked};
}

function seedTracks(): Map<string, StoredTrack> {
  const tracks = new Map<string, StoredTrack>();
  tracks.set('alpha', {
    id: 'alpha',
    name: 'Primary timed cues',
    revision: 3,
    updatedAt: new Date(0).toISOString(),
    cues: [
      makeCue('c1', 0, 1500, 'Opening line'),
      makeCue('c2', 2000, 3200, 'Second line'),
      makeCue('c3', 3600, 5000, 'Third line'),
      makeCue('c4', 5400, 6800, 'Locked bridge', true),
      makeCue('c5', 7000, 8200, 'After the lock'),
      makeCue('c6', 8500, 9800, 'Trailing cue'),
      makeCue('c7', 10200, 11500, 'Last word'),
    ],
  });
  tracks.set('beta', {
    id: 'beta',
    name: 'Secondary timed cues',
    revision: 5,
    updatedAt: new Date(1000).toISOString(),
    cues: [
      makeCue('b1', 0, 1000, 'Beta start'),
      makeCue('b2', 1200, 2500, 'Beta middle'),
      makeCue('b3', 2800, 4000, 'Beta end'),
    ],
  });
  return tracks;
}

const rows = seedTracks();

function summary(track: StoredTrack) {
  return {id: track.id, name: track.name, revision: track.revision, updatedAt: track.updatedAt};
}

// Minimal conflict set: re-run the intent against both the state the client
// knew and the current state. A cue conflicts only when its *result* differs
// (or it vanished / appeared inside the chain), so unrelated edits elsewhere
// auto-rebase instead of bothering the user.
function findConflicts(
  track: StoredTrack,
  bases: Map<string, CueBase>,
  intent: Intent,
  currentOutcome: ReturnType<typeof solve>,
): CueBase[] {
  if ('error' in currentOutcome) {
    return currentOutcome.touchedIds.flatMap((id) => {
      const current = track.cues.find((cue) => cue.id === id);
      const base = bases.get(id);
      if (current) {
        if (!base || base.start !== current.start || base.end !== current.end || base.locked !== current.locked) {
          return [{id: current.id, start: current.start, end: current.end, locked: current.locked}];
        }
        return [];
      }
      return base ? [base] : [];
    });
  }

  // Reconstruct the client's base cue list from the base fingerprint it sent.
  const baseCues: Cue[] = [...bases.values()].map((base) => {
    const current = track.cues.find((cue) => cue.id === base.id);
    return {
      id: base.id,
      start: base.start,
      end: base.end,
      locked: base.locked,
      text: current?.text ?? '',
    };
  });
  const baseline = solve(baseCues, intent);

  const baselineById = new Map<string, CueBase>();
  if (!('error' in baseline)) {
    const projected = applyAffected(baseCues, baseline.affected);
    for (const cue of projected) {
      baselineById.set(cue.id, {id: cue.id, start: cue.start, end: cue.end, locked: cue.locked});
    }
  }

  const projectedCurrent = applyAffected(track.cues, currentOutcome.affected);
  const conflicts: CueBase[] = [];
  for (const cue of projectedCurrent) {
    const expected = baselineById.get(cue.id);
    // inserted elsewhere inside the moved chain, or result diverged
    if (!expected || expected.start !== cue.start || expected.end !== cue.end || expected.locked !== cue.locked) {
      if (currentOutcome.touchedIds.includes(cue.id)) {
        conflicts.push({id: cue.id, start: cue.start, end: cue.end, locked: cue.locked});
      }
    }
  }
  // Touched cues that existed in the base view but are gone now.
  for (const id of currentOutcome.touchedIds) {
    if (!track.cues.some((cue) => cue.id === id)) {
      const base = bases.get(id);
      if (base) conflicts.push(base);
    }
  }
  return conflicts;
}

export function createApp(store: Map<string, StoredTrack> = seedTracks()) {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'subtitle-timing', count: store.size}),
  );

  app.get('/api/tracks', (_req, res) =>
    res.json([...store.values()].map(summary)),
  );

  app.get('/api/tracks/:id', (req, res) => {
    const track = store.get(req.params.id);
    if (!track) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(track.revision)).json(track);
  });

  // Authoritative ripple / resize / lock application.
  //
  // body: { revision, intent, base: [{id,start,end,locked}, ...] }
  //  - 200 { revision, intent, affected, touchedIds, appliedDelta,
  //          requestedDelta, inverse, rebased }
  //  - 409 { error:'revision_conflict', revision, conflicts: CueBase[],
  //          intent }  -> minimal conflict set, client replays its drag intent
  app.post('/api/tracks/:id/intent', (req, res) => {
    const track = store.get(req.params.id);
    if (!track) return res.status(404).json({error: 'not_found'});

    const intent: Intent | undefined = req.body?.intent;
    const baseRevision: unknown = req.body?.revision;
    const rawBase: unknown = req.body?.base;
    if (!intent || typeof intent.type !== 'string' || typeof baseRevision !== 'number') {
      return res.status(400).json({error: 'bad_request'});
    }
    if (!Array.isArray(rawBase)) return res.status(400).json({error: 'bad_request'});
    const bases = new Map<CueBase['id'], CueBase>(
      (rawBase as CueBase[]).map((cue) => [cue.id, cue]),
    );

    if (trackViolations(track.cues).length > 0) {
      return res.status(422).json({error: 'corrupt_track', violations: trackViolations(track.cues)});
    }

    const stale = baseRevision !== track.revision;
    const outcome = solve(track.cues, intent as Intent);

    if ('error' in outcome) {
      // Anchor vanished (deleted elsewhere) / is now locked (flipped
      // elsewhere): report the smallest set describing why replay failed.
      const conflicts = findConflicts(track, bases, intent as Intent, outcome);
      return res.status(409).json({
        error: 'revision_conflict',
        reason: outcome.error,
        revision: track.revision,
        conflicts,
        intent,
      });
    }

    const conflicts = stale ? findConflicts(track, bases, intent as Intent, outcome) : [];
    if (stale && conflicts.length > 0) {
      return res.status(409).json({
        error: 'revision_conflict',
        revision: track.revision,
        conflicts,
        intent,
      });
    }

    // No relevant conflict: either fresh, or stale but the intent applied
    // cleanly on the new state (e.g. an unrelated cue changed in another page).
    if (outcome.affected.length > 0) {
      track.cues = applyAffected(track.cues, outcome.affected);
      track.revision += 1;
      track.updatedAt = now();
    }

    return res.json({
      ...summary(track),
      intent,
      affected: outcome.affected,
      touchedIds: outcome.touchedIds,
      appliedDelta: outcome.appliedDelta,
      requestedDelta: outcome.requestedDelta,
      inverse: outcome.inverse,
      rebased: stale,
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
