import { describe, it, expect } from 'vitest';
import { validateProductionConfig } from '../src/config/env.js';
import { resolveS3ClientConfig } from '../src/modules/storage/storage-keys.js';
import { resolveDatabaseUrl } from '../src/modules/persistence/database.js';
import {
  SesEmailSender,
  MemoryEmailSender,
} from '../src/modules/auth/email-service.js';

const goodConfig = {
  PORT: 4000,
  NODE_ENV: 'production',
  API_PREFIX: '/api/v1',
  DATABASE_URL: 'postgresql://produser:securepassword@prod-db.internal:5432/myhealthapp_prod',
  AUTH_PROVIDER: 'node-internal',
  JWT_SECRET: 'a-very-long-production-jwt-secret-with-plenty-of-entropy-32chars',
  JWT_EXPIRES_IN: '15m',
  CLIENT_URL: 'https://api.example.org',
  APP_BASE_URL: 'https://app.example.org',
  EMAIL_PROVIDER: 'ses',
  EMAIL_FROM: 'no-reply@example.org',
  EMAIL_VERIFICATION_REQUIRED: true,
  EXTRACTION_MODE: 'inline',
  AI_EXTRACTION_PROVIDER: 'auto',
  AI_PROVIDER_APPROVED: false,
} as any;

const goodStorage = { STORAGE_BUCKET: 'bucket-name' };

describe('production config guard: storage', () => {
  it('accepts AWS S3 with no endpoint and no keys (task role)', () => {
    expect(() => validateProductionConfig(goodConfig, goodStorage)).not.toThrow();
  });

  it('still accepts a remote https S3-compatible endpoint with real keys', () => {
    expect(() =>
      validateProductionConfig(goodConfig, {
        ...goodStorage,
        STORAGE_ENDPOINT: 'https://storage.example.org/s3',
        STORAGE_ACCESS_KEY: 'real-access-key',
        STORAGE_SECRET_KEY: 'real-secret-key',
      }),
    ).not.toThrow();
  });

  it.each([
    'http://localhost:9000',
    'https://localhost:9000',
    'https://127.0.0.1:9000',
    'http://0.0.0.0:9000',
    'http://storage.example.org',
  ])('rejects the local or plain-http endpoint %s', (endpoint) => {
    expect(() =>
      validateProductionConfig(goodConfig, {
        ...goodStorage,
        STORAGE_ENDPOINT: endpoint,
        STORAGE_ACCESS_KEY: 'real-access-key',
        STORAGE_SECRET_KEY: 'real-secret-key',
      }),
    ).toThrow(/STORAGE_ENDPOINT must be a remote https URL/);
  });

  it('rejects the default development keys', () => {
    expect(() =>
      validateProductionConfig(goodConfig, {
        ...goodStorage,
        STORAGE_ACCESS_KEY: 'minioadmin',
        STORAGE_SECRET_KEY: 'minioadminpassword',
      }),
    ).toThrow(/default development credentials/);
  });

  it('rejects one key without the other', () => {
    expect(() =>
      validateProductionConfig(goodConfig, { ...goodStorage, STORAGE_ACCESS_KEY: 'only-one' }),
    ).toThrow(/must be set together/);
  });

  it('requires keys when a custom endpoint is set', () => {
    expect(() =>
      validateProductionConfig(goodConfig, { ...goodStorage, STORAGE_ENDPOINT: 'https://storage.example.org/s3' }),
    ).toThrow(/credentials are required/);
  });

  it('requires a bucket', () => {
    expect(() => validateProductionConfig(goodConfig, {})).toThrow(/STORAGE_BUCKET is required/);
  });

  it('keeps refusing memory storage in production', () => {
    expect(() => validateProductionConfig(goodConfig, { STORAGE_PROVIDER: 'memory' })).toThrow(/STORAGE_PROVIDER cannot be set to "memory"/);
  });
});

describe('production config guard: email and queues', () => {
  it('requires SES and a sender when verification is on', () => {
    expect(() => validateProductionConfig({ ...goodConfig, EMAIL_PROVIDER: 'memory' }, goodStorage)).toThrow(
      /EMAIL_PROVIDER must be "ses"/,
    );
    expect(() => validateProductionConfig({ ...goodConfig, EMAIL_FROM: undefined }, goodStorage)).toThrow(
      /EMAIL_FROM must be set/,
    );
  });

  it('does not require email while verification is switched off (Render path)', () => {
    expect(() =>
      validateProductionConfig(
        { ...goodConfig, EMAIL_PROVIDER: 'memory', EMAIL_FROM: undefined, EMAIL_VERIFICATION_REQUIRED: false },
        goodStorage,
      ),
    ).not.toThrow();
  });

  it('requires real SQS queue URLs in queue mode', () => {
    expect(() => validateProductionConfig({ ...goodConfig, EXTRACTION_MODE: 'sqs' }, goodStorage)).toThrow(
      /EXTRACTION_JOBS_QUEUE_URL must be an https Amazon SQS queue URL/,
    );
    expect(() =>
      validateProductionConfig(
        {
          ...goodConfig,
          EXTRACTION_MODE: 'sqs',
          EXTRACTION_JOBS_QUEUE_URL: 'http://localhost:9324/jobs',
          EXTRACTION_RESULTS_QUEUE_URL: 'https://sqs.ap-south-1.amazonaws.com/123456789012/results',
        },
        goodStorage,
      ),
    ).toThrow(/EXTRACTION_JOBS_QUEUE_URL/);
    expect(() =>
      validateProductionConfig(
        {
          ...goodConfig,
          EXTRACTION_MODE: 'sqs',
          EXTRACTION_JOBS_QUEUE_URL: 'https://sqs.ap-south-1.amazonaws.com/123456789012/jobs',
          EXTRACTION_RESULTS_QUEUE_URL: 'https://sqs.ap-south-1.amazonaws.com/123456789012/results',
        },
        goodStorage,
      ),
    ).not.toThrow();
  });

  it('keeps the existing database, secret and mock-auth refusals', () => {
    expect(() => validateProductionConfig({ ...goodConfig, AUTH_PROVIDER: 'mock' }, goodStorage)).toThrow(/mock/);
    expect(() =>
      validateProductionConfig({ ...goodConfig, DATABASE_URL: 'postgresql://a:b@localhost:5432/db' }, goodStorage),
    ).toThrow(/DATABASE_URL/);
    expect(() => validateProductionConfig({ ...goodConfig, JWT_SECRET: 'short' }, goodStorage)).toThrow(/JWT_SECRET/);
  });

  it('keeps requiring the AI approval flag for Gemini', () => {
    expect(() =>
      validateProductionConfig({ ...goodConfig, AI_EXTRACTION_PROVIDER: 'gemini' }, goodStorage),
    ).toThrow(/AI_PROVIDER_APPROVED/);
  });
});

describe('S3 client configuration', () => {
  it('uses real AWS with the task role in production when no endpoint or keys are set', () => {
    const { clientConfig, bucket } = resolveS3ClientConfig(undefined, {
      NODE_ENV: 'production',
      STORAGE_BUCKET: 'bucket-name',
      STORAGE_REGION: 'ap-south-1',
    });
    expect(bucket).toBe('bucket-name');
    expect(clientConfig.endpoint).toBeUndefined();
    expect(clientConfig.forcePathStyle).toBeUndefined();
    expect(clientConfig.credentials).toBeUndefined();
    expect(clientConfig.region).toBe('ap-south-1');
  });

  it('keeps the local MinIO defaults outside production', () => {
    const { clientConfig } = resolveS3ClientConfig(undefined, { NODE_ENV: 'development' });
    expect(clientConfig.endpoint).toBe('http://localhost:9000');
    expect(clientConfig.forcePathStyle).toBe(true);
    expect(clientConfig.credentials).toEqual({ accessKeyId: 'minioadmin', secretAccessKey: 'minioadminpassword' });
    expect(clientConfig.region).toBe('us-east-1');
  });

  it('honours an explicit endpoint and keys in production', () => {
    const { clientConfig } = resolveS3ClientConfig(undefined, {
      NODE_ENV: 'production',
      STORAGE_ENDPOINT: 'https://storage.example.org/s3',
      STORAGE_ACCESS_KEY: 'a',
      STORAGE_SECRET_KEY: 'b',
    });
    expect(clientConfig.endpoint).toBe('https://storage.example.org/s3');
    expect(clientConfig.forcePathStyle).toBe(true);
    expect(clientConfig.credentials).toEqual({ accessKeyId: 'a', secretAccessKey: 'b' });
  });
});

describe('database connection limit', () => {
  const url = 'postgresql://u:p@host:5432/db?schema=public';

  it('defaults to 5 connections per task in production', () => {
    expect(resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: url })).toBe(`${url}&connection_limit=5`);
  });

  it('uses DB_CONNECTION_LIMIT when set', () => {
    expect(resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: url, DB_CONNECTION_LIMIT: '3' })).toBe(
      `${url}&connection_limit=3`,
    );
  });

  it('adds the first query parameter with a question mark', () => {
    expect(resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@h/db' })).toBe(
      'postgresql://u:p@h/db?connection_limit=5',
    );
  });

  it('leaves a limit already present in the URL alone', () => {
    const withLimit = `${url}&connection_limit=9`;
    expect(resolveDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: withLimit })).toBe(withLimit);
  });

  it('changes nothing for local and test runs unless a limit is set', () => {
    expect(resolveDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: url })).toBeUndefined();
    expect(resolveDatabaseUrl({ NODE_ENV: 'development', DATABASE_URL: url })).toBeUndefined();
    expect(resolveDatabaseUrl({ NODE_ENV: 'production' })).toBeUndefined();
  });
});

describe('SES email sender', () => {
  it('sends a verification email with the link and no extra recipients', async () => {
    const sent: any[] = [];
    const sender = new SesEmailSender('no-reply@example.org', {
      send: async (command) => {
        sent.push((command as any).input);
        return {};
      },
    });

    await sender.sendVerificationEmail('patient@example.com', 'tok_abc 123');

    expect(sent).toHaveLength(1);
    expect(sent[0].FromEmailAddress).toBe('no-reply@example.org');
    expect(sent[0].Destination.ToAddresses).toEqual(['patient@example.com']);
    expect(sent[0].Content.Simple.Body.Html.Data).toContain('verify-email?token=tok_abc%20123');
  });

  it('sends a password reset email', async () => {
    const sent: any[] = [];
    const sender = new SesEmailSender('no-reply@example.org', {
      send: async (command) => {
        sent.push((command as any).input);
        return {};
      },
    });
    await sender.sendPasswordResetEmail('patient@example.com', 'tok_reset');
    expect(sent[0].Content.Simple.Body.Html.Data).toContain('reset-password?token=tok_reset');
  });

  it('does not leak the recipient or the SDK message when SES rejects the send', async () => {
    const sender = new SesEmailSender('no-reply@example.org', {
      send: async () => {
        const err = new Error('Email address patient@example.com is not verified');
        err.name = 'MessageRejected';
        throw err;
      },
    });

    await expect(sender.sendVerificationEmail('patient@example.com', 'tok')).rejects.toThrow(
      'Email provider rejected the message (MessageRejected)',
    );
  });

  it('refuses to build without a sender address', () => {
    expect(() => new SesEmailSender('')).toThrow(/EMAIL_FROM/);
  });

  it('keeps the in-memory outbox for local use', async () => {
    const outbox = new MemoryEmailSender();
    await outbox.sendPasswordResetEmail('a@example.com', 't');
    expect(outbox.outbox).toHaveLength(1);
  });
});
