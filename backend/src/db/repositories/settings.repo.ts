import type { DB } from '../connection.js';
import type { AppSettings, MailConfig } from '../../types/index.js';
import { DEFAULT_PIPELINE_CONFIG } from '../../types/settings.js';

export class SettingsRepository {
  constructor(private db: DB) {}

  getRaw(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setRaw(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** 密码不入库：仅存 mail 非敏感字段；password 单独走 SecretStore。 */
  load(): AppSettings | null {
    const raw = this.getRaw('settings');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as AppSettings & {
        autoRecord?: boolean;
        mail?: MailConfig & { password?: string };
      };
      if (parsed.mail) delete (parsed.mail as { password?: string }).password;
      // v4 之前已保存的设置没有 autoRecord 字段，历史行为是自动录制默认开启。
      // 新的首次使用默认关闭只适用于完全没有 settings 记录的用户，不能倒改旧用户。
      if (parsed.autoRecord === undefined) parsed.autoRecord = true;
      // 旧“录制完成后转 MP4”无感迁入管线：只打开格式转换，其他后处理步骤保持关闭，
      // 以复刻旧行为而不在升级后意外导出封面/音频或归档。
      if (parsed.recordingFormat === 'mp4_after' && parsed.pipeline?.outputFormat === undefined) {
        parsed.pipeline = {
          ...DEFAULT_PIPELINE_CONFIG,
          ...parsed.pipeline,
          enabled: true,
          verify: false,
          exportCover: false,
          exportAudio: false,
          outputFormat: 'mp4',
        };
        this.setRaw('settings', JSON.stringify(parsed));
      } else if (parsed.pipeline && parsed.pipeline.outputFormat === undefined) {
        parsed.pipeline = { ...DEFAULT_PIPELINE_CONFIG, ...parsed.pipeline, outputFormat: 'source' };
        this.setRaw('settings', JSON.stringify(parsed));
      }
      return parsed;
    } catch {
      return null;
    }
  }

  save(settings: AppSettings & { mail?: Partial<MailConfig> }): void {
    const safe: AppSettings = {
      ...settings,
      mail: {
        ...settings.mail,
      } as MailConfig,
    };
    delete (safe.mail as { password?: string }).password;
    this.setRaw('settings', JSON.stringify(safe));
  }
}
