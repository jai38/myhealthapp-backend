import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PREFIX: z.string().default('/api/v1'),
  DATABASE_URL: z.string().default('postgresql://healthuser:healthpassword@localhost:5433/myhealthapp_dev?schema=public'),
  AUTH_PROVIDER: z.enum(['mock', 'supabase', 'node-internal']).default(
    process.env.NODE_ENV === 'production' ? 'node-internal' : 'mock'
  ),
  JWT_SECRET: z.string().min(16).default('dev-insecure-jwt-secret-replace-in-production-min-32-chars-long'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  CLIENT_URL: z.string().default('http://localhost:8081'),
  GEMINI_API_KEY: z.string().optional(),
  AI_EXTRACTION_PROVIDER: z.string().default('auto'),
  AI_PROVIDER_APPROVED: z.string().default('false').transform((v) => v === 'true'),
  // 'ses' sends through Amazon SES using the task role; 'memory' keeps mail in an in-process outbox (local/tests).
  EMAIL_PROVIDER: z.enum(['memory', 'ses']).default('memory'),
  // Must be an SES-verified sender. No default in production so a placeholder address is never used.
  EMAIL_FROM: z.string().optional(),
  SES_REGION: z.string().optional(),
  // 'inline' runs extraction inside the API process (local and tests). 'sqs' hands it to the separate worker.
  EXTRACTION_MODE: z.enum(['inline', 'sqs']).default('inline'),
  EXTRACTION_JOBS_QUEUE_URL: z.string().optional(),
  EXTRACTION_RESULTS_QUEUE_URL: z.string().optional(),
  // Per-process Prisma pool size. Production defaults to 5 (see getPrismaClient); unset elsewhere.
  DB_CONNECTION_LIMIT: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : parseInt(v, 10)))
    .refine((v) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= 50), {
      message: 'DB_CONNECTION_LIMIT must be an integer between 1 and 50',
    }),
  // Base URL of the web/app client used in emailed links. Falls back to CLIENT_URL (never '*').
  APP_BASE_URL: z.string().optional(),
  // Temporary: set to false until the app has verification screens (Phase 5).
  EMAIL_VERIFICATION_REQUIRED: z.string().default('true').transform((v) => v !== 'false'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Safe console error without PHI
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

const LOCAL_ENDPOINT_PATTERN = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i;

/**
 * Validates that production environments fail closed if insecure defaults or mock providers are configured.
 * Does NOT print secret values or connection strings in error messages.
 */
export function validateProductionConfig(
  config: typeof env = env,
  processEnv: Record<string, string | undefined> = process.env,
): void {
  if (config.NODE_ENV !== 'production') {
    return;
  }

  const violations: string[] = [];

  // 1. Refuse mock authentication in production
  if (config.AUTH_PROVIDER === 'mock') {
    violations.push('AUTH_PROVIDER cannot be set to "mock" in production. Secure authentication must be configured.');
  }

  // 2. Refuse development-only secrets
  if (
    !config.JWT_SECRET ||
    config.JWT_SECRET.length < 32 ||
    config.JWT_SECRET.includes('dev-insecure') ||
    config.JWT_SECRET.includes('replace-in-production')
  ) {
    violations.push('JWT_SECRET must be at least 32 characters and cannot use development default placeholders.');
  }

  // 3. Refuse development-only database credentials / localhost in production
  if (
    !config.DATABASE_URL ||
    config.DATABASE_URL.includes('healthpassword') ||
    /@(localhost|127\.0\.0\.1)[:/]/.test(config.DATABASE_URL)
  ) {
    violations.push('DATABASE_URL cannot use default development credentials or local development host in production.');
  }

  // 4. Validate storage configuration
  const storageProvider = processEnv.STORAGE_PROVIDER;
  const storageEndpoint = processEnv.STORAGE_ENDPOINT?.trim();
  const storageBucket = processEnv.STORAGE_BUCKET;
  const storageAccessKey = processEnv.STORAGE_ACCESS_KEY?.trim();
  const storageSecretKey = processEnv.STORAGE_SECRET_KEY?.trim();

  if (storageProvider === 'memory') {
    if (processEnv.ALLOW_EPHEMERAL_STORAGE !== 'true') {
      violations.push('STORAGE_PROVIDER cannot be set to "memory" in production. Persistent S3-compatible storage is required (or set ALLOW_EPHEMERAL_STORAGE=true for beta testing).');
    }
  } else {
    if (!storageBucket || storageBucket.trim() === '') {
      violations.push('STORAGE_BUCKET is required in production when using S3 storage.');
    }

    // The endpoint is optional: unset means real AWS S3 reached through the task role.
    // When it is set (a non-AWS S3-compatible store), it must be a remote https URL.
    if (storageEndpoint) {
      if (LOCAL_ENDPOINT_PATTERN.test(storageEndpoint) || !storageEndpoint.startsWith('https://')) {
        violations.push('STORAGE_ENDPOINT must be a remote https URL in production; local or plain-http endpoints are refused.');
      }
    }

    const hasAccessKey = Boolean(storageAccessKey);
    const hasSecretKey = Boolean(storageSecretKey);
    if (hasAccessKey !== hasSecretKey) {
      violations.push('STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY must be set together, or both left unset to use the task role.');
    }
    if (storageAccessKey === 'minioadmin' || storageSecretKey === 'minioadminpassword') {
      violations.push('Storage credentials cannot use default development credentials in production.');
    }
    if (storageEndpoint && !(hasAccessKey && hasSecretKey)) {
      violations.push('Storage credentials are required in production when STORAGE_ENDPOINT is set.');
    }
  }

  // 5. AI provider approval check
  if (config.AI_EXTRACTION_PROVIDER === 'gemini' && !config.AI_PROVIDER_APPROVED) {
    violations.push('AI_PROVIDER_APPROVED must be true when using Gemini as extraction provider in production. Set to true only after verifying BAA/DPA/zero-training terms with provider.');
  }

  if (config.EMAIL_VERIFICATION_REQUIRED !== false) {
    // 6. A real sender is required for auth flows
    if (config.EMAIL_PROVIDER !== 'ses') {
      violations.push('EMAIL_PROVIDER must be "ses" in production for password reset and email verification emails.');
    }
    if (!config.EMAIL_FROM || config.EMAIL_FROM.trim() === '') {
      violations.push('EMAIL_FROM must be set to an SES-verified sender in production.');
    }

    // 7. Emailed links need a concrete base URL (CLIENT_URL may be '*' for CORS)
    const linkBase = config.APP_BASE_URL ?? config.CLIENT_URL;
    if (!linkBase || linkBase.trim() === '' || linkBase.includes('*') || linkBase.includes('localhost')) {
      violations.push('APP_BASE_URL must be a concrete https URL in production (used in verification and password reset links).');
    }
  }

  // 8. Queue-backed extraction needs both queue URLs, and they must be real AWS queues
  if (config.EXTRACTION_MODE === 'sqs') {
    for (const [name, value] of [
      ['EXTRACTION_JOBS_QUEUE_URL', config.EXTRACTION_JOBS_QUEUE_URL],
      ['EXTRACTION_RESULTS_QUEUE_URL', config.EXTRACTION_RESULTS_QUEUE_URL],
    ] as const) {
      if (!value || !/^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\//.test(value)) {
        violations.push(`${name} must be an https Amazon SQS queue URL when EXTRACTION_MODE is "sqs".`);
      }
    }
  }

  if (violations.length > 0) {
    // Print configuration variable names only - NEVER values, secrets, or patient data
    const message = `[FATAL] Production startup refused due to security configuration violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`;
    throw new Error(message);
  }
}

// Automatically enforce production config validation if NODE_ENV is production
if (env.NODE_ENV === 'production') {
  validateProductionConfig(env);
}

