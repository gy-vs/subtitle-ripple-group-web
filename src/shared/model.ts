// Shared domain types for the subtitle cue timing editor.
// Times are integer milliseconds relative to the track origin.

export const MIN_DURATION = 500; // cues shorter than this are rejected / clamped
export const MIN_GAP = 0; // cues may touch but never overlap
export const TRACK_ORIGIN = 0;

export type Cue = {
  id: string;
  start: number;
  end: number;
  text: string;
  locked: boolean;
};

export type Track = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  cues: Cue[];
};

export type RippleIntent = {
  type: 'ripple';
  anchorId: string;
  // Ordered selection containing the anchor. A group move keeps the
  // intra-selection spacing and pushes unlocked followers out of the way.
  selectedIds: string[];
  // Where the client wanted the anchor to start (px -> ms).
  anchorStart: number;
};

export type ResizeStartIntent = {
  type: 'resize-start';
  cueId: string;
  start: number;
};

export type LockIntent = {
  type: 'lock';
  cueId: string;
  locked: boolean;
};

export type Intent = RippleIntent | ResizeStartIntent | LockIntent;

// Per-cue state the client believes in, so the server can compute the
// minimal conflict set when another page changed the track meanwhile.
export type CueBase = {id: string; start: number; end: number; locked: boolean};

export type AppliedCue =
  | {id: string; kind: 'timing'; start: number; end: number; locked: boolean}
  | {id: string; kind: 'lock'; locked: boolean};

export type SolveResult = {
  // New values for every cue that actually moved (others stay untouched).
  affected: AppliedCue[];
  // Cues read by the solver (selection + pushed followers, never locks that
  // merely bounded the move). This is the minimal conflict fingerprint.
  touchedIds: string[];
  // Signed translation that survived the constraints (may be 0 when blocked).
  appliedDelta: number;
  requestedDelta: number;
  // Inverse intent: replaying it against the resulting track undoes the move
  // while re-running every constraint (never a raw snapshot restore).
  inverse: Intent;
};

export type ResolveResult = {
  cues: Cue[]; // full post-solve cue list
  affected: AppliedCue[];
  touchedIds: string[];
  inverse: Intent;
  rebased: boolean; // true when base revision was stale but the intent still applied
};

export const durationOk = (cue: {start: number; end: number}) =>
  Number.isFinite(cue.start) &&
  Number.isFinite(cue.end) &&
  cue.end - cue.start >= MIN_DURATION;
