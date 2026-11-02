import { S3ClientConfig } from '@aws-sdk/client-s3';

/**
 * Validates that storageKey strictly follows the format:
 * documents/<patientProfileId>/<uuid>
 * Prevents path traversal, forged tenant IDs, and arbitrary keys.
 */
export function validateStorageKey(storageKey: string, expectedPatientProfileId: string): void {
  if (!storageKey || typeof storageKey !== 'string') {
    throw new Error('Invalid storage key');
  }

  if (!expectedPatientProfileId) {
    throw new Error('Patient profile ID is required for storage key validation');
  }

  const parts = storageKey.split('/');
  if (parts.length !== 3 || parts[0] !== 'documents' || parts[1] !== expectedPatientProfileId) {
    throw new Error('Forbidden: Storage key does not belong to the authenticated patient profile');
  }

  // Validate UUID segment
  const keyUuid = parts[2];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!keyUuid || !uuidRegex.test(keyUuid)) {
    throw new Error('Forbidden: Storage key has an invalid format');
  }
}

/**
 * Reads an object stream safely with a strict byte limit.
 * Prevents memory exhaustion attacks from unbounded objects.
 */
export async function readStreamBounded(stream: any, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Object stream exceeded maximum size of ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks, totalBytes);
}


export interface S3ConnectionOptions {
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * Builds the S3 client configuration.
 *
 * - Endpoint set (options or STORAGE_ENDPOINT): S3-compatible store, path-style addressing.
 * - Endpoint unset in production: real AWS S3 with the default endpoint, virtual-host addressing.
 * - Credentials: explicit keys when both are given; otherwise, in production, the default provider chain
 *   (the ECS task role). Non-production keeps the local MinIO defaults so dev and tests behave as before.
 */
export function resolveS3ClientConfig(
  options?: S3ConnectionOptions,
  processEnv: Record<string, string | undefined> = process.env
): { bucket: string; clientConfig: S3ClientConfig } {
  const isProduction = processEnv.NODE_ENV === 'production';
  const endpointSetting = (options?.endpoint || processEnv.STORAGE_ENDPOINT || '').trim();
  const endpoint = endpointSetting || (isProduction ? undefined : 'http://localhost:9000');
  const region = options?.region || processEnv.STORAGE_REGION || (isProduction ? processEnv.AWS_REGION || 'ap-south-1' : 'us-east-1');
  const bucket = options?.bucket || processEnv.STORAGE_BUCKET || 'myhealthapp-documents';

  const explicitKey = options?.accessKeyId || processEnv.STORAGE_ACCESS_KEY;
  const explicitSecret = options?.secretAccessKey || processEnv.STORAGE_SECRET_KEY;

  const clientConfig: S3ClientConfig = { region };
  if (endpoint) {
    clientConfig.endpoint = endpoint;
    clientConfig.forcePathStyle = true; // Required for MinIO and local S3 emulators
  }

  if (explicitKey && explicitSecret) {
    clientConfig.credentials = { accessKeyId: explicitKey, secretAccessKey: explicitSecret };
  } else if (!isProduction) {
    clientConfig.credentials = {
      accessKeyId: explicitKey || 'minioadmin',
      secretAccessKey: explicitSecret || 'minioadminpassword',
    };
  }
  // Production without keys: leave credentials unset so the SDK uses the task role.

  return { bucket, clientConfig };
}

