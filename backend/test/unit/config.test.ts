import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_DISK_GUARD, DEFAULT_RETRY } from '../../src/config/defaults.ts';
import { validateSettings } from '../../src/config/schema.ts';
import { AppError, httpStatusFor } from '../../src/types/error.ts';

describe('config defaults', () => {
  it('matches frozen review defaults', () => {
    expect(DEFAULT_RETRY.delaysSeconds).toEqual([5, 15, 45]);
    expect(DEFAULT_RETRY.maxAttempts).toBe(3);
    expect(DEFAULT_DISK_GUARD.minFreeBytes).toBe(20 * 1024 * 1024 * 1024);
    expect(DEFAULT_DISK_GUARD.minFreePercent).toBe(10);
    expect(DEFAULT_SETTINGS.maxConcurrentRecordings).toBe(2);
    expect(DEFAULT_SETTINGS.checkIntervalSec).toEqual({ default: 60, bilibili: 60, douyin: 120 });
    expect(DEFAULT_SETTINGS.dedupeWindowMinutes).toBe(30);
  });

  it('validates a complete settings object', () => {
    const settings = validateSettings({ ...DEFAULT_SETTINGS, recordingDirectory: '/tmp/recordings' });
    expect(settings.recordingDirectory).toBe('/tmp/recordings');
  });

  it('rejects missing recording directory', () => {
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, recordingDirectory: '' })).toThrowError(
      AppError,
    );
  });
});

describe('error code mapping', () => {
  it('maps request-error codes to frozen HTTP statuses', () => {
    expect(httpStatusFor('ROOM_LINK_INVALID')).toBe(422);
    expect(httpStatusFor('ROOM_LINK_DUPLICATE')).toBe(409);
    expect(httpStatusFor('DISK_SPACE_INSUFFICIENT')).toBe(409);
    expect(httpStatusFor('CONCURRENT_LIMIT_REACHED')).toBe(409);
    expect(httpStatusFor('SMTP_SEND_FAILED')).toBe(502);
    expect(httpStatusFor('SERVICE_UNAVAILABLE')).toBe(503);
    expect(httpStatusFor('CONFIG_LOAD_FAILED')).toBe(500);
  });

  it('serializes the unified error envelope', () => {
    const err = new AppError('PREVIEW_NOT_RECORDING', '当前未在录制，无法预览', { roomId: 'room_x' });
    const obj = err.toObject();
    expect(obj.code).toBe('PREVIEW_NOT_RECORDING');
    expect(obj.retryable).toBe(false);
    expect(obj.recordingId).toBeNull();
    expect(typeof obj.occurredAt).toBe('string');
  });
});
