import { http } from './client';

export async function fetchNamingRule(): Promise<string> {
  const { data } = await http.get<{ namingRule: string }>('/settings/naming-rule');
  return data.namingRule;
}

export async function updateNamingRule(namingRule: string): Promise<string> {
  const { data } = await http.put<{ namingRule: string }>('/settings/naming-rule', { namingRule });
  return data.namingRule;
}

export async function previewNamingRule(namingRule: string): Promise<string> {
  const { data } = await http.post<{ example: string }>('/settings/naming-rule/preview', { namingRule });
  return data.example;
}

export const NAMING_VARS = ['room', 'platform', 'date', 'time', 'quality', 'roomId'];

export const NAMING_PRESETS = [
  { value: '{room}_{date}_{time}', label: '主播名_日期_时间' },
  { value: '{platform}/{room}/{date}_{time}', label: '平台/主播名/日期_时间（目录）' },
  { value: '{room}_{quality}_{date}_{time}', label: '主播名_清晰度_日期_时间' },
  { value: '{room}_{date}_{time}_{roomId}', label: '主播名_日期_时间_ID' },
];