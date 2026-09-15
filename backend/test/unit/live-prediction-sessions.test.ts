import { describe, expect, it } from 'vitest';
import { calculateLivePrediction, type DetectedLiveEvent } from '../../src/core/live-prediction.js';
const iso = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
const opening = (day: string, time: string): DetectedLiveEvent => ({
  source: 'platform',
  detectedAt: iso(day, time),
  platformStartedAt: iso(day, time),
});
const days = ['2026-08-25', '2026-09-01', '2026-09-08'];
const paired = () => days.flatMap((day) => [opening(day, '18:00'), opening(day, '20:00')]);
function predict(when: string, events: DetectedLiveEvent[]) {
  return calculateLivePrediction({ roomId: 'sessions', events, now: new Date(when).getTime(), generatedAt: new Date(when).toISOString() });
}
describe('recurring daily opening sessions', () => {
  it('recognizes separate sessions from narrow offline-to-live polling intervals', () => {
    const events = days.flatMap((day) => [
      { source: 'transition' as const, lowerBoundAt: iso(day, '17:59'), detectedAt: iso(day, '18:01') },
      { source: 'transition' as const, lowerBoundAt: iso(day, '19:59'), detectedAt: iso(day, '20:01') },
    ]);
    const p = predict('2026-09-15T19:00:00', events);
    expect(p.slots).toHaveLength(2);
    expect(p.startAt).toBe('20:00');
  });
  it('splits recurring 18:00 and 20:00 openings into separate windows', () => {
    const p = predict('2026-09-15T17:00:00', paired());
    expect(p.startAt).toBe('18:00');
    expect(p.slots.map((s) => [s.startAt, s.endAt])).toEqual([
      ['17:45', '18:15'],
      ['19:45', '20:15'],
    ]);
  });
  it('selects the remaining 20:00 opening after the 18:00 window has passed', () => {
    const p = predict('2026-09-15T19:00:00', paired());
    expect(p.nextDate).toBe('2026-09-15');
    expect(p.startAt).toBe('20:00');
  });
  it('selects the next earlier session on future dates even if the later session has more history', () => {
    const events = paired().concat(['2026-08-04', '2026-08-11', '2026-08-18'].map((day) => opening(day, '20:00')));
    const p = predict('2026-09-15T21:00:00', events);
    expect(p.nextDate).toBe('2026-09-22');
    expect(p.startAt).toBe('18:00');
  });
  it('skips a proven opening today even before its display window ends', () => {
    const p = predict('2026-09-15T18:10:00', [...paired(), opening('2026-09-15', '18:00')]);
    expect(p.startAt).toBe('20:00');
    expect(p.nextDate).toBe('2026-09-15');
  });
  it('handles three recurring close sessions', () => {
    const events = days.flatMap((day) => ['18:00', '19:00', '20:00'].map((time) => opening(day, time)));
    const p = predict('2026-09-15T18:45:00', events);
    expect(p.slots).toHaveLength(3);
    expect(p.startAt).toBe('19:00');
  });
  it('retains small timing variations within each recurring session', () => {
    const events = [
      opening(days[0]!, '17:55'),
      opening(days[0]!, '19:55'),
      opening(days[1]!, '18:05'),
      opening(days[1]!, '20:05'),
      opening(days[2]!, '18:00'),
      opening(days[2]!, '20:00'),
    ];
    const p = predict('2026-09-15T19:00:00', events);
    expect(p.slots).toHaveLength(2);
    expect(p.startAt).toBe('20:00');
  });
  it('allows two independent paired dates but keeps every displayed possibility low', () => {
    const p = predict(
      '2026-09-15T19:00:00',
      days.slice(1).flatMap((day) => [opening(day, '18:00'), opening(day, '20:00')]),
    );
    expect(p.slots).toHaveLength(2);
    expect(p.startAt).toBe('20:00');
    expect(p.slots.every((s) => s.likelihood === 'low')).toBe(true);
  });
  it('does not treat one unusual second opening as a recurring daily session', () => {
    const p = predict('2026-09-15T17:00:00', [
      opening(days[0]!, '18:00'),
      opening(days[1]!, '18:00'),
      opening(days[2]!, '18:00'),
      opening(days[2]!, '20:00'),
    ]);
    expect(p.slots).toHaveLength(1);
  });
  it('does not inflate recurrence by counting many events on one paired day', () => {
    const events = [
      opening(days[0]!, '18:00'),
      ...Array.from({ length: 10 }, () => [opening(days[2]!, '18:00'), opening(days[2]!, '20:00')]).flat(),
    ];
    expect(predict('2026-09-15T17:00:00', events).slots).toHaveLength(1);
  });
  it('does not split minute-scale repeated detections into separate sessions', () => {
    const events = days.flatMap((day) => ['18:00', '18:05', '18:10'].map((time) => opening(day, time)));
    expect(predict('2026-09-15T17:00:00', events).slots).toHaveLength(1);
  });
  it('does not infer multiple sessions from alternating start times on different days', () => {
    const events = [
      opening('2026-08-18', '18:00'),
      opening('2026-08-25', '18:00'),
      opening('2026-09-01', '20:00'),
      opening('2026-09-08', '20:00'),
    ];
    expect(predict('2026-09-15T17:00:00', events).slots).toHaveLength(1);
  });
  it('does not split wide polling intervals as if they were precise opening times', () => {
    const events = days.flatMap((day) => [
      { source: 'transition' as const, lowerBoundAt: iso(day, '17:00'), detectedAt: iso(day, '19:00') },
      { source: 'transition' as const, lowerBoundAt: iso(day, '19:00'), detectedAt: iso(day, '21:00') },
    ]);
    expect(predict('2026-09-15T17:00:00', events).slots).toHaveLength(1);
  });
  it('selects a future early-morning session belonging to yesterday across midnight', () => {
    const nextDays = ['2026-08-26', '2026-09-02', '2026-09-09'];
    const events = days.flatMap((day, index) => [opening(day, '23:00'), opening(nextDays[index]!, '00:30')]);
    const p = predict('2026-09-16T00:05:00', events);
    expect(p.slots).toHaveLength(2);
    expect(p.nextDate).toBe('2026-09-15');
    expect(p.startAt).toBe('次日 00:30');
    expect(p.startTimestamp).toBe(iso('2026-09-16', '00:30'));
  });
});
