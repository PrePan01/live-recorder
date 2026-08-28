import { createRequire } from 'node:module';
import type { MailConfig } from '../types/index.js';
import type { Mailer, MailMessage } from './mailer.js';

const require = createRequire(import.meta.url);

interface MailTransport {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

type TransportFactory = (config: MailConfig, password: string) => MailTransport;

function defaultTransportFactory(config: MailConfig, password: string): MailTransport {
  const nodemailer = require('nodemailer') as {
    createTransport(opts: Record<string, unknown>): MailTransport;
  };
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.username ? { auth: { user: config.username, pass: password } } : {}),
  });
}

/** 真实 SMTP 发送（nodemailer）；密码由 SecretStore 注入，不入 config。 */
export class SmtpMailer implements Mailer {
  constructor(
    private getPassword: () => Promise<string | null>,
    private transportFactory: TransportFactory = defaultTransportFactory,
  ) {}

  async send(config: MailConfig, message: MailMessage): Promise<void> {
    const password = (await this.getPassword()) ?? '';
    const transport = this.transportFactory(config, password);
    await transport.sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text });
  }
}