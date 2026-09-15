import { describe, it, expect } from 'vitest';
import { calculateLivePrediction, openingEvidenceInWindow } from '../../src/core/live-prediction.js';
const iso = (d: string, t: string) => new Date(`${d}T${t}:00`).toISOString();
const opening = (d: string, t: string) => ({ source: 'platform' as const, detectedAt: iso(d, t), platformStartedAt: iso(d, t) });
function predict(time: string, now = '2026-09-15T12:00:00') {
  return calculateLivePrediction({
    roomId: 'margin',
    now: new Date(now).getTime(),
    generatedAt: new Date(now).toISOString(),
    events: ['2026-08-18', '2026-08-25', '2026-09-01', '2026-09-08'].map((d) => opening(d, time)),
  });
}
describe('stable opening margins', () => {
  it('accepts slightly early and late starts while preserving exact-time labels', () => {
    const p = predict('20:00');
    expect(p.startAt).toBe('20:00');
    expect(p.timeGranularity).toBe('exact');
    expect([p.windowStart, p.windowEnd]).toEqual(['19:45', '20:15']);
    const start = Date.parse(p.windowStartTimestamp!),
      end = Date.parse(p.windowEndTimestamp!);
    expect(openingEvidenceInWindow(opening('2026-09-15', '19:58'), start, end)).toBe('hit');
    expect(openingEvidenceInWindow(opening('2026-09-15', '20:10'), start, end)).toBe('hit');
    expect(openingEvidenceInWindow(opening('2026-09-15', '19:30'), start, end)).toBe('outside');
  });
  it('keeps leading margins for openings just after midnight', () => {
    const p = predict('00:05', '2026-09-14T12:00:00');
    expect(p.windowStartTimestamp).toBe(iso('2026-09-14', '23:50'));
    expect(p.windowEndTimestamp).toBe(iso('2026-09-15', '00:20'));
    expect(p.startTimestamp).toBe(iso('2026-09-15', '00:05'));
  });
});
