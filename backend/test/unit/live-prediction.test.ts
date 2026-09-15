import { describe, expect, it } from 'vitest';
import { calculateLivePrediction, recordingFallbackEvents } from '../../src/core/live-prediction.js';

const now = new Date('2026-09-13T10:00:00.000Z').getTime();
const generatedAt = '2026-09-13T10:00:00.000Z';

function detected(detectedAt: string) {
  return { detectedAt };
}

/** The prediction is displayed in the recorder machine's local timezone. */
function localHhmm(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

describe('live prediction', () => {
  it('uses a single valid record as a recent observation', () => {
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events: [detected('2026-09-12T12:00:00.000Z')] });
    expect(result.kind).toBe('observation');
    expect(result.sampleCount).toBe(1);
    expect(result.confidence).toBeNull();
  });

  it('keeps multiple opening detections on the same day as separate observations', () => {
    const result = calculateLivePrediction({
      roomId: 'room_1', now, generatedAt,
      events: [
        detected(new Date('2026-09-01T09:00:00').toISOString()),
        detected(new Date('2026-09-01T20:00:00').toISOString()),
        detected('not-a-date'),
      ],
    });
    expect(result.kind).toBe('observation');
    expect(result.sampleCount).toBe(2);
    expect(result.basedOnDays).toBe(1);
  });

  it('keeps the latest discovery time when an initially-live observation is not yet a prediction', () => {
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
    expect(result.startAt).toBe(localHhmm('2026-09-12T12:00:00.000Z'));
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

  it('retains a Saturday-only habit instead of guessing a Sunday opening', () => {
    const events = [
      '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05', '2026-09-12',
    ].map((day) => detected(`${day}T12:00:00.000Z`));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.kind).toBe('next');
    expect(result.basis).toBe('weekday');
    expect(result.nextDate).toBe('2026-09-19');
    expect(result.confidence).toBe('high');
    expect(result.timeGranularity).toBe('quarter_hour');
  });

  it('uses a quarter-hour time when a pattern concentrates within 30 minutes', () => {
    const events = [
      ['2026-08-22', '12:00'], ['2026-08-29', '12:00'],
      ['2026-09-05', '12:30'], ['2026-09-12', '12:30'],
    ].map(([day, time]) => detected(`${day}T${time}:00.000Z`));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.confidence).toBe('medium');
    expect(result.timeGranularity).toBe('quarter_hour');
  });

  it('retains a nearer supported habit instead of hiding it behind a larger future group', () => {
    const local = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
    const events = [
      local('2026-08-30', '20:00'), local('2026-09-06', '20:00'),
      local('2026-08-10', '20:00'), local('2026-08-17', '20:00'),
      local('2026-08-24', '20:00'), local('2026-08-31', '20:00'),
    ].map((detectedAt) => ({ detectedAt, source: 'transition' as const, lowerBoundAt: detectedAt }));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.nextDate).toBe('2026-09-13');
    expect(result.basis).toBe('weekday');
  });

  it('does not let one platform timestamp make a mixed slot minute-exact', () => {
    const local = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
    const events = [
      { detectedAt: local('2026-08-10', '20:00'), source: 'platform' as const, platformStartedAt: local('2026-08-10', '20:00') },
      { detectedAt: local('2026-08-17', '20:30'), source: 'transition' as const, lowerBoundAt: local('2026-08-17', '20:30') },
      { detectedAt: local('2026-08-24', '20:30'), source: 'transition' as const, lowerBoundAt: local('2026-08-24', '20:30') },
      { detectedAt: local('2026-08-31', '20:30'), source: 'transition' as const, lowerBoundAt: local('2026-08-31', '20:30') },
    ];
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.timeGranularity).toBe('quarter_hour');
  });

  it('uses minute precision for four concentrated high-quality observations', () => {
    const local = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
    const events = [
      local('2026-08-10', '20:00'), local('2026-08-17', '20:05'),
      local('2026-08-24', '20:10'), local('2026-08-31', '20:15'),
    ].map((detectedAt) => ({ detectedAt, source: 'transition' as const, lowerBoundAt: detectedAt }));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.timeGranularity).toBe('exact');
  });

  it('uses a low-confidence day-type prediction when the all-history records share a day type', () => {
    const events = [
      '2026-09-01', '2026-09-03', '2026-09-05',
    ].map((day) => detected(`${day}T12:00:00.000Z`));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.kind).toBe('next');
    expect(result.basis).toBe('day_type');
    expect(result.nextDate).toBeTruthy();
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

  it('reports today likelihood and selects the next remaining slot', () => {
    const localTime = (day: string, hour: number) => {
      const value = new Date(`${day}T00:00:00`);
      value.setHours(hour, 0, 0, 0);
      return value.toISOString();
    };
    const currentNow = Date.parse(localTime('2026-09-11', 15));
    const events = [
      ['2026-08-21', 14], ['2026-08-28', 14], ['2026-08-28', 20], ['2026-09-04', 20],
    ].map(([day, hour]) => detected(localTime(day as string, hour as number)));
    const result = calculateLivePrediction({ roomId: 'room_1', now: currentNow, generatedAt, events });
    expect(result.kind).toBe('next');
    expect(result.startAt).toBe('20:00');
    expect(result.todayProbability).toBeNull();
    expect(result.slots[0].likelihood).toBe('low');
    expect(result.probabilityKnown).toBe(false);
  });

  it('gives a concentrated two-sample forecast a quarter-hour time but low likelihood', () => {
    const currentNow = Date.parse(new Date('2026-09-03T15:00:00').toISOString());
    const result = calculateLivePrediction({
      roomId: 'room_1', now: currentNow, generatedAt,
      events: [
        detected(new Date('2026-09-01T20:37:00').toISOString()),
        detected(new Date('2026-09-02T20:39:00').toISOString()),
      ],
    });
    expect(result.kind).toBe('next');
    expect(result.startAt).toBe('20:37');
    expect(result.timeGranularity).toBe('quarter_hour');
    expect(result.likelihood).toBe('low');
  });

  it('changes a covered-window probability using settled outcomes, independently of confidence caps', () => {
    const dates = ['2026-08-21','2026-08-28','2026-09-04','2026-09-11'];
    const events = dates.map(day => ({detectedAt:new Date(`${day}T20:00:00`).toISOString(),source:'platform' as const,platformStartedAt:new Date(`${day}T20:00:00`).toISOString()}));
    const coverage = dates.map(day => ({startAt:new Date(`${day}T19:00:00`).toISOString(),endAt:new Date(`${day}T21:00:00`).toISOString()}));
    const input = {roomId:'room_1',now:new Date('2026-09-18T15:00:00').getTime(),generatedAt,events,coverage};
    const before = calculateLivePrediction(input);
    const after = calculateLivePrediction({...input,calibration:{high:{hits:0,total:5}}});
    expect(before.rawLikelihood).toBe('high');
    expect(before.todayProbability).toBe('medium');
    expect(after.rawLikelihood).toBe('high');
    expect(after.todayProbability).toBe('low');
    expect(after.likelihood).toBe('low');
  });

  it('includes only a compact trace of recent observations for the popover', () => {
    const events = Array.from({ length: 10 }, (_, index) => ({
      detectedAt: `2026-09-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
      source: index === 9 ? 'platform' as const : 'transition' as const,
      platformStartedAt: index === 9 ? '2026-09-10T11:55:00.000Z' : null,
    }));
    const result = calculateLivePrediction({ roomId: 'room_1', now, generatedAt, events });
    expect(result.recentObservations).toHaveLength(8);
    expect(result.recentObservations.at(-1)).toEqual({
      time: localHhmm('2026-09-10T11:55:00.000Z'),
      quality: 'platform',
    });
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
      expect.objectContaining({ startAt: '11:45', endAt: '12:15' }),
      expect.objectContaining({ startAt: '15:45', endAt: '16:15' }),
    ]));
  });
});
