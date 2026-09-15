import { describe, expect, it } from 'vitest';
import { calculateLivePrediction, recordingFallbackEvents } from '../../src/core/live-prediction.js';

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

  it('keeps the latest discovery time as a record when an initially-live observation is not yet a prediction', () => {
    const local = (time: string) => new Date(`2026-09-12T${time}:00`).toISOString();
    const result = calculateLivePrediction({
      roomId: 'room_1', now, generatedAt,
      events: [{
        detectedAt: local('20:10'),
        source: 'initial_live',
        lowerBoundAt: local('18:00'),
      }],
    });
    expect(result.kind).toBe('observation');
    expect(result.startAt).toBe('20:10');
    expect(result.lastRecordedAt).toBe('20:10');
  });

  it('keeps an unbounded initially-live discovery as low-weight evidence', () => {
    const detectedAt = new Date('2026-09-12T20:10:00').toISOString();
    const result = calculateLivePrediction({
      roomId: 'room_1', now, generatedAt,
      events: [{ detectedAt, source: 'initial_live' }],
    });
    expect(result.kind).toBe('observation');
    expect(result.startAt).toBe('20:10');
  });

  it('prefers a validated platform start time over the local detection time', () => {
    const result = calculateLivePrediction({
      roomId: 'room_1', now, generatedAt,
      events: [{
        detectedAt: '2026-09-12T12:05:00.000Z',
        source: 'platform',
        platformStartedAt: '2026-09-12T12:00:00.000Z',
      }],
    });
    expect(result.startAt).toBe('20:00');
  });

  it('uses historical recording starts only as a de-duplicated fallback', () => {
    const fallbackEvents = recordingFallbackEvents([
      { startedAt: '2026-09-01T12:00:00.000Z', streamSessionId: 'same-session' },
      { startedAt: '2026-09-01T12:05:00.000Z', streamSessionId: 'same-session' },
      { startedAt: '2026-09-02T12:00:00.000Z', streamSessionId: 'other-session' },
    ]);
    expect(fallbackEvents).toHaveLength(2);
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events: [], fallbackEvents });
    expect(result.sampleCount).toBe(2);
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

  it('uses approximate time when the opening pattern is not high confidence', () => {
    const events = [
      ['2026-08-22', '12:00'], ['2026-08-29', '12:00'],
      ['2026-09-05', '12:30'], ['2026-09-12', '12:30'],
    ].map(([day, time]) => detected(`${day}T${time}:00.000Z`));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.confidence).toBe('medium');
    expect(result.timeGranularity).toBe('approximate');
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

  it('reports today likelihood and selects the slot nearest to the current time', () => {
    const localTime = (day: string, hour: number) => {
      const value = new Date(`${day}T00:00:00`);
      value.setHours(hour, 0, 0, 0);
      return value.toISOString();
    };
    const currentNow = Date.parse(localTime('2026-09-11', 15));
    const events = [
      ['2026-08-21', 14], ['2026-08-28', 14], ['2026-09-04', 20],
    ].map(([day, hour]) => detected(localTime(day as string, hour as number)));
    const result = calculateLivePrediction({ roomId: 'room_1', now: currentNow, generatedAt, events });
    expect(result.kind).toBe('next');
    expect(result.startAt).toBe('14:00');
    expect(result.todayProbability).toBe('medium');
    expect(result.slots[0]).toMatchObject({ startAt: '14:00', likelihood: 'high' });
  });

  it('uses enough settled local outcomes to calibrate today probability conservatively', () => {
    const localTime = (day: string, hour: number) => {
      const value = new Date(`${day}T00:00:00`);
      value.setHours(hour, 0, 0, 0);
      return value.toISOString();
    };
    const currentNow = Date.parse(localTime('2026-09-11', 15));
    const events = [
      ['2026-08-21', 14], ['2026-08-28', 14], ['2026-09-04', 20],
    ].map(([day, hour]) => detected(localTime(day as string, hour as number)));
    const result = calculateLivePrediction({
      roomId: 'room_1', now: currentNow, generatedAt, events,
      calibration: { medium: { hits: 0, total: 5 } },
    });
    // (0 + 1) / (5 + 2) is deliberately smoothed, then maps to low.
    expect(result.todayProbability).toBe('low');
  });

  it('includes only a compact trace of recent observations for the popover', () => {
    const events = Array.from({ length: 10 }, (_, index) => ({
      detectedAt: `2026-09-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
      source: index === 9 ? 'platform' as const : 'transition' as const,
      platformStartedAt: index === 9 ? '2026-09-10T11:55:00.000Z' : null,
    }));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.recentObservations).toHaveLength(8);
    expect(result.recentObservations.at(-1)).toEqual({ time: '19:55', quality: 'platform' });
  });

  it('gradually promotes a concentrated recent shift without discarding the older slot', () => {
    const localTime = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
    const currentNow = Date.parse(localTime('2026-09-20', '23:00'));
    const events = [
      '2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23',
    ].map((day) => detected(localTime(day, '12:00'))).concat(
      ['2026-08-30', '2026-09-06', '2026-09-13'].map((day) => detected(localTime(day, '16:00'))),
    );
    const result = calculateLivePrediction({ roomId: 'room_1', now: currentNow, generatedAt, events });
    expect(result.kind).toBe('next');
    expect(result.startAt).toBe('16:00');
    expect(result.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ startAt: '12:00' }),
      expect.objectContaining({ startAt: '16:00' }),
    ]));
  });
});
