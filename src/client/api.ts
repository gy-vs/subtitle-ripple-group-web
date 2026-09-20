import type {Intent, Track} from '../shared/engine';

export type TrackSummary = {id: string; name: string; revision: number; updatedAt: string};

export type OpSuccess = {
  track: Track;
  changed: string[];
  affected: string[];
  inverse: Intent | null;
  ripple: {
    requestedDelta: number;
    appliedDelta: number;
    direction: 1 | -1 | 0;
    clamped: boolean;
    barrier: string | null;
    anchorRequestedStart: number;
    anchorActualStart: number;
  } | null;
  rebased: boolean;
};

export type OpConflict = {
  reason: 'conflicting_cues' | 'unknown_base_revision';
  revision: number;
  track: Track;
  /** Minimal conflict set; null when the base revision is unknown. */
  conflicts: string[] | null;
};

export type OpResult =
  | {status: 'ok'; data: OpSuccess}
  | {status: 'conflict'; data: OpConflict}
  | {status: 'rejected'; message: string}
  | {status: 'error'; message: string};

async function parse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export const api = {
  async listTracks(): Promise<TrackSummary[]> {
    const response = await fetch('/api/tracks');
    return response.json();
  },
  async getTrack(id: string): Promise<Track> {
    const response = await fetch(`/api/tracks/${id}`);
    if (!response.ok) throw new Error(`failed to load track ${id}`);
    return response.json();
  },
  async submitOperation(id: string, revision: number, intent: Intent): Promise<OpResult> {
    let response: Response;
    try {
      response = await fetch(`/api/tracks/${id}/operations`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({revision, intent}),
      });
    } catch (err) {
      return {status: 'error', message: (err as Error).message};
    }
    const body = (await parse(response)) as any;
    if (response.ok) return {status: 'ok', data: body as OpSuccess};
    if (response.status === 409) {
      return {
        status: 'conflict',
        data: {
          reason: body.reason ?? 'conflicting_cues',
          revision: body.revision,
          track: body.track,
          conflicts: body.conflicts ?? null,
        },
      };
    }
    if (response.status === 422) {
      return {status: 'rejected', message: body?.message ?? 'intent rejected'};
    }
    return {status: 'error', message: body?.error ?? `HTTP ${response.status}`};
  },
  async externalTouch(id: string, offset = 120, cueId?: string): Promise<Track> {
    const response = await fetch(`/api/tracks/${id}/debug/external-touch`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({offset, cueId}),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? 'external touch failed');
    return body.track as Track;
  },
};
