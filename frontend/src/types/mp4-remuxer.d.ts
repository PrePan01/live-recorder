declare module "mpegts.js/src/remux/mp4-remuxer.js" {
  export default class Mp4Remuxer {
    constructor(config: unknown);
    _dtsBase: number;
    _dtsBaseInited: boolean;
    _audioMeta: unknown;
    onMediaSegment: ((...args: unknown[]) => void) | null;
    _remuxAudio(data: unknown, silent?: boolean): void;
    destroy(): void;
  }
}
