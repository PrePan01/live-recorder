import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.ts';
import {
  currentSchemaVersion,
  ensureCriticalColumns,
  runMigrations,
} from '../../src/db/migrations/index.ts';
import { RecordingRepository } from '../../src/db/repositories/recording.repo.ts';

/**
 * P0 事故复刻（rec_01M3NY370…「no such column: gap_count」）：
 * 迁移 42 曾就地加列不升版本号，跑过中间版的库 schema_version 已标 42 但缺 gap_count，
 * runMigrations 跳过 42 → 启动链写列即崩。本组断言三层防御逐层兜住：
 * ①迁移 43 条件补列 ②启动自愈（ensureCriticalColumns）③写点防御（写 gap_count 前自愈）。
 */
function incidentDb() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  // 复刻事故现场：库已应用 42（版本标到 42），但 gap_count 列从未加上（42 批就地加列前的中间版形状）。
  db.exec('ALTER TABLE recordings DROP COLUMN gap_count');
  db.prepare('DELETE FROM schema_version WHERE version = ?').run(43);
  const cols = (
    db.prepare(`SELECT name FROM pragma_table_info('recordings')`).all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(cols).not.toContain('gap_count');
  return db;
}

function hasGapCount(db: ReturnType<typeof openDatabase>): boolean {
  const cols = (
    db.prepare(`SELECT name FROM pragma_table_info('recordings')`).all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  return cols.includes('gap_count');
}

describe('迁移 43 条件补列（gap_count 缺列事故修复）', () => {
  it('① 事故库（已标 42 无 gap_count）重跑迁移 → 43 补列 → 录制可建、缺口可写', () => {
    const db = incidentDb();
    const repo = new RecordingRepository(db);
    const rec = repo.create({
      roomId: 'r1',
      roomName: '测试房',
      platform: 'bilibili',
      streamSessionId: null,
      streamTitle: 't',
    });

    // 事故现场机制复刻：当时 insertGap 的计数 SQL 直接撞「no such column」
    // （修复后 insertGap 写前自愈，故用裸 SQL 还原当时崩溃点）。
    expect(() =>
      db
        .prepare(
          'UPDATE recordings SET gap_count = COALESCE(gap_count, 0) + 1 WHERE id = ?',
        )
        .run(rec.id),
    ).toThrow(/no such column/i);

    // ① 迁移 43 条件补列
    expect(runMigrations(db)).toBe(1);
    expect(hasGapCount(db)).toBe(true);
    expect(currentSchemaVersion(db)).toBe(45);
    // 幂等：再跑不补不报
    expect(runMigrations(db)).toBe(0);

    // 录制启动成功 + gap 可写
    const rec2 = repo.create({
      roomId: 'r1',
      roomName: '测试房',
      platform: 'bilibili',
      streamSessionId: null,
      streamTitle: 't2',
    });
    repo.insertGap({
      recordingId: rec2.id,
      startedAt: '2026-09-29T06:38:00.000Z',
      endedAt: '2026-09-29T06:38:14.000Z',
      missingMs: 14000,
      kind: 'stream_disconnect',
    });
    expect(repo.get(rec2.id)?.gapCount).toBe(1);
  });

  it('② 启动自愈：版本已标 43 仍缺列的库，开库核对即补', () => {
    const db = incidentDb();
    // 更坏的现场：连 43 都标过了（未来再被就地改的库），迁移层也救不了 → 启动自愈层兜底
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(43);
    expect(runMigrations(db)).toBe(0);
    expect(hasGapCount(db)).toBe(false);

    ensureCriticalColumns(db); // buildServices 开库后无条件调用的同一函数
    expect(hasGapCount(db)).toBe(true);
    // 同批就地补过的列全集一并自愈
    for (const col of [
      'integrity_state',
      'integrity_attempts',
      'integrity_last_attempt',
      'integrity_error',
    ]) {
      const cols = (
        db.prepare(`SELECT name FROM pragma_table_info('recordings')`).all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      expect(cols).toContain(col);
    }
  });

  it('③ 写点防御：不动迁移/自愈，insertGap 与 update(gapCount) 写前自行补列', () => {
    const db = incidentDb();
    const repo = new RecordingRepository(db);
    const rec = repo.create({
      roomId: 'r1',
      roomName: '测试房',
      platform: 'bilibili',
      streamSessionId: null,
      streamTitle: 't',
    });

    // 不跑任何迁移/自愈，直接走缺口写入（录制恢复后第一份数据的结算路径）
    repo.insertGap({
      recordingId: rec.id,
      startedAt: '2026-09-29T06:37:00.000Z',
      endedAt: '2026-09-29T06:37:14.000Z',
      missingMs: 14000,
      kind: 'stream_disconnect',
    });
    expect(hasGapCount(db)).toBe(true);
    expect(repo.get(rec.id)?.gapCount).toBe(1);

    repo.update(rec.id, { gapCount: 2 });
    expect(repo.get(rec.id)?.gapCount).toBe(2);
  });

  it('④ update() 五字段映射回归：integrity* 与 gapCount 真落库（verify 反复重入队根因）', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const repo = new RecordingRepository(db);
    const rec = repo.create({
      roomId: 'r1',
      roomName: '测试房',
      platform: 'bilibili',
      streamSessionId: null,
      streamTitle: 't',
    });
    repo.update(rec.id, {
      integrityState: 'failed',
      integrityAttempts: 3,
      integrityLastAttempt: '2026-09-29T07:00:00.000Z',
      integrityError: '文件损坏',
    });
    const got = repo.get(rec.id)!;
    expect(got.integrityState).toBe('failed');
    expect(got.integrityAttempts).toBe(3);
    expect(got.integrityLastAttempt).toBe('2026-09-29T07:00:00.000Z');
    expect(got.integrityError).toBe('文件损坏');
    // 终态落库后，启动扫描的 stale 判定不再把 failed 判为待补跑（反复重入队根因）。
    const state = (got as { integrityState?: string | null }).integrityState;
    const stale =
      state == null ||
      state === 'pending' ||
      state === 'queued' ||
      state === 'verifying';
    expect(stale).toBe(false);
  });
});
