import type { MailConfig } from '../types/index.js';

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
}

export interface Mailer {
  send(config: MailConfig, message: MailMessage): Promise<void>;
}

export interface SentMail extends MailMessage {
  sentAt: string;
}

/** 记录发送历史的假 Mailer；failNext 可注入一次 SMTP 失败。 */
export class FakeMailer implements Mailer {
  readonly sent: SentMail[] = [];
  failNext = false;

  constructor(private clockIso: () => string = () => new Date().toISOString()) {}

  send(_config: MailConfig, message: MailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('SMTP send failed'));
    }
    this.sent.push({ ...message, sentAt: this.clockIso() });
    return Promise.resolve();
  }
}
