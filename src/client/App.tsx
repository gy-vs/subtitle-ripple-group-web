import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FlaskConical, Lock, Undo2, AlertTriangle} from 'lucide-react';
import {
  AppliedCue,
  Cue,
  CueBase,
  Intent,
  RippleIntent,
  Track,
} from '../shared/model';
import {solve, applyAffected} from '../shared/ripple';

type TrackSummary = {id: string; name: string; revision: number; updatedAt: string};

type IntentResponse = {
  id: string;
  revision: number;
  updatedAt: string;
  affected: AppliedCue[];
  touchedIds: string[];
  appliedDelta: number;
  requestedDelta: number;
  inverse: Intent;
  rebased: boolean;
};

type ConflictResponse = {
  error: 'revision_conflict';
  reason?: string;
  revision: number;
  conflicts: CueBase[];
  intent: Intent;
};

type HistoryEntry = {label: string; inverse: Intent};

type DragState =
  | {
      kind: 'ripple';
      anchorId: string;
      selectedIds: string[];
      startX: number;
      pointerId: number;
      // cues at drag begin (optimistic prediction layers over these)
      originCues: Cue[];
      baseRevision: number;
      base: CueBase[];
      predicted: Cue[];
      appliedDelta: number;
    }
  | {
      kind: 'resize';
      cueId: string;
      startX: number;
      pointerId: number;
      originCues: Cue[];
      baseRevision: number;
      base: CueBase[];
      predicted: Cue[];
    };

const PX_PER_SECOND = 34;
const TIMELINE_PADDING_MS = 1500;

const toBase = (cues: Cue[]): CueBase[] =>
  cues.map(({id, start, end, locked}) => ({id, start, end, locked}));

const formatTime = (ms: number) => {
  const seconds = ms / 1000;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

export default function App() {
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState('alpha');
  const [track, setTrack] = useState<Track | null>(null);
  const [selectedCueIds, setSelectedCueIds] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [notice, setNotice] = useState<{kind: 'info' | 'conflict'; text: string}>({
    kind: 'info',
    text: 'Ready',
  });
  const [pending, setPending] = useState(false);
  const [pendingConflict, setPendingConflict] = useState<null | {
    conflicts: CueBase[];
    intent: Intent;
    reason?: string;
  }>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch('/api/tracks')
      .then((response) => response.json())
      .then((value: TrackSummary[]) => setTracks(value));
  }, []);

  const loadTrack = useCallback((id: string) => {
    setSelectedTrackId(id);
    setSelectedCueIds(new Set());
    setHistory([]);
    setPendingConflict(null);
    setDrag(null);
    setNotice({kind: 'info', text: 'Loading…'});
    fetch('/api/tracks/' + id)
      .then((response) => response.json())
      .then((value: Track) => {
        setTrack(value);
        setNotice({kind: 'info', text: `Loaded revision ${value.revision}`});
      });
  }, []);

  useEffect(() => {
    loadTrack(selectedTrackId);
  }, [loadTrack, selectedTrackId]);

  // Cues currently on screen: predicted drag overlays the committed track.
  const visibleCues = useMemo<Cue[]>(() => {
    if (!track) return [];
    return drag ? drag.predicted : track.cues;
  }, [drag, track]);

  const domain = useMemo(() => {
    const lastEnd = visibleCues.reduce((max, cue) => Math.max(max, cue.end), 0);
    return Math.max(10_000, lastEnd + TIMELINE_PADDING_MS);
  }, [visibleCues]);

  const xFor = (ms: number) => (ms / 1000) * PX_PER_SECOND;
  const widthFor = (durationMs: number) => xFor(durationMs);
  const msForX = (x: number) => Math.round((x / PX_PER_SECOND) * 1000);

  // -------------------------------------------------------------------------
  // Server commit with optimistic prediction / minimal-conflict replay.
  // -------------------------------------------------------------------------
  const commit = useCallback(
    async (
      intent: Intent,
      base: CueBase[],
      baseRevision: number,
      optimistic: AppliedCue[],
      historyLabel: string | null,
      isReplay = false,
    ) => {
      if (!track) return;
      setPending(true);
      setNotice({kind: 'info', text: isReplay ? 'Replaying on new revision…' : 'Applying…'});

      // Local prediction: paint the move immediately, before the round trip.
      const snapshot = track;
      setTrack((current) =>
        current ? {...current, cues: applyAffected(current.cues, optimistic)} : current,
      );

      try {
        const response = await fetch(`/api/tracks/${track.id}/intent`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({revision: baseRevision, intent, base}),
        });
        if (response.ok) {
          const value = (await response.json()) as IntentResponse;
          // Server is authoritative: re-fetch semantics via its recomputed
          // cues and revision (replaces the optimistic layer).
          setTrack((current) => {
            if (!current || current.id !== track.id) return current;
            return {
              ...current,
              // Apply the server's recomputed cues on top of the state this
              // commit was based on; affected entries are absolute positions.
              cues: applyAffected(snapshot.cues, value.affected),
              revision: value.revision,
              updatedAt: value.updatedAt,
            };
          });
          setPendingConflict(null);
          if (historyLabel && value.affected.length > 0) {
            // Undo is stored as the inverse *intent*; pressing undo re-enters
            // it against the live state and re-runs every constraint, rather
            // than restoring a whole-track snapshot.
            setHistory((entries) => [...entries, {label: historyLabel, inverse: value.inverse}]);
          }
          setNotice({
            kind: 'info',
            text: value.rebased
              ? `Applied on newer revision (auto-rebased, rev ${value.revision})`
              : `Applied (rev ${value.revision}, Δ${value.appliedDelta}ms)`,
          });
          return;
        }
        if (response.status === 409) {
          const conflict = (await response.json()) as ConflictResponse;
          // Roll the optimistic layer back; the drag intent is preserved for
          // an explicit replay against the fresh revision (no overwrite).
          setTrack(snapshot);
          setPendingConflict({conflicts: conflict.conflicts, intent, reason: conflict.reason});
          setNotice({kind: 'conflict', text: `Conflict on rev ${conflict.revision} — review & replay`});
          return;
        }
        setTrack(snapshot);
        setNotice({kind: 'conflict', text: `Server error ${response.status}`});
      } catch {
        setTrack(snapshot);
        setNotice({kind: 'conflict', text: 'Network error — prediction rolled back'});
      } finally {
        setPending(false);
      }
    },
    [track],
  );

  // Re-fetch the authoritative track, then re-enter the preserved intent.
  const replayConflict = useCallback(async () => {
    if (!track || !pendingConflict) return;
    const fresh = (await fetch('/api/tracks/' + track.id).then((response) =>
      response.json(),
    )) as Track;
    setTrack(fresh);
    const outcome = solve(fresh.cues, pendingConflict.intent);
    if ('error' in outcome) {
      setNotice({kind: 'conflict', text: `Intent no longer applies: ${outcome.error}`});
      setPendingConflict(null);
      return;
    }
    setPendingConflict(null);
    await commit(
      pendingConflict.intent,
      toBase(fresh.cues),
      fresh.revision,
      outcome.affected,
      'Replayed drag',
      true,
    );
  }, [commit, pendingConflict, track]);

  // -------------------------------------------------------------------------
  // Pointer interactions.
  // -------------------------------------------------------------------------
  const updateRipplePrediction = useCallback(
    (state: DragState & {kind: 'ripple'}, pointerX: number) => {
      const dxMs = msForX(pointerX - state.startX);
      const anchorOrigin = state.originCues.find((cue) => cue.id === state.anchorId)!;
      const intent: RippleIntent = {
        type: 'ripple',
        anchorId: state.anchorId,
        selectedIds: state.selectedIds,
        anchorStart: anchorOrigin.start + dxMs,
      };
      const outcome = solve(state.originCues, intent);
      if ('error' in outcome) return;
      setDrag({
        ...state,
        predicted: applyAffected(state.originCues, outcome.affected),
        appliedDelta: outcome.appliedDelta,
      });
    },
    [],
  );

  const onCuePointerDown = (event: React.PointerEvent, cue: Cue) => {
    if (!track || pending || cue.locked) return;
    if (event.button !== 0) return;
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);

    const additive = event.shiftKey;
    const nextSelection = additive
      ? new Set(selectedCueIds)
      : selectedCueIds.has(cue.id)
        ? new Set(selectedCueIds)
        : new Set([cue.id]);
    if (additive) {
      if (nextSelection.has(cue.id)) nextSelection.delete(cue.id);
      else nextSelection.add(cue.id);
    }
    setSelectedCueIds(nextSelection);

    const selectedIds = [...nextSelection];
    const state: DragState & {kind: 'ripple'} = {
      kind: 'ripple',
      anchorId: cue.id,
      selectedIds,
      startX: event.clientX,
      pointerId: event.pointerId,
      originCues: track.cues,
      baseRevision: track.revision,
      base: toBase(track.cues),
      predicted: track.cues,
      appliedDelta: 0,
    };
    setDrag(state);
  };

  const onHandlePointerDown = (event: React.PointerEvent, cue: Cue) => {
    if (!track || pending || cue.locked) return;
    event.stopPropagation();
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    setDrag({
      kind: 'resize',
      cueId: cue.id,
      startX: event.clientX,
      pointerId: event.pointerId,
      originCues: track.cues,
      baseRevision: track.revision,
      base: toBase(track.cues),
      predicted: track.cues,
    });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const timelineLeft = timelineRef.current?.getBoundingClientRect().left ?? 0;
    const pointerX = event.clientX - timelineLeft;
    if (drag.kind === 'ripple') {
      updateRipplePrediction(drag, pointerX);
    } else {
      const origin = drag.originCues.find((cue) => cue.id === drag.cueId)!;
      const dxMs = msForX(event.clientX - drag.startX);
      const outcome = solve(drag.originCues, {
        type: 'resize-start',
        cueId: drag.cueId,
        start: Math.max(0, origin.start + dxMs),
      });
      if (!('error' in outcome)) {
        setDrag({...drag, predicted: applyAffected(drag.originCues, outcome.affected)});
      }
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const state = drag;
    setDrag(null);

    if (state.kind === 'ripple') {
      const dxMs = msForX(event.clientX - state.startX);
      if (dxMs === 0) return; // a click, not a drag
      const anchorOrigin = state.originCues.find((cue) => cue.id === state.anchorId)!;
      const intent: RippleIntent = {
        type: 'ripple',
        anchorId: state.anchorId,
        selectedIds: state.selectedIds,
        anchorStart: anchorOrigin.start + dxMs,
      };
      // Optimistic layer is the last local prediction; server recomputes.
      const optimistic = solve(state.originCues, intent);
      if (!('error' in optimistic)) {
        void commit(intent, state.base, state.baseRevision, optimistic.affected, 'Ripple move');
      }
    } else {
      const origin = state.originCues.find((cue) => cue.id === state.cueId)!;
      const dxMs = msForX(event.clientX - state.startX);
      if (dxMs === 0) return;
      const intent: Intent = {
        type: 'resize-start',
        cueId: state.cueId,
        start: Math.max(0, origin.start + dxMs),
      };
      const optimistic = solve(state.originCues, intent);
      if (!('error' in optimistic)) {
        void commit(intent, state.base, state.baseRevision, optimistic.affected, 'Start resize');
      }
    }
  };

  const toggleLock = async (cue: Cue) => {
    if (!track || pending) return;
    const intent: Intent = {type: 'lock', cueId: cue.id, locked: !cue.locked};
    const outcome = solve(track.cues, intent);
    if ('error' in outcome) return;
    await commit(intent, toBase(track.cues), track.revision, outcome.affected, null);
  };

  const undo = async () => {
    if (!track || pending || history.length === 0) return;
    const entry = history[history.length - 1];
    // Submit the inverse as a brand new operation on the live track; the
    // solver re-runs origin / min-duration / lock / overlap constraints.
    const outcome = solve(track.cues, entry.inverse);
    if ('error' in outcome) {
      setNotice({kind: 'conflict', text: `Undo blocked: ${outcome.error}`});
      return;
    }
    setHistory((entries) => entries.slice(0, -1));
    await commit(entry.inverse, toBase(track.cues), track.revision, outcome.affected, null);
  };

  const isSelected = (id: string) => selectedCueIds.has(id);
  const conflictIds = new Set(pendingConflict?.conflicts.map((cue) => cue.id) ?? []);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Subtitle Timing Studio</strong>
        <small>Ripple group editing · revision-safe</small>
      </header>

      <section className="workspace">
        <aside className="pane">
          <h2>Tracks</h2>
          <div className="list">
            {tracks.map((item) => (
              <button
                key={item.id}
                className={item.id === selectedTrackId ? 'active' : ''}
                onClick={() => loadTrack(item.id)}
              >
                {item.name}
                <br />
                <small>Revision {item.revision}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="pane editor">
          <div className="toolbar">
            <button onClick={undo} disabled={pending || history.length === 0}>
              <Undo2 size={15} />
              Undo{history.length > 0 ? ` (${history.length})` : ''}
            </button>
            <span className="hint">
              Drag cue bodies to ripple-move · Shift-click for multiple intervals ·
              drag the left edge to resize start · click the lock to stop propagation
            </span>
          </div>

          <div
            className={`timeline ${drag ? 'dragging' : ''} ${notice.kind === 'conflict' ? 'has-conflict' : ''}`}
            ref={timelineRef}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{width: xFor(domain)}}
          >
            <div className="ruler">
              {Array.from({length: Math.floor(domain / 1000) + 1}, (_, index) => (
                <span key={index} className="tick" style={{left: xFor(index * 1000)}}>
                  {index}s
                </span>
              ))}
            </div>

            {visibleCues.map((cue) => {
              const selected = isSelected(cue.id);
              const conflicting = conflictIds.has(cue.id);
              return (
                <div
                  key={cue.id}
                  className={[
                    'cue',
                    selected ? 'selected' : '',
                    cue.locked ? 'locked' : '',
                    conflicting ? 'conflicting' : '',
                  ].join(' ')}
                  style={{left: xFor(cue.start), width: Math.max(28, widthFor(cue.end - cue.start))}}
                  onPointerDown={(event) => onCuePointerDown(event, cue)}
                >
                  {!cue.locked && (
                    <span
                      className="edge"
                      onPointerDown={(event) => onHandlePointerDown(event, cue)}
                    />
                  )}
                  <span className="cue-text">{cue.text || cue.id}</span>
                  <button
                    className="lock-btn"
                    title={cue.locked ? 'Unlock cue' : 'Lock cue'}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleLock(cue);
                    }}
                  >
                    <Lock size={12} />
                  </button>
                </div>
              );
            })}
            <div className="origin-line" style={{left: 0}} title="Track origin (0s)" />
          </div>

          <div className={`status ${notice.kind}`}>
            {notice.kind === 'conflict' && <AlertTriangle size={14} />}
            <span>{notice.text}</span>
            {drag?.kind === 'ripple' && (
              <span className="delta">
                local prediction Δ{drag.appliedDelta}ms
              </span>
            )}
            {track && <span className="rev">rev {track.revision}</span>}
          </div>

          {pendingConflict && (
            <div className="conflict-panel">
              <AlertTriangle size={16} />
              <div>
                <strong>Another page changed this track.</strong>
                <p>
                  Conflicting cues:{' '}
                  {pendingConflict.conflicts.map((cue) => cue.id).join(', ') || '—'}
                  {pendingConflict.reason ? ` (${pendingConflict.reason})` : ''}.
                  Your drag intent was preserved — nothing was overwritten.
                </p>
              </div>
              <button className="primary" onClick={replayConflict}>
                Refresh &amp; replay intent
              </button>
              <button onClick={() => setPendingConflict(null)}>Dismiss</button>
            </div>
          )}
        </section>

        <aside className="pane inspector">
          <h2>Selection ({selectedCueIds.size})</h2>
          {visibleCues
            .filter((cue) => isSelected(cue.id))
            .map((cue) => (
              <div className="inspect-row" key={cue.id}>
                <code>{cue.id}</code>
                <span>
                  {formatTime(cue.start)} → {formatTime(cue.end)} · {cue.end - cue.start}ms
                </span>
                {cue.locked && <Lock size={12} />}
              </div>
            ))}
          <h2>Cues</h2>
          <div className="cue-table">
            {visibleCues.map((cue) => (
              <div
                key={cue.id}
                className={[
                  'inspect-row',
                  isSelected(cue.id) ? 'active' : '',
                  conflictIds.has(cue.id) ? 'conflicting' : '',
                ].join(' ')}
                onClick={() => setSelectedCueIds(new Set([cue.id]))}
              >
                <code>{cue.id}</code>
                <span>
                  {formatTime(cue.start)}–{formatTime(cue.end)}
                </span>
                {cue.locked && <Lock size={12} />}
              </div>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}
