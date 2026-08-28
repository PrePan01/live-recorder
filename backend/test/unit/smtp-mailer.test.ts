import { describe, expect, it } from 'vitest';
import { SmtpMailer } from '../../src/mail/smtp-mailer.js';
import type { MailConfig } from '../../src/types/index.js';

const MAIL: MailConfig = { enabled: true, host: 'smtp.x.com', port: 465, secure: true, username: 'u', from: 'f', recipients: ['a@b.c'] };

describe('SmtpMailer', () => {
  it('injects the SecretStore password into the transport and sends', async () => {
    let transportOptions: { config: MailConfig; password: string } | null = null;
    let sentMessage: Record<string, unknown> | null = null;
    const mailer = new SmtpMailer(
      async () => 'secret-pass',
      (config, password) => {
        transportOptions = { config, password };
        return { sendMail: async (m) => { sentMessage = m; } };
      },
    );
    await mailer.send(MAIL, { to: ['a@b.c'], subject: '标题', text: '正文' });
    expect(transportOptions?.password).toBe('secret-pass');
    expect(transportOptions?.config.host).toBe('smtp.x.com');
    expect(sentMessage).toMatchObject({ from: 'f', to: ['a@b.c'], subject: '标题', text: '正文' });
  });

  it('passes empty password when secret store returns null', async () => {
    let password: string | null = null;
    const mailer = new SmtpMailer(
      async () => null,
      (_c, p) => {
        password = p;
        return { sendMail: async () => {} };
      },
    );
    await mailer.send(MAIL, { to: ['a'], subject: 's', text: 't' });
    expect(password).toBe('');
  });

  it('propagates SMTP send failures', async () => {
    const mailer = new SmtpMailer(
      async () => 'p',
      () => ({
        sendMail: async () => {
          throw new Error('SMTP 5xx');
        },
      }),
    );
    await expect(mailer.send(MAIL, { to: ['a'], subject: 's', text: 't' })).rejects.toThrow('SMTP 5xx');
  });
});