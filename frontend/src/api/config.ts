import { http } from './client';
import type {
  BrowseDirectoriesResult,
  ExportConfig,
  ImportConfigInput,
  ImportResult,
} from '../types/config';

export async function browseDirectories(path?: string): Promise<BrowseDirectoriesResult> {
  const { data } = await http.get<BrowseDirectoriesResult>('/settings/browse-directories', {
    params: path ? { path } : undefined,
  });
  return data;
}

export async function pickDirectory(): Promise<string | null> {
  // 原生对话框等待用户选择或取消，不受普通请求的 10 秒超时限制。
  const { data } = await http.post<{ ok: boolean; directory: string | null }>('/settings/pick-directory', undefined, { timeout: 0 });
  return data.directory;
}

export async function exportConfig(): Promise<ExportConfig> {
  const { data } = await http.get<{ config: ExportConfig }>('/config/export');
  return data.config;
}

export async function importConfig(input: ImportConfigInput): Promise<ImportResult> {
  const { data } = await http.post<ImportResult>('/config/import', { config: input });
  return data;
}
