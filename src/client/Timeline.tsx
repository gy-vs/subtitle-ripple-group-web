import {useRef} from 'react';
import {Lock, LockOpen} from 'lucide-react';
import type {Cue} from '../shared/engine';

type Gesture =
  | {
      mode: 'move' | 'trim-start' | 'trim-end';
      pointerId: number;
      startX: number;
      baseCues: Cue[];
      anchorId: string;
      moved: boolean;
    }
  | null;

export type TimelineProps = {
  cues: Cue[];
  selected: Set<string>;
  conflicts: Set<string>;
  totalMs: number;
  disabled: boolean;
  onToggleSelect: (id: string, additive: boolean) => void;
  onClearSelection: () => void;
  onPreview: (
    mode: 'move' | 'trim-start' | 'trim-end',
    baseCues: Cue[],
    anchorId: string,
    desiredMs: number,
  ) => void;
  onCommitGesture: (
    mode: 'move' | 'trim-start' | 'trim-end',
    anchorId: string,
    desiredMs: number,
    baseCues: Cue[],
  ) => void;
  onToggleLock: (id: string) => void;
};

const PIXELS_PER_MS = 0.05;
const DRAG_THRESHOLD_PX = 4;

export function formatTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const totalSeconds = safe / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = safe % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export default function Timeline(props: TimelineProps) {
  const {
    cues,
    selected,
    conflicts,
    totalMs,
    disabled,
    onToggleSelect,
    onClearSelection,
    onPreview,
    onCommitGesture,
    onToggleLock,
  } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture>(null);

  const width = Math.max(totalMs * PIXELS_PER_MS, 320);
  const toMs = (clientX: number): number => {
    const el = trackRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.round((clientX - rect.left + el.scrollLeft) / PIXELS_PER_MS);
  };

  const desiredFor = (
    mode: 'move' | 'trim-start' | 'trim-end',
    baseCues: Cue[],
    anchorId: string,
    clientX: number,
  ): number => {
    const pointerMs = toMs(clientX);
    const base = baseCues.find((cue) => cue.id === anchorId)!;
    if (mode === 'trim-start') return pointerMs;
    if (mode === 'trim-end') return pointerMs;
    const g = gestureRef.current!;
    return base.start + (clientX - g.startX) / PIXELS_PER_MS;
  };

  const beginGesture = (
    event: React.PointerEvent,
    mode: 'move' | 'trim-start' | 'trim-end',
    cue: Cue,
  ) => {
    if (disabled || cue.locked) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    gestureRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      baseCues: cues.map((value) => ({...value})),
      anchorId: cue.id,
      moved: false,
    };
  };

  const handleMove = (event: React.PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.moved && Math.abs(event.clientX - gesture.startX) < DRAG_THRESHOLD_PX) return;
    gesture.moved = true;
    onPreview(
      gesture.mode,
      gesture.baseCues,
      gesture.anchorId,
      desiredFor(gesture.mode, gesture.baseCues, gesture.anchorId, event.clientX),
    );
  };

  const finishGesture = (event: React.PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.moved) {
      onCommitGesture(
        gesture.mode,
        gesture.anchorId,
        desiredFor(gesture.mode, gesture.baseCues, gesture.anchorId, event.clientX),
        gesture.baseCues,
      );
    }
  };

  const tickStep = 1000;

  return (
    <div className="timeline-scroll">
      <div
        className="timeline"
        ref={trackRef}
        style={{width}}
        onPointerMove={handleMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('ruler')) {
            onClearSelection();
          }
        }}
      >
        <div className="ruler" aria-hidden>
          {Array.from({length: Math.floor(totalMs / tickStep) + 1}, (_, i) => (
            <span key={i} className="tick" style={{left: i * tickStep * PIXELS_PER_MS}}>
              {formatTime(i * tickStep)}
            </span>
          ))}
        </div>
        <div className="lane">
          {cues.map((cue) => {
            const isSelected = selected.has(cue.id);
            const isConflict = conflicts.has(cue.id);
            return (
              <div
                key={cue.id}
                className={[
                  'cue',
                  isSelected ? 'selected' : '',
                  cue.locked ? 'locked' : '',
                  isConflict ? 'conflict' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{left: cue.start * PIXELS_PER_MS, width: (cue.end - cue.start) * PIXELS_PER_MS}}
                onPointerDown={(event) => {
                  if (!(event.target as HTMLElement).classList.contains('cue-handle')) {
                    if (!event.shiftKey && !isSelected) onToggleSelect(cue.id, event.shiftKey);
                    else if (event.shiftKey) onToggleSelect(cue.id, true);
                    beginGesture(event, 'move', cue);
                  }
                }}
                title={`${cue.id} · ${formatTime(cue.start)}–${formatTime(cue.end)}`}
              >
                {!cue.locked && (
                  <span
                    className="cue-handle cue-handle-start"
                    onPointerDown={(event) => beginGesture(event, 'trim-start', cue)}
                  />
                )}
                <span className="cue-label">
                  {cue.locked && <Lock size={11} aria-label="locked" />}
                  {cue.text}
                </span>
                {!cue.locked && (
                  <span
                    className="cue-handle cue-handle-end"
                    onPointerDown={(event) => beginGesture(event, 'trim-end', cue)}
                  />
                )}
                <button
                  className="cue-lock"
                  type="button"
                  aria-label={cue.locked ? 'unlock cue' : 'lock cue'}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!disabled) onToggleLock(cue.id);
                  }}
                >
                  {cue.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
