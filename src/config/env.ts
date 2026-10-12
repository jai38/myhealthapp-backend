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
