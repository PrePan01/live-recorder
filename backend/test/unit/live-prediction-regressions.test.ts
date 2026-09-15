import { describe, expect, it } from 'vitest';
import {
  calculateLivePrediction,
  openingEvidenceInWindow,
  coversPredictionWindow,
  type DetectedLiveEvent,
} from '../../src/core/live-prediction.js';
const iso = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
const event = (day: string, time: string): DetectedLiveEvent => ({
  detectedAt: iso(day, time),
  source: 'platform',
  platformStartedAt: iso(day, time),
});
function predict(now: string, events: DetectedLiveEvent[], coverage: Array<{ startAt: string; endAt: string }> = []) {
  return calculateLivePrediction({ roomId: 'r', now: new Date(now).getTime(), generatedAt: new Date(now).toISOString(), events, coverage });
}
describe('live prediction real-life regressions', () => {
  it('keeps a well-established pattern visible but marks uncovered predictions and slots low without extra copy', () => {
    const p = predict(
      '2026-09-14T08:00:00',
      ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map((d) => event(d, '20:00')),
    );
    expect(p.kind).toBe('next');
    expect(p.startAt).toBe('20:00');
    expect(p.confidence).toBe('high');
    expect(p.likelihood).toBe('low');
    expect(p.slots.every((slot) => slot.likelihood === 'low')).toBe(true);
    expect(p.notice).toBeNull();
  });
  it('normalizes overlapping or unordered coverage without bridging real gaps', () => {
    const intervals = [
      { startAt: iso('2026-09-14', '20:10'), endAt: iso('2026-09-14', '20:40') },
      { startAt: iso('2026-09-14', '19:50'), endAt: iso('2026-09-14', '20:20') },
    ];
    expect(coversPredictionWindow(intervals, Date.parse(iso('2026-09-14', '20:00')), Date.parse(iso('2026-09-14', '20:30')))).toBe(true);
  });
  it('retains covered positive days when recording suspends polling immediately after opening', () => {
    const dates = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'];
    const p = predict(
      '2026-09-14T08:00:00',
      dates.map((d) => event(d, '20:00')),
      dates.map((d) => ({ startAt: iso(d, '19:00'), endAt: iso(d, '20:00') })),
    );
    expect(p.rawLikelihood).toBe('high');
    expect(p.todayProbability).toBe('medium');
  });
  it('does not mix Monday mornings with Tuesday evenings or invent other weekdays', () => {
    const events = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07']
      .map((d) => event(d, '09:00'))
      .concat(['2026-08-18', '2026-08-25', '2026-09-01', '2026-09-08'].map((d) => event(d, '20:00')));
    const morning = predict('2026-09-14T08:00:00', events);
    expect(morning.basis).toBe('weekday');
    expect(morning.startAt).toBe('09:00');
    expect(morning.slots).toHaveLength(1);
    const after = predict('2026-09-14T15:00:00', events);
    expect(after.nextDate).toBe('2026-09-15');
    expect(after.startAt).toBe('20:00');
  });
  it('requires independent broadcast dates rather than reconnect-like observations', () => {
    const p = predict('2026-09-14T08:00:00', [event('2026-09-07', '09:00'), event('2026-09-07', '09:05'), event('2026-09-07', '20:00')]);
    expect(p.kind).toBe('observation');
    expect(p.confidence).toBeNull();
  });
  it('keeps sparse predictions and every timeline slot low-confidence', () => {
    const p = predict('2026-09-14T08:00:00', [
      event('2026-08-31', '09:00'),
      event('2026-08-31', '20:00'),
      event('2026-09-07', '09:00'),
      event('2026-09-07', '20:00'),
    ]);
    expect(p.kind).toBe('next');
    expect(p.likelihood).toBe('low');
    expect(p.slots.every((s) => s.likelihood === 'low')).toBe(true);
  });
  it('does not borrow confidence from many morning observations for sparse evening observations', () => {
    const events = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].flatMap((d) => [event(d, '09:00')]);
    events.push(event('2026-08-31', '20:00'), event('2026-09-07', '20:00'));
    const p = predict('2026-09-14T15:00:00', events);
    expect(p.startAt).toBe('20:00');
    expect(p.confidence).toBe('low');
    expect(p.likelihood).toBe('low');
    expect(p.timeGranularity).toBe('quarter_hour');
  });
  it('preserves uncertainty of two-hour offline-to-live intervals', () => {
    const events = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map((d) => ({
      detectedAt: iso(d, '20:00'),
      source: 'transition' as const,
      lowerBoundAt: iso(d, '18:00'),
    }));
    const p = predict('2026-09-14T08:00:00', events);
    expect(p.timeGranularity).toBe('approximate');
    expect(p.windowStart).toBe('18:00');
    expect(p.windowEnd).toBe('20:00');
  });
  it('does not invent a start midpoint from room creation while already live', () => {
    const events = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map((d) => ({
      detectedAt: iso(d, '20:00'),
      source: 'initial_live' as const,
      lowerBoundAt: iso(d, '18:00'),
    }));
    const p = predict('2026-09-14T08:00:00', events);
    expect(p.startAt).toBe('20:00');
    expect(p.kind).toBe('observation');
    expect(p.confidence).toBeNull();
    expect(p.timeGranularity).toBeNull();
  });
  it('anchors late-night and next-day openings to the same broadcast date', () => {
    const events = [event('2026-08-17', '23:50'), event('2026-08-25', '00:10'), event('2026-08-31', '23:50'), event('2026-09-08', '00:10')];
    const active = predict('2026-09-15T00:05:00', events);
    expect(active.nextDate).toBe('2026-09-14');
    expect(active.basis).toBe('weekday');
    expect(active.windowEndTimestamp).toBe(iso('2026-09-15', '00:15'));
    const noon = predict('2026-09-14T12:00:00', events);
    expect(Date.parse(noon.windowStartTimestamp!)).toBeGreaterThan(new Date('2026-09-14T12:00:00').getTime());
    expect(Date.parse(noon.windowEndTimestamp!)).toBeGreaterThan(Date.parse(noon.windowStartTimestamp!));
  });
  it('treats a new installation without coverage as unknown instead of 60 days of misses', () => {
    const p = predict('2026-09-14T08:00:00', [event('2026-08-31', '20:00'), event('2026-09-07', '20:00')]);
    expect(p.todayProbability).toBeNull();
    expect(p.rawLikelihood).toBeNull();
    expect(p.probabilityKnown).toBe(false);
  });
  it('uses only matching dates fully covered at the selected window', () => {
    const events = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map((d) => event(d, '20:00'));
    const coverage = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map((d) => ({
      startAt: iso(d, '19:00'),
      endAt: iso(d, '21:00'),
    }));
    const p = predict('2026-09-14T08:00:00', events, coverage);
    expect(p.rawLikelihood).toBe('high');
    expect(p.todayProbability).toBe('medium');
    const noEvening = predict(
      '2026-09-14T08:00:00',
      events,
      coverage.map((i) => ({ startAt: i.startAt, endAt: i.startAt })),
    );
    expect(noEvening.todayProbability).toBeNull();
  });
  it('does not bridge a shutdown gap, including gaps inside midnight windows', () => {
    const start = Date.parse(iso('2026-09-14', '23:50')),
      end = Date.parse(iso('2026-09-15', '00:20'));
    expect(
      coversPredictionWindow(
        [
          { startAt: iso('2026-09-14', '23:45'), endAt: iso('2026-09-14', '23:55') },
          { startAt: iso('2026-09-15', '00:10'), endAt: iso('2026-09-15', '00:25') },
        ],
        start,
        end,
      ),
    ).toBe(false);
    expect(coversPredictionWindow([{ startAt: iso('2026-09-14', '23:45'), endAt: iso('2026-09-15', '00:25') }], start, end)).toBe(true);
  });
  it('calibrates by actual platform time and leaves overlapping uncertain transitions unknown', () => {
    const start = Date.parse(iso('2026-09-14', '23:50')),
      end = Date.parse(iso('2026-09-15', '00:20'));
    expect(openingEvidenceInWindow({ ...event('2026-09-14', '23:55'), detectedAt: iso('2026-09-15', '00:05') }, start, end)).toBe('hit');
    expect(
      openingEvidenceInWindow(
        { source: 'transition', lowerBoundAt: iso('2026-09-14', '23:00'), detectedAt: iso('2026-09-15', '00:10') },
        start,
        end,
      ),
    ).toBe('unknown');
  });
  it('rejects future observations and falls back after invalid detector observations', () => {
    const p = calculateLivePrediction({
      roomId: 'r',
      now: new Date('2026-09-14T08:00:00').getTime(),
      generatedAt: '',
      events: [{ detectedAt: 'invalid' }, event('2026-09-15', '20:00')],
      fallbackEvents: [event('2026-08-31', '20:00'), event('2026-09-07', '20:00')],
    });
    expect(p.sampleCount).toBe(2);
    expect(p.startAt).toBe('20:00');
  });
});
