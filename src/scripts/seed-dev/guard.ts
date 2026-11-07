/**
 * The one gate between generated data and a database. Prod must never receive seeded data, so every
 * check here fails closed: a missing or unexpected value is a refusal, never a default.
 *
 * Accepted targets:
 *  - Local Docker Postgres (localhost / 127.0.0.1 / ::1), any schema.
 *  - A remote database only with `schema=dev` in DATABASE_URL, DEPLOYMENT_ENV=dev, and (when files are
 *    uploaded) a bucket whose name marks it as dev.
 * Prod uses schema=public, DEPLOYMENT_ENV=prod and the prod bucket, so it fails three separate checks.
 */

export interface GuardInput {
  /** Must be exactly "dev" (from --target). */
  target: string | undefined;
  databaseUrl: string | undefined;
  nodeEnv: string | undefined;
  deploymentEnv: string | undefined;
  storageBucket: string | undefined;
  /** STORAGE_ENDPOINT, when set (MinIO locally; unset on AWS). */
  storageEndpoint?: string | undefined;
  withFiles: boolean;
}

export interface GuardResult {
  local: boolean;
  schema: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const DEV_SCHEMA = 'dev';

export class SeedRefused extends Error {
  constructor(reason: string) {
    super(`Seed refused: ${reason}`);
    this.name = 'SeedRefused';
  }
}

export function assertDevSeedTarget(input: GuardInput): GuardResult {
  if (input.target !== 'dev') {
    throw new SeedRefused('pass --target dev. Generated data only ever goes to dev.');
  }
  if ((input.deploymentEnv ?? '').trim().toLowerCase() === 'prod') {
    throw new SeedRefused('DEPLOYMENT_ENV is prod.');
  }
  if (!input.databaseUrl) {
    throw new SeedRefused('DATABASE_URL is not set.');
  }

  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw new SeedRefused('DATABASE_URL is not a valid URL.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new SeedRefused('DATABASE_URL is not PostgreSQL.');
  }

  const schema = url.searchParams.get('schema') ?? 'public';
  const local = LOCAL_HOSTS.has(url.hostname.toLowerCase());

  if (local && input.withFiles) {
    // A local database pairs with local MinIO. A remote endpoint here (an old hosted bucket in .env)
    // would put synthetic files somewhere they do not belong.
    const endpoint = (input.storageEndpoint ?? '').trim();
    if (endpoint) {
      let host = '';
      try {
        host = new URL(endpoint).hostname.toLowerCase();
      } catch {
        throw new SeedRefused('STORAGE_ENDPOINT is not a valid URL.');
      }
      if (!LOCAL_HOSTS.has(host)) {
        throw new SeedRefused('a local database must use local MinIO storage (STORAGE_ENDPOINT on localhost), or pass --no-files.');
      }
    }
  }

  if (!local) {
    if (schema !== DEV_SCHEMA) {
      throw new SeedRefused(`a remote database must use schema=${DEV_SCHEMA} (found "${schema}"). Prod uses public.`);
    }
    if (input.deploymentEnv !== 'dev') {
      throw new SeedRefused('a remote database needs DEPLOYMENT_ENV=dev.');
    }
    if (input.withFiles && !/(^|-)dev(-|$)/.test(input.storageBucket ?? '')) {
      throw new SeedRefused('STORAGE_BUCKET must be the dev bucket (its name contains "-dev-"), or pass --no-files.');
    }
  }

  if (input.nodeEnv === 'production' && input.deploymentEnv !== 'dev') {
    throw new SeedRefused('NODE_ENV is production without DEPLOYMENT_ENV=dev.');
  }

  return { local, schema };
}
