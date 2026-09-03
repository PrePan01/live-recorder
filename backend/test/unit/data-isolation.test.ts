import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDevelopmentPathIsIsolated,
  productionDataDir,
} from '../../src/core/services.js';

describe('development data isolation', () => {
  it('rejects the production database and state directory in development', () => {
    const production = productionDataDir();
    expect(() => assertDevelopmentPathIsIsolated(
      path.join(production, 'live-recorder.db'),
      '开发环境数据库',
      'development',
    )).toThrow(/指向生产数据目录/);
    expect(() => assertDevelopmentPathIsIsolated(
      path.join(production, 'state'),
      '开发环境状态目录',
      'development',
    )).toThrow(/指向生产数据目录/);
  });

  it('allows an isolated development path and leaves production mode configurable', () => {
    expect(() => assertDevelopmentPathIsIsolated('/tmp/live-recorder-dev/live-recorder.db', '开发环境数据库', 'development')).not.toThrow();
    expect(() => assertDevelopmentPathIsIsolated(path.join(productionDataDir(), 'live-recorder.db'), '数据库', 'production')).not.toThrow();
  });
});
