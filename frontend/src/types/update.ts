export interface UpdateState {
  revision: number;
  currentVersion: string;
  phase: 'idle' | 'available' | 'downloading' | 'ready';
  update: { version: string; asset: { filename: string; url: string; size: number; sha256: string } } | null;
  downloaded: number;
  error: string | null;
}
