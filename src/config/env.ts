import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PREFIX: z.string().default('/api/v1'),
  DATABASE_URL: z.string().default('postgresql://healthuser:healthpassword@localhost:5432/myhealthapp_dev?schema=public'),
  AUTH_PROVIDER: z.enum(['mock', 'supabase', 'node-internal']).default('mock'),
  JWT_SECRET: z.string().min(16).default('dev-insecure-jwt-secret-replace-in-production-min-32-chars-long'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  CLIENT_URL: z.string().default('http://localhost:8081'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Safe console error without PHI
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

/**
 * Validates that production environments fail closed if insecure defaults or mock providers are configured.
 * Does NOT print secret values or connection strings in error messages.
 */
export function validateProductionConfig(config: typeof env = env): void {
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
    config.DATABASE_URL.includes('localhost:5432')
  ) {
    violations.push('DATABASE_URL cannot use default development credentials or local development host in production.');
  }

  // 4. Validate storage configuration
  const storageProvider = process.env.STORAGE_PROVIDER;
  const storageEndpoint = process.env.STORAGE_ENDPOINT;
  const storageBucket = process.env.STORAGE_BUCKET;
  const storageAccessKey = process.env.STORAGE_ACCESS_KEY;
  const storageSecretKey = process.env.STORAGE_SECRET_KEY;

  if (storageProvider === 'memory') {
    if (process.env.ALLOW_EPHEMERAL_STORAGE !== 'true') {
      violations.push('STORAGE_PROVIDER cannot be set to "memory" in production. Persistent S3-compatible storage is required (or set ALLOW_EPHEMERAL_STORAGE=true for beta testing).');
    }
  } else {
    if (!storageBucket || storageBucket.trim() === '') {
      violations.push('STORAGE_BUCKET is required in production when using S3 storage.');
    }

    if (
      !storageAccessKey ||
      storageAccessKey === 'minioadmin' ||
      !storageSecretKey ||
      storageSecretKey === 'minioadminpassword'
    ) {
      violations.push('Storage credentials cannot use default development credentials in production.');
    }

    if (!storageEndpoint || storageEndpoint.includes('localhost:9000')) {
      violations.push('STORAGE_ENDPOINT cannot use local development MinIO in production.');
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

