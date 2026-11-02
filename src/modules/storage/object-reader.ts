import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { MAX_FILE_SIZE_BYTES } from './file-parser-validator.js';
import { validateStorageKey, readStreamBounded, resolveS3ClientConfig, S3ConnectionOptions } from './storage-keys.js';

/** Read-only access to stored documents. This is all the extraction worker gets. */
export interface DocumentReader {
  getObjectBuffer(storageKey: string, patientProfileId: string): Promise<Buffer>;
}

/**
 * Reads documents from S3 with GetObject only. It needs no database: the storage key must match
 * documents/<patientProfileId>/<uuid> for the patient named in the job message, and the read is
 * bounded to the upload size limit.
 */
export class S3DocumentReader implements DocumentReader {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options?: S3ConnectionOptions, processEnv: Record<string, string | undefined> = process.env) {
    const resolved = resolveS3ClientConfig(options, processEnv);
    this.bucket = resolved.bucket;
    this.client = new S3Client(resolved.clientConfig);
  }

  async getObjectBuffer(storageKey: string, patientProfileId: string): Promise<Buffer> {
    validateStorageKey(storageKey, patientProfileId);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    if (!response.Body) {
      throw new Error('Document not found in storage');
    }
    return readStreamBounded(response.Body, MAX_FILE_SIZE_BYTES);
  }
}
