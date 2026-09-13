import { describe, expect, it } from 'vitest';
import { calculateLivePrediction } from '../../src/core/live-prediction.js';

const now = new Date('2026-09-13T10:00:00.000Z').getTime();
const generatedAt = '2026-09-13T10:00:00.000Z';

function detected(detectedAt: string) {
  return { detectedAt };
}

describe('live prediction', () => {
  it('uses a single valid record as an observation rather than an unsupported prediction', () => {
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events: [detected('2026-09-12T12:00:00.000Z')] });
    expect(result.kind).toBe('observation');
    expect(result.sampleCount).toBe(1);
    expect(result.confidence).toBeNull();
  });

  it('keeps multiple opening detections on the same day as separate observations', () => {
    const result = calculateLivePrediction({
      roomId: 'room_1', now, generatedAt,
      events: [
        detected('2026-09-01T12:00:00.000Z'),
        detected('2026-09-01T18:00:00.000Z'),
        detected('not-a-date'),
      ],
    });
    expect(result.kind).toBe('observation');
    expect(result.sampleCount).toBe(2);
    expect(result.basedOnDays).toBeGreaterThanOrEqual(1);
  });

  it('prefers a same-weekday model and reports a next-date prediction', () => {
    const events = [
      '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05', '2026-09-12',
    ].map((day) => detected(`${day}T12:00:00.000Z`));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.kind).toBe('next');
    expect(result.basis).toBe('weekday');
    expect(result.nextDate).toBeTruthy();
    expect(result.confidence).toBe('high');
    expect(result.timeGranularity).toBe('exact');
  });

  it('returns a typical, not date-specific, prediction when only the all-history model exists', () => {
    const events = [
      '2026-09-01', '2026-09-03', '2026-09-05',
    ].map((day) => detected(`${day}T12:00:00.000Z`));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.kind).toBe('typical');
    expect(result.basis).toBe('all');
    expect(result.nextDate).toBeNull();
    expect(result.confidence).toBe('low');
  });

  it('selects the next same-day slot after the current time', () => {
    const localTime = (day: string, hour: number) => {
      const value = new Date(`${day}T00:00:00`);
      value.setHours(hour, 0, 0, 0);
      return value.toISOString();
    };
    const currentNow = Date.parse(localTime('2026-09-12', 15));
    const events = [
      ['2026-08-08', 9], ['2026-08-08', 19],
      ['2026-08-15', 9], ['2026-08-15', 19],
      ['2026-08-22', 9], ['2026-08-22', 19],
    ].map(([day, hour]) => detected(localTime(day as string, hour as number)));
    const result = calculateLivePrediction({ roomId: 'room_1', now: currentNow, generatedAt, events });
    expect(result.kind).toBe('next');
    expect(result.slots).toHaveLength(2);
    expect(result.startAt).toBe('19:00');
  });
});
