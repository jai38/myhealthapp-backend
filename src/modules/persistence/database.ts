import { PrismaClient } from '@prisma/client';

let prismaInstance: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
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
