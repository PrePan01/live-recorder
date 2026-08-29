import { http } from './client';

export interface SmtpPreset {
  id: string;
  name: string;
  host: string;
  port: number;
  secure: boolean;
}

export interface EmailConfig {
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  from: string | null;
  recipients: string[];
  enabled: boolean;
  passwordSet: boolean;
  provider: string | null;
}

export async function fetchEmailPresets(): Promise<SmtpPreset[]> {
  const { data } = await http.get<{ presets: SmtpPreset[] }>('/settings/email/presets');
  return data.presets;
}

export async function fetchEmail(): Promise<EmailConfig> {
  const { data } = await http.get<{ email: EmailConfig }>('/settings/email');
  return data.email;
}

export async function updateEmail(
  input: Partial<Omit<EmailConfig, 'passwordSet' | 'provider'>> & { password?: string },
): Promise<EmailConfig> {
  const { data } = await http.put<{ email: EmailConfig }>('/settings/email', input);
  return data.email;
}

export async function testEmail(): Promise<{ ok: boolean }> {
  const { data } = await http.post<{ ok: boolean }>('/settings/email/test');
  return data;
}