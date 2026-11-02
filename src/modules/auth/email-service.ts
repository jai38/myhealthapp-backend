import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
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

/** Minimal client surface so tests can substitute a fake without the network. */
export interface SesLikeClient {
  send(command: SendEmailCommand): Promise<unknown>;
}

/**
 * Sends mail through Amazon SES (SESv2). Credentials come from the task role; none are configured here.
 */
export class SesEmailSender implements EmailSender {
  private readonly client: SesLikeClient;

  constructor(
    private readonly fromEmail: string,
    client?: SesLikeClient,
    region: string | undefined = env.SES_REGION || process.env.AWS_REGION || 'ap-south-1',
  ) {
    if (!fromEmail || fromEmail.trim() === '') {
      throw new Error('EMAIL_FROM is required for SesEmailSender');
    }
    this.client = client ?? new SESv2Client({ region });
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.fromEmail,
          Destination: { ToAddresses: [to] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: { Html: { Data: html, Charset: 'UTF-8' } },
            },
          },
        }),
      );
    } catch (err: unknown) {
      // Error name only: the SDK message can echo the recipient address.
      const name = err instanceof Error ? err.name : 'UnknownError';
      throw new Error(`Email provider rejected the message (${name})`);
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
  if (env.EMAIL_PROVIDER === 'ses') {
    return new SesEmailSender(env.EMAIL_FROM ?? '');
  }
  return new MemoryEmailSender();
}
