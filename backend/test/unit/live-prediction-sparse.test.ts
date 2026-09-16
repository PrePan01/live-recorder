import { describe, it, expect } from 'vitest';
import { calculateLivePrediction, recordingFallbackEvents, type DetectedLiveEvent } from '../../src/core/live-prediction.js';
const iso = (d: string, t: string) => new Date(`${d}T${t}:00`).toISOString();
const opening = (d: string, t = '20:00'): DetectedLiveEvent => ({
  source: 'platform',
  detectedAt: iso(d, t),
  platformStartedAt: iso(d, t),
});
function predict(events: DetectedLiveEvent[], fallbackEvents: DetectedLiveEvent[] = []) {
  return calculateLivePrediction({
    roomId: 'sparse',
    events,
    fallbackEvents,
    now: new Date('2026-09-15T12:00:00').getTime(),
    generatedAt: '',
  });
}
describe('sparse intermittent monitoring', () => {
  it('keeps small timing jitter useful without minute precision', () => {
    const p = predict([opening('2026-09-01', '19:58'), opening('2026-09-08', '20:03')]);
    expect(p.timeGranularity).toBe('quarter_hour');
    expect(p.likelihood).toBe('low');
  });
  it('requires a third matching weekday before dating the forecast to next week', () => {
    const p = calculateLivePrediction({
      roomId: 'sparse',
      events: [opening('2026-09-01'), opening('2026-09-08')],
      now: new Date('2026-09-09T12:00:00').getTime(),
      generatedAt: '',
    });
    expect(p.kind).toBe('typical');
    expect(p.basis).toBe('all');
    expect(p.nextDate).toBeNull();
  });
  it('promotes two matching weekdays when intervening days were actually monitored', () => {
    const coverage = ['2026-09-02', '2026-09-03', '2026-09-04'].map((day) => ({
      startAt: iso(day, '19:45'),
      endAt: iso(day, '20:15'),
    }));
    const p = calculateLivePrediction({
      roomId: 'sparse',
      events: [opening('2026-09-01'), opening('2026-09-08')],
      coverage,
      now: new Date('2026-09-09T12:00:00').getTime(),
      generatedAt: '',
    });
    expect(p.kind).toBe('next');
    expect(p.basis).toBe('weekday');
    expect(p.nextDate).toBe('2026-09-15');
    expect(p.coverageDays).toBe(3);
  });
  it('dates an established weekday habit after three matching dates', () => {
    const p = calculateLivePrediction({
      roomId: 'sparse',
      events: [opening('2026-08-25'), opening('2026-09-01'), opening('2026-09-08')],
      now: new Date('2026-09-09T12:00:00').getTime(),
      generatedAt: '',
    });
    expect(p.kind).toBe('next');
    expect(p.basis).toBe('weekday');
    expect(p.nextDate).toBe('2026-09-15');
  });
  it('retains both sparse time extremes plus a bounded margin', () => {
    const p = predict([opening('2026-09-01', '19:00'), opening('2026-09-08', '21:00')]);
    expect([p.windowStart, p.windowEnd]).toEqual(['18:30', '21:30']);
    expect(p.timeGranularity).toBe('approximate');
    expect(p.likelihood).toBe('low');
  });
  it('offers a broad period when two starts are spread across the evening', () => {
    const p = predict([opening('2026-09-01', '18:30'), opening('2026-09-08', '22:00')]);
    expect(p.timeGranularity).toBe('period');
    expect(p.likelihood).toBe('low');
  });
  it('does not combine unrelated morning and evening starts into a fabricated habit', () => {
    const p = predict([opening('2026-09-01', '09:00'), opening('2026-09-08', '21:00')]);
    expect(p.kind).toBe('unavailable');
  });
  it('does not infer an every-other-day schedule from missing monitoring days', () => {
    const p = predict(['2026-09-08', '2026-09-10', '2026-09-12', '2026-09-14'].map((d) => opening(d)));
    expect(p.basis).not.toBe('interval');
    expect(p.likelihood).toBe('low');
  });
  it('keeps a stable Mon/Wed/Fri schedule instead of introducing Sunday', () => {
    const p = calculateLivePrediction({
      roomId: 'weekly',
      now: new Date('2026-09-12T12:00:00').getTime(),
      generatedAt: '',
      events: ['2026-08-31', '2026-09-02', '2026-09-04', '2026-09-07', '2026-09-09', '2026-09-11'].map((d) => opening(d)),
      coverage: [{ startAt: iso('2026-08-31', '00:00'), endAt: iso('2026-09-12', '00:00') }],
    });
    expect(p.basis).toBe('weekday');
    expect(p.nextDate).toBe('2026-09-14');
  });
  it('shows observations when the user only discovers already-live rooms', () => {
    const p = predict(['2026-09-01', '2026-09-08'].map((d) => ({ source: 'initial_live', detectedAt: iso(d, '21:00') })));
    expect(p.kind).toBe('observation');
    expect(p.lastRecordedAt).toBe('21:00');
  });
  it('does not let an unbounded discovery move established opening times', () => {
    const p = predict([opening('2026-09-01'), opening('2026-09-08'), { source: 'initial_live', detectedAt: iso('2026-09-14', '23:00') }]);
    expect(p.startAt).toBe('20:00');
    expect(p.lastRecordedAt).toBe('23:00');
  });
  it('supplements new detector dates with old recording dates at low precision', () => {
    const p = predict([opening('2026-09-08')], recordingFallbackEvents([{ startedAt: iso('2026-09-01', '20:00') }]));
    expect(p.kind).toBe('next');
    expect(p.basedOnDays).toBe(2);
    expect(p.timeGranularity).toBe('approximate');
    expect(p.likelihood).toBe('low');
  });
  it('does not duplicate recording and detector evidence on one date', () => {
    const p = predict([opening('2026-09-08')], recordingFallbackEvents([{ startedAt: iso('2026-09-08', '20:05') }]));
    expect(p.kind).toBe('observation');
    expect(p.sampleCount).toBe(1);
  });
  it('de-duplicates repeated platform start times', () => {
    const p = predict([...Array.from({ length: 20 }, () => opening('2026-09-08')), opening('2026-09-01')]);
    expect(p.sampleCount).toBe(2);
    expect(p.startAt).toBe('20:00');
  });
  it('caps per-date weight even when one date has many distinct nearby detections', () => {
    const events = ['2026-07-28', '2026-08-04', '2026-08-11', '2026-08-18', '2026-08-25', '2026-09-01'].map((d) => opening(d));
    events.push(...Array.from({ length: 12 }, (_, i) => opening('2026-09-08', `21:${String(i).padStart(2, '0')}`)));
    const p = predict(events);
    expect(p.startAt).toBe('20:00');
  });
  it('retains the full uncertainty of a six-hour offline-to-live interval', () => {
    const p = predict(
      ['2026-09-01', '2026-09-08'].map((d) => ({ source: 'transition', lowerBoundAt: iso(d, '16:00'), detectedAt: iso(d, '22:00') })),
    );
    expect([p.windowStart, p.windowEnd]).toEqual(['16:00', '22:00']);
    expect(p.likelihood).toBe('low');
  });
  it('does not guess opening clocks from checks separated by more than six hours', () => {
    const p = predict(
      ['2026-09-01', '2026-09-08'].map((d) => ({ source: 'transition', lowerBoundAt: iso(d, '08:00'), detectedAt: iso(d, '22:00') })),
    );
    expect(p.kind).toBe('observation');
  });
});
