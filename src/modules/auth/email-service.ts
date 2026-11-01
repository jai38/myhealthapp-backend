import { env } from '../../config/env.js';

/**
 * Transactional email for auth flows. Implementations must never log token values,
 * recipient addresses, or message bodies.
 */
export interface EmailSender {
  sendVerificationEmail(to: string, token: string): Promise<void>;
  sendPasswordResetEmail(to: string, token: string): Promise<void>;
}

function linkBase(): string {
  const base = env.APP_BASE_URL ?? env.CLIENT_URL;
  return base.replace(/\/+$/, '');
}

export function buildVerificationUrl(token: string): string {
  return `${linkBase()}/verify-email?token=${encodeURIComponent(token)}`;
}

export function buildPasswordResetUrl(token: string): string {
  return `${linkBase()}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Sends mail through the Resend REST API (no SDK dependency).
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string = env.EMAIL_FROM,
  ) {
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is required for ResendEmailSender');
    }
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.fromEmail, to: [to], subject, html }),
    });
    if (!res.ok) {
      // Status only: the body may echo the recipient address.
      throw new Error(`Email provider rejected the message (status ${res.status})`);
    }
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const url = buildVerificationUrl(token);
    await this.send(
      to,
      'Verify your email address',
      `<p>Welcome to My Health App. Verify your email address:</p><p><a href="${url}">Verify email</a></p><p>This link expires in 24 hours. If you did not create an account, ignore this email.</p>`,
    );
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const url = buildPasswordResetUrl(token);
    await this.send(
      to,
      'Reset your password',
      `<p>Use the link below to set a new password:</p><p><a href="${url}">Reset password</a></p><p>This link expires in 1 hour. If you did not request this, ignore this email.</p>`,
    );
  }
}

/**
 * In-memory outbox for tests and local development without an email provider.
 */
export class MemoryEmailSender implements EmailSender {
  readonly outbox: Array<{ to: string; kind: 'verification' | 'password-reset'; token: string }> = [];

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    this.outbox.push({ to, kind: 'verification', token });
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    this.outbox.push({ to, kind: 'password-reset', token });
  }
}

export function createEmailSender(): EmailSender {
  if (env.RESEND_API_KEY && env.RESEND_API_KEY.trim() !== '') {
    return new ResendEmailSender(env.RESEND_API_KEY);
  }
  return new MemoryEmailSender();
}