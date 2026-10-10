/** A textual cue anchored to one recording, never to a room. */
export interface RecordingMarker {
  id: string;
  recordingId: string;
  /** Relative to the beginning of the recording; kept numeric for the timeline. */
  positionSeconds: number;
  /** Null/absent for a point label; otherwise the end of a persistent segment. */
  endPositionSeconds?: number | null;
  text: string;
  createdAt: string;
  updatedAt: string;
}
