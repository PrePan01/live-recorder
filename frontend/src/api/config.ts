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
  const { data } = await http.post<{ ok: boolean; directory: string | null }>('/settings/pick-directory');
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