import { http } from './client';
import type { DirectoryValidation, Settings, SettingsInput } from '../types/settings';

export async function fetchSettings(): Promise<Settings> {
  const { data } = await http.get<{ settings: Settings }>('/settings');
  return data.settings;
}

export async function updateSettings(input: SettingsInput): Promise<Settings> {
  const { data } = await http.put<{ settings: Settings }>('/settings', input);
  return data.settings;
}

export async function validateDirectory(directory: string): Promise<DirectoryValidation> {
  const { data } = await http.post<DirectoryValidation>('/settings/validate-directory', { directory });
  return data;
}

export async function testSmtp(): Promise<void> {
  await http.post('/settings/test-smtp');
}
