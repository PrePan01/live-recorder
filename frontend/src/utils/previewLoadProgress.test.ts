import { describe, expect, it } from 'vitest';
import { advancePreviewLoadProgress, initialPreviewLoadProgress } from './previewLoadProgress';

describe('preview loading milestones', () => {
  it('advances only for completed stages and ignores late, duplicate and unknown events', () => {
    const downloading = advancePreviewLoadProgress(initialPreviewLoadProgress, 'youtube_manifests_ready');
    expect(downloading.percent).toBeGreaterThan(initialPreviewLoadProgress.percent);
    expect(advancePreviewLoadProgress(downloading, 'requested')).toBe(downloading);
    expect(advancePreviewLoadProgress(downloading, 'youtube_manifests_ready')).toBe(downloading);
    expect(advancePreviewLoadProgress(downloading, '__proto__')).toBe(downloading);
    expect(advancePreviewLoadProgress(downloading, 'untrusted-stage')).toBe(downloading);
  });
  it('never completes on backend readiness or media arrival; requires an actually presented frame', () => {
    let progress = initialPreviewLoadProgress;
    for (const stage of ['source_ready', 'preview_media_ready', 'receiving_media', 'decoded']) {
      progress = advancePreviewLoadProgress(progress, stage);
      expect(progress.percent).toBeLessThan(100);
    }
    expect(advancePreviewLoadProgress(progress, 'presented').percent).toBe(100);
  });
});
