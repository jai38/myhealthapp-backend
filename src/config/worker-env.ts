/**
 * Configuration for the extraction worker process.
 *
 * Deliberately separate from env.ts: that module requires database settings and loads .env, and the
 * worker must have neither. Reads plain environment values and never prints them.
 */

type EnvLike = Record<string, string | undefined>;

export interface WorkerConfig {
  nodeEnv: string;
  jobsQueueUrl: string;
  resultsQueueUrl: string;
  geminiApiKey?: string;
  geminiModel?: string;
  processingTimeoutMs: number;
}

const SQS_URL_PATTERN = /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\//;
const LOCAL_PATTERN = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i;
/** Value infra/data.tf gives each secret parameter until the owner sets the real one. */
const PARAMETER_PLACEHOLDER = 'REPLACE_ME_BY_OWNER';

/** Names that give database or session access. The worker must never be started with them in production. */
export const FORBIDDEN_WORKER_VARIABLES = [
  'DATABASE_URL',
  'JWT_SECRET',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
] as const;

/** Throws, naming variables only and never values, when the worker would start unsafely. */
export function validateWorkerConfig(processEnv: EnvLike = process.env): WorkerConfig {
  const nodeEnv = processEnv.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const violations: string[] = [];

  const jobsQueueUrl = processEnv.EXTRACTION_JOBS_QUEUE_URL?.trim() ?? '';
  const resultsQueueUrl = processEnv.EXTRACTION_RESULTS_QUEUE_URL?.trim() ?? '';

  if (!jobsQueueUrl) violations.push('EXTRACTION_JOBS_QUEUE_URL is required.');
  if (!resultsQueueUrl) violations.push('EXTRACTION_RESULTS_QUEUE_URL is required.');
  if (isProduction) {
    if (jobsQueueUrl && !SQS_URL_PATTERN.test(jobsQueueUrl)) {
      violations.push('EXTRACTION_JOBS_QUEUE_URL must be an https Amazon SQS queue URL in production.');
    }
    if (resultsQueueUrl && !SQS_URL_PATTERN.test(resultsQueueUrl)) {
      violations.push('EXTRACTION_RESULTS_QUEUE_URL must be an https Amazon SQS queue URL in production.');
    }

    for (const name of FORBIDDEN_WORKER_VARIABLES) {
      if (processEnv[name] !== undefined && processEnv[name] !== '') {
        violations.push(`${name} must not be set on the extraction worker.`);
      }
    }

    if (!processEnv.STORAGE_BUCKET || processEnv.STORAGE_BUCKET.trim() === '') {
      violations.push('STORAGE_BUCKET is required in production.');
    }
    const endpoint = processEnv.STORAGE_ENDPOINT?.trim();
    if (endpoint && (LOCAL_PATTERN.test(endpoint) || !endpoint.startsWith('https://'))) {
      violations.push('STORAGE_ENDPOINT must be unset or a remote https URL in production.');
    }

    // The worker is where document content reaches the AI provider, so the approval gate lives here.
    const geminiKey = processEnv.GEMINI_API_KEY?.trim() ?? '';
    if (!geminiKey) {
      violations.push('GEMINI_API_KEY is required in production.');
    } else if (geminiKey === PARAMETER_PLACEHOLDER) {
      // Terraform creates the parameter with this value; fail at start rather than on every extraction.
      violations.push('GEMINI_API_KEY is still the Parameter Store placeholder. Set the real key (infra README step 7).');
    }
    if (processEnv.AI_PROVIDER_APPROVED !== 'true') {
      violations.push(
        'AI_PROVIDER_APPROVED must be true in production. Set to true only after verifying BAA/DPA/zero-training terms with the provider.',
      );
    }
  }

  const timeout = parseInt(processEnv.WORKER_PROCESSING_TIMEOUT_MS ?? '60000', 10);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    violations.push('WORKER_PROCESSING_TIMEOUT_MS must be between 1000 and 300000.');
  }

  if (violations.length > 0) {
    throw new Error(
      `[FATAL] Worker startup refused due to configuration violations:\n${violations.map((v) => `  - ${v}`).join('\n')}`,
    );
  }

  return {
    nodeEnv,
    jobsQueueUrl,
    resultsQueueUrl,
    geminiApiKey: processEnv.GEMINI_API_KEY?.trim() || undefined,
    geminiModel: processEnv.GEMINI_MODEL?.trim() || undefined,
    processingTimeoutMs: timeout,
  };
}
