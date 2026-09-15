import { describe, expect, it } from 'vitest';
import { calculateLivePrediction, type DetectedLiveEvent } from '../../src/core/live-prediction.js';
const opening = (day: string, time = '20:00'): DetectedLiveEvent => {
  const at = new Date(`${day}T${time}:00`).toISOString();
  return { source: 'platform', detectedAt: at, platformStartedAt: at };
};
const predict = (when: string, events: DetectedLiveEvent[]) => {
  const dates = new Set(events.map((e) => e.detectedAt.slice(0, 10)));
  const times = events.map((e) => Date.parse(e.detectedAt));
  const coverage = [];
  for (let at = Math.min(...times) + 86400000; at < Math.max(...times); at += 86400000) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (!dates.has(date))
      coverage.push({ startAt: new Date(at - 60 * 60000).toISOString(), endAt: new Date(at + 60 * 60000).toISOString() });
  }
  return calculateLivePrediction({
    roomId: 'habits',
    events,
    coverage,
    now: new Date(when).getTime(),
    generatedAt: new Date(when).toISOString(),
  });
};
describe('additional real-life habits', () => {
  it('predicts an every-other-day habit across different weekdays', () => {
    const p = predict(
      '2026-09-15T12:00:00',
      ['2026-09-08', '2026-09-10', '2026-09-12', '2026-09-14'].map((d) => opening(d)),
    );
    expect(p.basis).toBe('interval');
    expect(p.nextDate).toBe('2026-09-16');
    expect(p.likelihood).toBe('low');
  });
  it('keeps a variable two-to-three-day cadence low and exposes both dates', () => {
    const p = predict(
      '2026-09-15T12:00:00',
      ['2026-09-06', '2026-09-08', '2026-09-11', '2026-09-13'].map((d) => opening(d)),
    );
    expect(p.nextDate).toBe('2026-09-15');
    expect(p.nextDateEnd).toBe('2026-09-16');
    expect(p.probabilityKnown).toBe(false);
  });
  it('does not manufacture another cycle after a predicted cadence was missed', () => {
    const p = predict(
      '2026-09-19T12:00:00',
      ['2026-09-08', '2026-09-10', '2026-09-12', '2026-09-14'].map((d) => opening(d)),
    );
    expect(p.kind).toBe('typical');
    expect(p.nextDate).toBeNull();
  });
  it('does not mistake a weekly schedule for a new cadence model', () => {
    const p = predict(
      '2026-09-15T12:00:00',
      ['2026-08-18', '2026-08-25', '2026-09-01', '2026-09-08'].map((d) => opening(d)),
    );
    expect(p.basis).toBe('weekday');
  });
  it('skips an already opened single session while its window is still active', () => {
    const p = predict(
      '2026-09-15T20:10:00',
      ['2026-08-25', '2026-09-01', '2026-09-08', '2026-09-15'].map((d) => opening(d)),
    );
    expect(p.nextDate).toBe('2026-09-22');
  });
  it('retains old habits without inventing a dated return after a long pause', () => {
    const p = predict(
      '2026-09-15T12:00:00',
      ['2026-08-04', '2026-08-11', '2026-08-18'].map((d) => opening(d)),
    );
    expect(p.kind).toBe('typical');
    expect(p.likelihood).toBe('low');
    expect(p.typicalDayType).toBe('weekday');
  });
  it('distinguishes actual opening time from detection time', () => {
    expect(predict('2026-09-15T12:00:00', [opening('2026-09-14')]).lastRecordedQuality).toBe('platform');
    expect(
      predict('2026-09-15T12:00:00', [{ detectedAt: new Date('2026-09-14T20:00:00').toISOString(), source: 'initial_live' }])
        .lastRecordedQuality,
    ).toBe('initial_live');
  });
  it('adapts to a recurring one-hour shift without requiring a separate far-away cluster', () => {
    const events = ['2026-07-28', '2026-08-04', '2026-08-11', '2026-08-18'].map((d) => opening(d));
    events.push(...['2026-08-25', '2026-09-01', '2026-09-08'].map((d) => opening(d, '21:00')));
    expect(predict('2026-09-15T12:00:00', events).startAt).toBe('21:00');
  });
  it('uses the remaining day of a variable interval instead of repeating an expired date', () => {
    const p = predict(
      '2026-09-16T12:00:00',
      ['2026-09-06', '2026-09-08', '2026-09-11', '2026-09-13'].map((d) => opening(d)),
    );
    expect(p.nextDate).toBe('2026-09-16');
    expect(p.nextDateEnd).toBeNull();
    expect(p.likelihood).toBe('low');
  });
  it('keeps a first return after a long pause low despite a strong older pattern', () => {
    const p = predict(
      '2026-09-15T12:00:00',
      ['2026-07-21', '2026-07-28', '2026-08-04', '2026-08-11', '2026-08-18', '2026-09-14'].map((d) => opening(d)),
    );
    expect(p.kind).toBe('next');
    expect(p.confidence).toBe('low');
    expect(p.likelihood).toBe('low');
  });
  it('distinguishes a fortnightly opening from a weekly schedule', () => {
    const p = predict(
      '2026-09-15T12:00:00',
      ['2026-07-28', '2026-08-11', '2026-08-25', '2026-09-08'].map((d) => opening(d)),
    );
    expect(p.basis).toBe('interval');
    expect(p.nextDate).toBe('2026-09-22');
  });
});
