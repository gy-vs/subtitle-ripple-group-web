import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  Cue,
  Intent,
  Track,
  diffCues,
  simulate,
  validateCues,
} from '../shared/engine.js';

/* ------------------------------------------------------------------ */
/* in-memory store with per-revision snapshots                         */
/* ------------------------------------------------------------------ */

type StoredTrack = Track & {snapshots: Map<number, Cue[]>};

function seedTrack(id: string, name: string, revision: number, cues: Array<[number, number, boolean, string]>): StoredTrack {
  return {
    id,
    name,
    revision,
    updatedAt: new Date(0).toISOString(),
    cues: cues.map(([start, end, locked, text], i) => ({
      id: `${id}-${i + 1}`,
      start,
      end,
      locked,
      text,
    })),
    snapshots: new Map(),
  };
}

function store(): Map<string, StoredTrack> {
  const tracks = new Map<string, StoredTrack>();
  const alpha = seedTrack('alpha', 'Primary timed cues', 1, [
    [100, 1300, false, 'Opening shot'],
    [1500, 3100, false, 'First line'],
    [3500, 5000, true, 'Locked title card'],
    [5200, 7200, false, 'Second act'],
    [7400, 9200, false, 'Third act'],
    [9500, 11000, true, 'Locked sign-off'],
    [11200, 12700, false, 'Credits'],
  ]);
  const beta = seedTrack('beta', 'Secondary timed cues', 1, [
    [0, 1000, false, 'Beta intro'],
    [1000, 2600, false, 'Beta body'],
    [3000, 4200, false, 'Beta outro'],
  ]);
  for (const track of [alpha, beta]) track.snapshots.set(track.revision, cloneCues(track.cues));
  tracks.set(alpha.id, alpha);
  tracks.set(beta.id, beta);
  return tracks;
}

function cloneCues(cues: Cue[]): Cue[] {
  return cues.map((cue) => ({...cue}));
}

function publicTrack(track: StoredTrack): Track {
  return {
    id: track.id,
    name: track.name,
    revision: track.revision,
    cues: cloneCues(track.cues),
    updatedAt: track.updatedAt,
  };
}

const SNAPSHOT_HISTORY = 20;

/** Keep the most recent revisions so stale clients can still be diffed. */
function bumpRevision(track: StoredTrack, cues: Cue[]): void {
  track.cues = cues;
  track.revision += 1;
  track.updatedAt = new Date().toISOString();
  track.snapshots.set(track.revision, cloneCues(cues));
  const keys = [...track.snapshots.keys()].sort((a, b) => a - b);
  for (const key of keys.slice(0, Math.max(0, keys.length - SNAPSHOT_HISTORY))) {
    track.snapshots.delete(key);
  }
}

/* ------------------------------------------------------------------ */

export function createApp() {
  const tracks = store();
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) =>
    res.json({family: 'subtitle-timing', count: tracks.size}),
  );

  app.get('/api/tracks', (_req, res) => {
    res.json(
      [...tracks.values()].map((track) => ({
        id: track.id,
        name: track.name,
        revision: track.revision,
        updatedAt: track.updatedAt,
      })),
    );
  });

  app.get('/api/tracks/:id', (req, res) => {
    const track = tracks.get(req.params.id);
    if (!track) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(track.revision)).json(publicTrack(track));
  });

  /**
   * Submit an intent against the track state the client last observed.
   *
   *  - revision stale AND a cue in the operation's closure changed  -> 409 with
   *    the minimal conflict set; nothing is committed
   *  - revision stale but closure untouched                         -> the
   *    server rebases the intent onto current state and commits it
   *  - revision current                                             -> commits
   *
   * Undo goes through the same endpoint: the body carries the inverse intent
   * and is recomputed against current constraints, never a saved snapshot.
   */
  app.post('/api/tracks/:id/operations', (req, res) => {
    const track = tracks.get(req.params.id);
    if (!track) return res.status(404).json({error: 'not_found'});

    const baseRevision = Number(req.body?.revision);
    const intent = req.body?.intent as Intent | undefined;
    if (!Number.isInteger(baseRevision) || !intent || typeof intent.type !== 'string') {
      return res.status(400).json({error: 'bad_request', message: 'revision and intent are required'});
    }

    // Dry run on the current server state: the intent is always recomputed
    // here, never applied from client-computed coordinates.
    const trial = simulate(track.cues, intent);
    if (!trial.ok) {
      return res.status(422).json({
        error: 'intent_rejected',
        message: trial.error,
        revision: track.revision,
        track: publicTrack(track),
      });
    }

    const baseCues =
      baseRevision === track.revision ? cloneCues(track.cues) : track.snapshots.get(baseRevision);
    if (!baseCues) {
      // We no longer know the client's base state: cannot prove a minimal
      // conflict set, so hand back the current state for a full rebase.
      return res.status(409).json({
        error: 'revision_conflict',
        reason: 'unknown_base_revision',
        revision: track.revision,
        track: publicTrack(track),
        conflicts: null,
        outcome: null,
      });
    }

    const conflicts =
      baseRevision === track.revision ? [] : diffCues(baseCues, track.cues, trial.affected);

    if (conflicts.length > 0) {
      return res.status(409).json({
        error: 'revision_conflict',
        reason: 'conflicting_cues',
        revision: track.revision,
        track: publicTrack(track),
        conflicts, // minimal set: closure ∩ changed cues
        outcome: null,
      });
    }

    // Either the client was current, or the concurrent edit stayed outside the
    // operation's closure. Commit the rebased result. A fully clamped no-op
    // (e.g. blocked by a locked cue) commits nothing and does not bump the
    // revision.
    const wasCurrent = baseRevision === track.revision;
    if (trial.changed.length === 0) {
      return res.json({
        track: publicTrack(track),
        changed: [],
        affected: trial.affected,
        inverse: null,
        ripple: trial.ripple,
        rebased: false,
      });
    }
    bumpRevision(track, trial.cues);

    return res.json({
      track: publicTrack(track),
      changed: trial.changed,
      affected: trial.affected,
      inverse: trial.inverse,
      ripple: trial.ripple,
      rebased: !wasCurrent,
    });
  });

  /**
   * Dev/test aid: simulate another page moving one unlocked cue by `offset`
   * milliseconds (clamped locally so it cannot cross locked cues), bumping the
   * revision so the next client operation collides.
   */
  app.post('/api/tracks/:id/debug/external-touch', (req, res) => {
    const track = tracks.get(req.params.id);
    if (!track) return res.status(404).json({error: 'not_found'});
    const offset = Math.round(Number(req.body?.offset ?? 100));
    const cueId = String(req.body?.cueId ?? track.cues.find((cue) => !cue.locked)?.id ?? '');
    const cue = track.cues.find((value) => value.id === cueId);
    if (!cue) return res.status(404).json({error: 'cue_not_found'});
    if (cue.locked) return res.status(422).json({error: 'cue_locked'});

    const outcome = simulate(track.cues, {
      type: 'ripple',
      anchorId: cue.id,
      selection: [cue.id],
      desiredAnchorStart: cue.start + offset,
    });
    if (!outcome.ok) return res.status(422).json({error: 'external_touch_rejected', message: outcome.error});

    bumpRevision(track, outcome.cues);
    res.json({track: publicTrack(track), changed: outcome.changed, ripple: outcome.ripple});
  });

  app.get('/api/health', (_req, res) => {
    for (const track of tracks.values()) {
      const errors = validateCues(track.cues);
      if (errors.length) return res.status(500).json({ok: false, errors});
    }
    res.json({ok: true});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
