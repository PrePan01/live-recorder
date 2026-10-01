import { describe, expect, it } from 'vitest';
import {
  failureCategory,
  humanizeFailure,
  withReasonCategory,
  writeFailure,
} from '../../src/core/recording-failure.js';
import type { ErrorObject } from '../../src/types/index.js';

/** failureReason 落库契约：message 人话、technicalMessage 原文、reasonCategory 分类。 */

function err(code: ErrorObject['code'], message: string): ErrorObject {
  return {
    code,
    message,
    roomId: 'r1',
    recordingId: 'rec1',
    occurredAt: '2026-09-29T08:00:00.000Z',
    retryable: false,
  };
}

describe('录制失败原因分类（reasonCategory 落库）', () => {
  it('分类枚举映射：磁盘/写入/启动/断流超时/网络各归各类', () => {
    expect(failureCategory('DISK_SPACE_INSUFFICIENT')).toBe('disk_error');
    expect(failureCategory('RECORDING_DIRECTORY_INVALID')).toBe('disk_error');
    expect(failureCategory('RECORDING_WRITE_FAILED')).toBe('write_failed');
    expect(failureCategory('RECORDING_WRITE_SLOW')).toBe('write_failed');
    expect(failureCategory('RECORDING_START_FAILED')).toBe('start_failed');
    expect(failureCategory('RECORDING_START_TIMEOUT')).toBe('start_failed');
    expect(failureCategory('STREAM_DISCONNECTED_RECONNECT_EXHAUSTED')).toBe(
      'stream_timeout',
    );
    expect(failureCategory('NETWORK_UNAVAILABLE')).toBe('network');
  });

  it('技术原文不直接给用户：内部错误主文案换人话，原文进 details', () => {
    const out = humanizeFailure(
      err('RECORDING_START_FAILED', 'no such column: gap_count'),
    );
    expect(out.message).toBe(
      '软件内部数据错误，建议重启应用；若反复出现请导出诊断包反馈',
    );
    expect(out.message).not.toContain('no such column');
    // 原文进 details 备查（FE 历史页直显用）。
    expect(
      (out.toObject().details as { technicalMessage?: string })
        .technicalMessage,
    ).toBe('no such column: gap_count');
    expect(
      (out.toObject().details as { reasonCategory?: string }).reasonCategory,
    ).toBe('start_failed');
  });

  it('写盘类失败文案已具体时不叠加，reasonCategory 照带', () => {
    const out = humanizeFailure(
      err('RECORDING_WRITE_FAILED', '写入录像文件失败（EIO）'),
    );
    expect(out.message).toBe('写入录像文件失败（EIO）');
    expect(
      (out.toObject().details as { reasonCategory?: string }).reasonCategory,
    ).toBe('write_failed');
  });

  it('withReasonCategory 富化不丢原有 details', () => {
    const enriched = withReasonCategory({
      ...err('RECORDING_WRITE_SLOW', '磁盘写入过慢'),
      details: { cause: 'slow io' },
    });
    expect(enriched.details).toEqual({
      cause: 'slow io',
      reasonCategory: 'write_failed',
    });
  });

  it('EIO 只归因为写入失败，不误称存储设备已断开', () => {
    const failure = writeFailure(new Error('EIO: i/o error, write'));
    expect(failure.message).toContain('写入失败（EIO）');
    expect(failure.message).not.toContain('已断开');
  });
});
