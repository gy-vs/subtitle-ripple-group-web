import {useCallback, useEffect, useMemo, useState} from 'react';
import {CloudOff, FlaskConical, Lock, Redo2, Undo2, ShieldCheck} from 'lucide-react';
import {
  Cue,
  Intent,
  Track,
  simulate,
} from '../shared/engine';
import {api, OpResult, TrackSummary} from './api';
import Timeline from './Timeline';

type HistoryEntry = {inverse: Intent; redo: Intent; label: string};
type GestureState = {anchorId: string; selection: string[]; baseCues: Cue[]} | null;

type Status =
  | {kind: 'idle' | 'saving' | 'replaying'; text: string}
  | {kind: 'conflict'; text: string; conflicts: string[]; replay: Intent | null; anchorId: string | null};

export default function App() {
  const [items, setItems] = useState<TrackSummary[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<string>('');
  const [track, setTrack] = useState<Track | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [conflicts, setConflicts] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Status>({kind: 'idle', text: 'Ready'});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [gesture, setGesture] = useState<GestureState>(null);

  useEffect(() => {
    api.listTracks().then((list) => {
      setItems(list);
      if (list[0]) setSelectedTrack(list[0].id);
    });
  }, []);

  useEffect(() => {
    if (!selectedTrack) return;
    setTrack(null);
    setSelected(new Set());
    setConflicts(new Set());
    setHistory([]);
    setRedoStack([]);
    setGesture(null);
    setStatus({kind: 'idle', text: 'Loading…'});
    api.getTrack(selectedTrack).then((value) => {
      setTrack(value);
      setStatus({kind: 'idle', text: `Loaded revision ${value.revision}`});
    });
  }, [selectedTrack]);

  const totalMs = useMemo(
    () => (track ? Math.max(14000, ...track.cues.map((cue) => cue.end + 1500)) : 14000),
    [track],
  );

  const busy = status.kind === 'saving' || status.kind === 'replaying';

  const applyResult = useCallback(
    (
      result: OpResult,
      meta: {label: string; forward?: Intent | null; gestureBase?: Cue[] | null},
    ) => {
      if (result.status === 'ok') {
        const data = result.data;
        setTrack(data.track);
        setConflicts(new Set());
        // A committed inverse clears the just-undone entry; normal commits
        // push their server-computed inverse so undo replays through the
        // constraint engine rather than restoring a whole-track snapshot.
        setHistory((prev) => {
          if (!data.inverse) return prev;
          const entry: HistoryEntry = {
            inverse: data.inverse,
            redo: meta.forward ?? data.inverse,
            label: meta.label,
          };
          return [...prev, entry];
        });
        if (meta.label !== 'undo') setRedoStack([]);
        const clampNote = data.ripple?.clamped
          ? ` · clamped by ${data.ripple.barrier ?? 'boundary'} (want ${data.ripple.anchorRequestedStart}, got ${data.ripple.anchorActualStart})`
          : '';
        const rebaseNote = data.rebased ? ' · rebased over concurrent edit' : '';
        setStatus({kind: 'idle', text: `Saved @ rev ${data.track.revision}${clampNote}${rebaseNote}`});
        return true;
      }
      if (result.status === 'conflict') {
        // Keep the drag intent alive: surface the current server state, but
        // remember what the user was trying to do so it can be replayed.
        const conflictIds = result.data.conflicts ?? result.data.track.cues.map((cue) => cue.id);
        setTrack(result.data.track);
        setConflicts(new Set(conflictIds));
        setStatus({
          kind: 'conflict',
          text:
            result.data.reason === 'unknown_base_revision'
              ? `Conflict @ rev ${result.data.revision}: base revision unknown; re-fetched track`
              : `Conflict @ rev ${result.data.revision}: ${conflictIds.length} cue(s) changed elsewhere`,
          conflicts: conflictIds,
          replay: meta.forward ?? null,
          anchorId:
            meta.forward?.type === 'ripple'
              ? meta.forward.anchorId
              : meta.forward?.type === 'trim' || meta.forward?.type === 'lock'
                ? meta.forward.cueId
                : null,
        });
        return false;
      }
      const message = result.status === 'rejected' ? result.message : `Network error: ${result.message}`;
      // Rejected intent: roll back to the last known server cues.
      if (track && meta.gestureBase) setTrack({...track, cues: meta.gestureBase});
      setStatus({kind: 'idle', text: message});
      return false;
    },
    [track],
  );

  const commit = useCallback(
    async (intent: Intent, label: string, gestureBase?: Cue[] | null) => {
      if (!track) return;
      const baseRevision = track.revision;
      setStatus({kind: 'saving', text: 'Applying operation…'});
      const result = await api.submitOperation(track.id, baseRevision, intent);
      applyResult(result, {label, forward: intent, gestureBase: gestureBase ?? null});
    },
    [track, applyResult],
  );

  /* ---------------- optimistic gesture handling ---------------- */

  const preview = useCallback(
    (mode: 'move' | 'trim-start' | 'trim-end', baseCues: Cue[], anchorId: string, desiredMs: number) => {
      if (!track) return;
      const intent: Intent =
        mode === 'move'
          ? {
              type: 'ripple',
              anchorId,
              selection: [...selected],
              desiredAnchorStart: desiredMs,
            }
          : {type: 'trim', cueId: anchorId, edge: mode === 'trim-start' ? 'start' : 'end', desired: desiredMs};
      const outcome = simulate(baseCues, intent);
      if (!outcome.ok) return;
      if (!gesture || gesture.anchorId !== anchorId) {
        setGesture({anchorId, selection: [...selected], baseCues});
      }
      setTrack((current) => (current ? {...current, cues: outcome.cues} : current));
      setStatus({
        kind: 'idle',
        text: outcome.ripple
          ? outcome.ripple.clamped
            ? `Local prediction: clamped against ${outcome.ripple.barrier ?? 'boundary'}`
            : `Local prediction: Δ${outcome.ripple.appliedDelta} ms`
          : 'Local prediction',
      });
    },
    [track, selected, gesture],
  );

  const commitGesture = useCallback(
    (mode: 'move' | 'trim-start' | 'trim-end', anchorId: string, desiredMs: number, baseCues: Cue[]) => {
      const intent: Intent =
        mode === 'move'
          ? {type: 'ripple', anchorId, selection: [...selected], desiredAnchorStart: desiredMs}
          : {type: 'trim', cueId: anchorId, edge: mode === 'trim-start' ? 'start' : 'end', desired: desiredMs};
      setGesture(null);
      void commit(intent, mode === 'move' ? 'ripple drag' : 'trim', baseCues);
    },
    [selected, commit],
  );

  /* ---------------- conflict replay ---------------- */

  const replayConflict = useCallback(async () => {
    if (status.kind !== 'conflict' || !status.replay || !track) return;
    const intent = status.replay;
    setStatus({kind: 'replaying', text: 'Replaying intent on new revision…'});
    const result = await api.submitOperation(track.id, track.revision, intent);
    applyResult(result, {label: 'replay', forward: intent});
  }, [status, track, applyResult]);

  /* ---------------- undo / redo as inverse operations ---------------- */

  const runHistory = useCallback(
    async (entry: HistoryEntry, direction: 'undo' | 'redo') => {
      if (!track) return;
      const intent = direction === 'undo' ? entry.inverse : entry.redo;
      const label = direction;
      setStatus({kind: 'saving', text: direction === 'undo' ? 'Undoing (re-constrained)…' : 'Redoing…'});
      const result = await api.submitOperation(track.id, track.revision, intent);
      if (result.status === 'ok') {
        setTrack(result.data.track);
        setConflicts(new Set());
        if (direction === 'undo') {
          setHistory((prev) => prev.slice(0, -1));
          setRedoStack((prev) => [...prev, {...entry, inverse: result.data.inverse ?? entry.inverse}]);
        } else {
          setRedoStack((prev) => prev.slice(0, -1));
          setHistory((prev) => [
            ...prev,
            {...entry, inverse: result.data.inverse ?? entry.inverse},
          ]);
        }
        setStatus({kind: 'idle', text: `${direction === 'undo' ? 'Undid' : 'Redid'}: ${entry.label} @ rev ${result.data.track.revision}`});
        return;
      }
      applyResult(result, {label, forward: intent});
    },
    [track, applyResult],
  );

  const undo = () => {
    const entry = history[history.length - 1];
    if (entry) void runHistory(entry, 'undo');
  };
  const redo = () => {
    const entry = redoStack[redoStack.length - 1];
    if (entry) void runHistory(entry, 'redo');
  };

  /* ---------------- lock + dev aid ---------------- */

  const toggleLock = (id: string) => {
    const cue = track?.cues.find((value) => value.id === id);
    if (!cue) return;
    void commit({type: 'lock', cueId: id, locked: !cue.locked}, cue.locked ? 'unlock' : 'lock');
  };

  const simulateOtherPage = async () => {
    if (!track) return;
    // Touch an unlocked cue that is NOT part of the current selection: depending
    // on whether it lies in the next operation's closure, the server will
    // either rebased-commit or return the minimal conflict set.
    const candidate = track.cues.find((cue) => !cue.locked && !selected.has(cue.id));
    setStatus({kind: 'saving', text: 'Another page is editing…'});
    const next = await api.externalTouch(track.id, 150, candidate?.id);
    setTrack(next);
    setStatus({kind: 'idle', text: `External edit committed @ rev ${next.revision} (${candidate?.id ?? 'n/a'})`});
  };

  const toggleSelect = (id: string, additive: boolean) => {
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedCueList = track
    ? [...selected]
        .map((id) => track.cues.find((cue) => cue.id === id))
        .filter((cue): cue is Cue => Boolean(cue))
        .sort((a, b) => a.start - b.start)
    : [];

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Subtitle Timing Studio</strong>
        <small>Ripple move · locked barriers · revision-aware sync</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Tracks</h2>
          <div className="list">
            {items.map((item) => (
              <button
                key={item.id}
                className={item.id === selectedTrack ? 'active' : ''}
                onClick={() => setSelectedTrack(item.id)}
              >
                {item.name}
                <br />
                <small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane timeline-pane">
          <div className="toolbar">
            <button onClick={undo} disabled={!history.length || busy || !track}>
              <Undo2 size={15} /> Undo
            </button>
            <button onClick={redo} disabled={!redoStack.length || busy || !track}>
              <Redo2 size={15} /> Redo
            </button>
            <button className="dev" onClick={simulateOtherPage} disabled={busy || !track} title="Simulate a concurrent edit from another page">
              <CloudOff size={15} /> Simulate other page edit
            </button>
            <span className={`status status-${status.kind}`}>{status.text}</span>
          </div>

          {status.kind === 'conflict' && (
            <div className="conflict-banner">
              <ShieldCheck size={16} />
              <span>
                Minimal conflict set: <strong>{status.conflicts.join(', ') || 'unknown'}</strong>.
                Your drag intent was preserved, not overwritten.
              </span>
              <button className="primary small" onClick={replayConflict} disabled={busy}>
                Replay on rev {track?.revision}
              </button>
              <button
                className="small"
                onClick={() => {
                  setConflicts(new Set());
                  setStatus({kind: 'idle', text: 'Discarded pending intent'});
                }}
                disabled={busy}
              >
                Discard
              </button>
            </div>
          )}

          {track ? (
            <Timeline
              cues={track.cues}
              selected={selected}
              conflicts={conflicts}
              totalMs={totalMs}
              disabled={busy}
              onToggleSelect={toggleSelect}
              onClearSelection={() => setSelected(new Set())}
              onPreview={preview}
              onCommitGesture={commitGesture}
              onToggleLock={toggleLock}
            />
          ) : (
            <p>Loading track…</p>
          )}

          <p className="hint">
            Click to select a cue, Shift-click for multiple (disjoint) intervals. Drag a cue body to
            ripple-move the selection: gaps are preserved and unlocked cues ahead/behind are pushed
            until a locked cue or the track start stops propagation. Drag the side handles to trim
            (minimum duration 500 ms, no overlap).
          </p>
        </section>

        <aside className="pane inspector">
          <h2>Inspector</h2>
          {track && (
            <>
              <span className="pill">rev {track.revision}</span>
              <h3>Selection ({selectedCueList.length})</h3>
              <ul className="cue-inspect">
                {selectedCueList.map((cue) => (
                  <li key={cue.id} className={cue.locked ? 'is-locked' : ''}>
                    <code>{cue.id}</code> {cue.locked ? <Lock size={11} /> : null}
                    <br />
                    <small>
                      {cue.start}–{cue.end} ms (dur {cue.end - cue.start})
                    </small>
                  </li>
                ))}
              </ul>
              <h3>Cues</h3>
              <ul className="cue-inspect">
                {[...track.cues]
                  .sort((a, b) => a.start - b.start)
                  .map((cue) => (
                    <li
                      key={cue.id}
                      className={[
                        conflicts.has(cue.id) ? 'is-conflict' : '',
                        cue.locked ? 'is-locked' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <code>{cue.id}</code> {cue.locked ? <Lock size={11} /> : null}
                      <br />
                      <small>
                        {cue.start}–{cue.end} ms · {cue.text}
                      </small>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </aside>
      </section>
    </main>
  );
}
