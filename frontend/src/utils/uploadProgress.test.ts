import { describe, expect, it } from 'vitest';
import { formatUploadWait, cloudFinalizingText, uploadPhaseLabel, uploadPhaseText } from './uploadProgress';

const NOW = new Date('2026-09-06T03:00:00.000Z').getTime();

describe('formatUploadWait', () => {
  it('5 秒内 → 刚刚', () => {
    expect(formatUploadWait(new Date(NOW - 2000).toISOString(), NOW)).toBe('刚刚');
  });

  it('60 秒内 → N 秒', () => {
    expect(formatUploadWait(new Date(NOW - 30_000).toISOString(), NOW)).toBe('30 秒');
  });

  it('分钟级 → N 分钟', () => {
    expect(formatUploadWait(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 分钟');
  });

  it('10 分钟以上 → N 分钟（不显示分秒）', () => {
    expect(formatUploadWait(new Date(NOW - 10 * 60_000 - 30_000).toISOString(), NOW)).toBe('10 分钟');
  });

  it('60 分钟以上 → 仍显示分钟', () => {
    expect(formatUploadWait(new Date(NOW - 160 * 60_000).toISOString(), NOW)).toBe('160 分钟');
  });
});

describe('cloudFinalizingText', () => {
  it('45 秒内 → 等待 OpenList 确认', () => {
    const t = cloudFinalizingText(new Date(NOW - 10_000).toISOString(), NOW);
    expect(t).toContain('等待 OpenList 确认');
  });

  it('3 分钟内 → 正在确认远端文件', () => {
    const t = cloudFinalizingText(new Date(NOW - 2 * 60_000).toISOString(), NOW);
    expect(t).toContain('正在确认远端文件');
  });

  it('超 3 分钟 → 无需手动重传', () => {
    const t = cloudFinalizingText(new Date(NOW - 5 * 60_000).toISOString(), NOW);
    expect(t).toContain('无需手动重传');
  });
});

describe('uploadPhaseLabel', () => {
  it('阶段标签映射', () => {
    expect(uploadPhaseLabel('preparing', 0)).toBe('准备上传');
    expect(uploadPhaseLabel('sending', 20)).toBe('发送文件');
    expect(uploadPhaseLabel('cloud', 60)).toBe('云端写入');
    expect(uploadPhaseLabel('verifying', 99)).toBe('最终确认');
    expect(uploadPhaseLabel(null, 100)).toBe('最终确认');
    expect(uploadPhaseLabel('resuming', 50)).toBe('恢复进度');
  });
});

describe('uploadPhaseText', () => {
  it('verifying/progress>=99 → 收尾确认文案（基于 updatedAt 计时）', () => {
    const t = uploadPhaseText('verifying', 99, new Date(NOW - 10_000).toISOString(), NOW);
    expect(t).toContain('等待 OpenList 确认');
  });

  it('progress<50 → 发送文件', () => {
    expect(uploadPhaseText('sending', 20, new Date(NOW).toISOString(), NOW)).toContain('发送');
  });

  it('progress>=50 → 云端写入', () => {
    expect(uploadPhaseText('cloud', 60, new Date(NOW).toISOString(), NOW)).toContain('写入');
  });
});