import type { DB } from '../connection.js';
import type { AppSettings, MailConfig } from '../../types/index.js';

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
      const parsed = JSON.parse(raw) as AppSettings & { mail?: MailConfig & { password?: string } };
      if (parsed.mail) delete (parsed.mail as { password?: string }).password;
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
