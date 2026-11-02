import { PrismaClient } from '@prisma/client';

let prismaInstance: PrismaClient | null = null;

/** Default per-task pool in production. RDS db.t4g.micro allows about 80 connections in total. */
export const DEFAULT_PRODUCTION_CONNECTION_LIMIT = 5;

/**
 * Returns the connection URL with a Prisma `connection_limit` applied.
 * A limit already present in the URL wins, so an operator can override it per task.
 * Returns undefined when no limit applies (local and test keep Prisma's own default).
 */
export function resolveDatabaseUrl(
  processEnv: Record<string, string | undefined> = process.env
): string | undefined {
  const url = processEnv.DATABASE_URL;
  if (!url) return undefined;

  const configured = processEnv.DB_CONNECTION_LIMIT?.trim();
  const limit = configured
    ? parseInt(configured, 10)
    : processEnv.NODE_ENV === 'production'
      ? DEFAULT_PRODUCTION_CONNECTION_LIMIT
      : undefined;

  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return undefined;
  if (/[?&]connection_limit=/.test(url)) return url;

  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${limit}`;
}

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    const datasourceUrl = resolveDatabaseUrl();
    prismaInstance = new PrismaClient({
      ...(datasourceUrl ? { datasourceUrl } : {}),
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return prismaInstance;
}

export async function checkDatabaseHealth(): Promise<{ isConnected: boolean; error?: string }> {
  try {
    const client = getPrismaClient();
    await client.$queryRaw`SELECT 1`;
    return { isConnected: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Database connection failed';
    return { isConnected: false, error: msg };
  }
}
