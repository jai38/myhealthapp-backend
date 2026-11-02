import crypto from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  validateStorageKey,
  readStreamBounded,
  resolveS3ClientConfig,
} from './storage-keys.js';
import {
  validateDocumentContent,
  DocumentValidationResult,
  MAX_FILE_SIZE_BYTES,
} from './file-parser-validator.js';
import {
  UploadIntentRepository,
  InMemoryUploadIntentRepository,
} from '../persistence/repositories.js';

export interface StorageObjectMetadata {
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256Checksum: string;
  patientProfileId: string;
  uploadedAt: Date;
  validationDetails?: DocumentValidationResult;
}

export interface UploadIntentRequest {
  patientProfileId: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
}

export interface UploadIntentResponse {
  storageKey: string;
  uploadSignedUrl: string;
  expiresInSeconds: number;
}

export interface StorageProvider {
  readonly providerType: 's3' | 'memory';
  createUploadIntent(request: UploadIntentRequest): Promise<UploadIntentResponse>;
  verifyAndFinalizeUpload(
    storageKey: string,
    patientProfileId: string,
    claimedMimeType: string,
    expectedChecksum?: string
  ): Promise<StorageObjectMetadata>;
  getDownloadSignedUrl(storageKey: string, patientProfileId: string): Promise<string>;
  getObjectBuffer(storageKey: string, patientProfileId: string): Promise<Buffer>;
  deleteObject(storageKey: string, patientProfileId: string): Promise<void>;
  deleteByPrefix(prefix: string, patientProfileId: string): Promise<void>;
  checkObjectExists(storageKey: string, patientProfileId: string): Promise<{ exists: boolean; sizeBytes?: number }>;
  putObject(storageKey: string, patientProfileId: string, buffer: Buffer, mimeType: string): Promise<void>;
}

export { validateStorageKey, resolveS3ClientConfig } from './storage-keys.js';
export type { S3ConnectionOptions } from './storage-keys.js';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

/**
 * A bulk-delete prefix must be exactly "documents/<patientProfileId>/" for the caller's own profile.
 * Rejects empty or path-like profile ids so the prefix can never widen to another tenant.
 */
function assertOwnPrefix(prefix: string, patientProfileId: string): void {
  if (!patientProfileId || /[\/\\.]/.test(patientProfileId) || prefix !== `documents/${patientProfileId}/`) {
    throw new Error('Forbidden: Prefix does not belong to the authenticated patient profile');
  }
}

/**
 * Production S3 / MinIO Storage Provider.
 * Connects to S3-compatible private object storage using AWS SDK v3.
 * Uses durable PostgreSQL repository for upload intents.
 * Enforces declared file sizes, bounded streaming, cryptographic integrity, and deep parser verification.
 */
export class S3StorageProvider implements StorageProvider {
  readonly providerType = 's3';
  private s3Client: S3Client;
  private bucket: string;

  constructor(
    private readonly uploadIntentRepo: UploadIntentRepository,
    options?: {
      endpoint?: string;
      region?: string;
      bucket?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      useSsl?: boolean;
    }
  ) {
    const resolved = resolveS3ClientConfig(options);
    this.bucket = resolved.bucket;
    this.s3Client = new S3Client(resolved.clientConfig);
  }

  async createUploadIntent(request: UploadIntentRequest): Promise<UploadIntentResponse> {
    if (!ALLOWED_MIME_TYPES.has(request.mimeType)) {
      throw new Error(`Unsupported MIME type: ${request.mimeType}. Only JPEG, PNG, and PDF are allowed.`);
    }

    if (request.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File size ${request.fileSizeBytes} bytes exceeds 15MB limit.`);
    }

    if (request.fileSizeBytes <= 0) {
      throw new Error('File size must be greater than 0 bytes.');
    }

    const randomUuid = crypto.randomUUID();
    const storageKey = `documents/${request.patientProfileId}/${randomUuid}`;
    const expiresInSeconds = 900; // 15 minutes TTL
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    // Persist intent in durable repository
    await this.uploadIntentRepo.createIntent({
      patientProfileId: request.patientProfileId,
      storageKey,
      originalFilename: request.filename,
      mimeType: request.mimeType,
      declaredSizeBytes: request.fileSizeBytes,
      expiresAt,
    });

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
    });

    const uploadSignedUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: expiresInSeconds,
    });

    return {
      storageKey,
      uploadSignedUrl,
      expiresInSeconds,
    };
  }

  async verifyAndFinalizeUpload(
    storageKey: string,
    patientProfileId: string,
    claimedMimeType: string,
    expectedChecksum?: string
  ): Promise<StorageObjectMetadata> {
    validateStorageKey(storageKey, patientProfileId);

    // Concurrency-safe lock acquisition
    const lockResult = await this.uploadIntentRepo.acquireVerificationLock(storageKey, patientProfileId);
    if (!lockResult.success) {
      const reason = lockResult.reason || 'Upload intent is invalid or could not be verified';
      throw new Error(reason);
    }

    const intent = lockResult.intent!;

    try {
      if (claimedMimeType && claimedMimeType !== intent.mimeType) {
        await this.uploadIntentRepo.markRejected(
          storageKey,
          patientProfileId,
          `Claimed MIME type ${claimedMimeType} does not match intent MIME type ${intent.mimeType}`
        );
        throw new Error(`Claimed MIME type ${claimedMimeType} does not match intent MIME type ${intent.mimeType}`);
      }

      // 1. Inspect stored object via HeadObject before downloading bytes
      let headResponse;
      try {
        const headCommand = new HeadObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
        });
        headResponse = await this.s3Client.send(headCommand);
      } catch {
        // Object not yet uploaded or transient S3 error: release lock back to PENDING for retry!
        await this.uploadIntentRepo.releaseVerificationLock(storageKey, patientProfileId);
        throw new Error('Uploaded object not found in private storage. Client must upload bytes before confirming.');
      }

      const actualSizeBytes = headResponse.ContentLength;
      if (actualSizeBytes == null || actualSizeBytes === 0) {
        await this.uploadIntentRepo.markRejected(storageKey, patientProfileId, 'Uploaded object is empty (0 bytes)');
        throw new Error('Uploaded object is empty (0 bytes). Upload must fail closed.');
      }

      if (actualSizeBytes > MAX_FILE_SIZE_BYTES) {
        await this.uploadIntentRepo.markRejected(storageKey, patientProfileId, `File size ${actualSizeBytes} bytes exceeds 15MB limit`);
        throw new Error(`File size ${actualSizeBytes} bytes exceeds 15MB limit`);
      }

      // Compare actual stored object size with declared size in intent
      if (intent.declaredSizeBytes !== actualSizeBytes) {
        await this.uploadIntentRepo.markRejected(
          storageKey,
          patientProfileId,
          `Declared size ${intent.declaredSizeBytes} bytes != actual ${actualSizeBytes} bytes`
        );
        throw new Error(
          `File size mismatch: Declared size ${intent.declaredSizeBytes} bytes does not match actual stored object size ${actualSizeBytes} bytes.`
        );
      }

      // 2. Stream object safely with bounded byte limit
      let fileBuffer: Buffer;
      try {
        fileBuffer = await this.getObjectBuffer(storageKey, patientProfileId);
      } catch (err) {
        // Object stream read failure is transient: release lock for retry
        await this.uploadIntentRepo.releaseVerificationLock(storageKey, patientProfileId);
        throw err;
      }

      // 3. Perform deep parser-based validation (PDF structure, encryption, image dimensions)
      const validation = await validateDocumentContent(fileBuffer, intent.mimeType);
      if (!validation.isValid) {
        await this.uploadIntentRepo.markRejected(
          storageKey,
          patientProfileId,
          validation.error || 'Document validation failed'
        );
        throw new Error(`Document validation failed: ${validation.error}`);
      }

      // 4. Server-side SHA-256 calculation
      const serverChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      if (expectedChecksum && expectedChecksum.toLowerCase() !== serverChecksum.toLowerCase()) {
        await this.uploadIntentRepo.markRejected(storageKey, patientProfileId, 'SHA-256 checksum mismatch');
        throw new Error('Integrity check failed: Client checksum does not match server-calculated SHA-256');
      }

      // Atomically mark VERIFIED
      await this.uploadIntentRepo.markVerified(storageKey, patientProfileId);

      return {
        storageKey,
        originalFilename: intent.originalFilename || `prescription-${storageKey.split('/').pop()}`,
        mimeType: intent.mimeType,
        fileSizeBytes: fileBuffer.length,
        sha256Checksum: serverChecksum,
        patientProfileId: intent.patientProfileId,
        uploadedAt: new Date(),
        validationDetails: validation,
      };
    } catch (err) {
      // If error occurred and lock is still in VERIFYING, release lock for clean retry
      const current = await this.uploadIntentRepo.getIntent(storageKey);
      if (current && current.status === 'VERIFYING') {
        await this.uploadIntentRepo.releaseVerificationLock(storageKey, patientProfileId).catch(() => {});
      }
      throw err;
    }
  }

  async getDownloadSignedUrl(storageKey: string, patientProfileId: string): Promise<string> {
    validateStorageKey(storageKey, patientProfileId);

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
    });

    return getSignedUrl(this.s3Client, command, { expiresIn: 900 });
  }

  async getObjectBuffer(storageKey: string, patientProfileId: string): Promise<Buffer> {
    validateStorageKey(storageKey, patientProfileId);

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
      });

      const response = await this.s3Client.send(command);
      if (!response.Body) {
        throw new Error('Document not found in storage');
      }

      return await readStreamBounded(response.Body, MAX_FILE_SIZE_BYTES);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('NoSuchKey') || msg.includes('NotFound') || msg.includes('404')) {
        throw new Error('Document not found in storage');
      }
      throw err;
    }
  }

  async checkObjectExists(storageKey: string, patientProfileId: string): Promise<{ exists: boolean; sizeBytes?: number }> {
    validateStorageKey(storageKey, patientProfileId);

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
      });

      const response = await this.s3Client.send(command);
      return { exists: true, sizeBytes: response.ContentLength };
    } catch {
      return { exists: false };
    }
  }

  async deleteObject(storageKey: string, patientProfileId: string): Promise<void> {
    validateStorageKey(storageKey, patientProfileId);

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
    });

    await this.s3Client.send(command);
  }

  /**
   * Deletes every object under a given prefix (e.g. "documents/<patientProfileId>/").
   * Used for account deletion. The prefix is validated against the owning
   * patientProfileId so a caller can never purge another tenant's objects.
   */
  async deleteByPrefix(prefix: string, patientProfileId: string): Promise<void> {
    assertOwnPrefix(prefix, patientProfileId);

    let continuationToken: string | undefined;
    do {
      const listResponse = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      const objects = (listResponse.Contents || [])
        .map(({ Key }) => Key)
        .filter((key): key is string => Boolean(key));

      if (objects.length > 0) {
        const deleted = await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects.map((Key) => ({ Key })), Quiet: true },
          })
        );
        if (deleted.Errors && deleted.Errors.length > 0) {
          // Fail closed so account deletion is not reported as complete with objects left behind.
          throw new Error(`Failed to delete ${deleted.Errors.length} stored object(s)`);
        }
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  async putObject(storageKey: string, patientProfileId: string, buffer: Buffer, mimeType: string): Promise<void> {
    validateStorageKey(storageKey, patientProfileId);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      Body: buffer,
      ContentType: mimeType,
    });

    await this.s3Client.send(command);
  }
}

/**
 * Memory Storage Provider Test Double.
 * Retained STRICTLY as an explicitly injected test double for isolated unit testing.
 * Uses UploadIntentRepository to mirror durable lifecycle and mutual exclusion.
 * Fails closed if an object was not uploaded or staged before finalization.
 */
export class MemoryStorageProvider implements StorageProvider {
  readonly providerType = 'memory';
  private objects: Map<string, { buffer: Buffer; metadata: StorageObjectMetadata }> = new Map();

  constructor(
    private readonly uploadIntentRepo: UploadIntentRepository = new InMemoryUploadIntentRepository()
  ) {}

  async createUploadIntent(request: UploadIntentRequest): Promise<UploadIntentResponse> {
    if (!ALLOWED_MIME_TYPES.has(request.mimeType)) {
      throw new Error(`Unsupported MIME type: ${request.mimeType}. Only JPEG, PNG, and PDF are allowed.`);
    }

    if (request.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File size ${request.fileSizeBytes} bytes exceeds 15MB limit.`);
    }

    if (request.fileSizeBytes <= 0) {
      throw new Error('File size must be greater than 0 bytes.');
    }

    const randomUuid = crypto.randomUUID();
    const storageKey = `documents/${request.patientProfileId}/${randomUuid}`;
    const expiresInSeconds = 900; // 15 minutes TTL
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    await this.uploadIntentRepo.createIntent({
      patientProfileId: request.patientProfileId,
      storageKey,
      originalFilename: request.filename,
      mimeType: request.mimeType,
      declaredSizeBytes: request.fileSizeBytes,
      expiresAt,
    });

    return {
      storageKey,
      uploadSignedUrl: `https://mock-s3.local/upload?key=${encodeURIComponent(storageKey)}&token=${randomUuid}`,
      expiresInSeconds,
    };
  }

  /**
   * Helper for tests to simulate a client PUT directly to the private bucket
   */
  async putObjectDirect(storageKey: string, buffer: Buffer): Promise<void> {
    const intent = await this.uploadIntentRepo.getIntent(storageKey);
    const patientProfileId = intent ? intent.patientProfileId : storageKey.split('/')[1] || '';

    const metadata: StorageObjectMetadata = {
      storageKey,
      originalFilename: intent?.originalFilename || 'test-file',
      mimeType: intent?.mimeType || 'application/pdf',
      fileSizeBytes: buffer.length,
      sha256Checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
      patientProfileId,
      uploadedAt: new Date(),
    };

    this.objects.set(storageKey, { buffer, metadata });
  }

  async verifyAndFinalizeUpload(
    storageKey: string,
    patientProfileId: string,
    claimedMimeType: string,
    expectedChecksum?: string
  ): Promise<StorageObjectMetadata> {
    validateStorageKey(storageKey, patientProfileId);

    const lockResult = await this.uploadIntentRepo.acquireVerificationLock(storageKey, patientProfileId);
    if (!lockResult.success) {
      const reason = lockResult.reason || 'Upload intent is invalid or could not be verified';
      throw new Error(reason);
    }

    const intent = lockResult.intent!;

    try {
      if (claimedMimeType && claimedMimeType !== intent.mimeType) {
        await this.uploadIntentRepo.markRejected(
          storageKey,
          patientProfileId,
          `Claimed MIME type ${claimedMimeType} does not match intent MIME type ${intent.mimeType}`
        );
        throw new Error(`Claimed MIME type ${claimedMimeType} does not match intent MIME type ${intent.mimeType}`);
      }

      const stored = this.objects.get(storageKey);
      if (!stored || !stored.buffer || stored.buffer.length === 0) {
        // Not yet uploaded: release lock back to PENDING for retry!
        await this.uploadIntentRepo.releaseVerificationLock(storageKey, patientProfileId);
        throw new Error('Uploaded object not found in private storage. Client must upload bytes before confirming.');
      }

      const fileBuffer = stored.buffer;
      if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
        await this.uploadIntentRepo.markRejected(storageKey, patientProfileId, 'File exceeds maximum allowable size of 15MB');
        throw new Error('File exceeds maximum allowable size of 15MB');
      }

      // Compare actual stored object size with declared size in intent
      if (intent.declaredSizeBytes !== fileBuffer.length) {
        await this.uploadIntentRepo.markRejected(
          storageKey,
          patientProfileId,
          `File size mismatch: Declared size ${intent.declaredSizeBytes} bytes does not match actual stored object size ${fileBuffer.length} bytes.`
        );
        throw new Error(
          `File size mismatch: Declared size ${intent.declaredSizeBytes} bytes does not match actual stored object size ${fileBuffer.length} bytes.`
        );
      }

      // Parser-based validation
      const validation = await validateDocumentContent(fileBuffer, intent.mimeType);
      if (!validation.isValid) {
        await this.uploadIntentRepo.markRejected(
          storageKey,
          patientProfileId,
          validation.error || 'Document validation failed'
        );
        throw new Error(`Document validation failed: ${validation.error}`);
      }

      // Server-side SHA-256 calculation
      const serverChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      if (expectedChecksum && expectedChecksum.toLowerCase() !== serverChecksum.toLowerCase()) {
        await this.uploadIntentRepo.markRejected(storageKey, patientProfileId, 'SHA-256 checksum mismatch');
        throw new Error('Integrity check failed: Client checksum does not match server-calculated SHA-256');
      }

      await this.uploadIntentRepo.markVerified(storageKey, patientProfileId);

      const metadata: StorageObjectMetadata = {
        storageKey,
        originalFilename: intent.originalFilename || `prescription-${storageKey.split('/').pop()}`,
        mimeType: intent.mimeType,
        fileSizeBytes: fileBuffer.length,
        sha256Checksum: serverChecksum,
        patientProfileId: intent.patientProfileId,
        uploadedAt: new Date(),
        validationDetails: validation,
      };

      this.objects.set(storageKey, { buffer: fileBuffer, metadata });
      return metadata;
    } catch (err) {
      const current = await this.uploadIntentRepo.getIntent(storageKey);
      if (current && current.status === 'VERIFYING') {
        await this.uploadIntentRepo.releaseVerificationLock(storageKey, patientProfileId).catch(() => {});
      }
      throw err;
    }
  }

  async getDownloadSignedUrl(storageKey: string, patientProfileId: string): Promise<string> {
    validateStorageKey(storageKey, patientProfileId);

    const item = this.objects.get(storageKey);
    if (!item) {
      throw new Error('Document not found in storage');
    }

    const token = crypto.randomUUID();
    return `https://mock-s3.local/download?key=${encodeURIComponent(storageKey)}&token=${token}&expires=900`;
  }

  async getObjectBuffer(storageKey: string, patientProfileId: string): Promise<Buffer> {
    validateStorageKey(storageKey, patientProfileId);

    const item = this.objects.get(storageKey);
    if (!item) {
      throw new Error('Document not found in storage');
    }

    return item.buffer;
  }

  async checkObjectExists(storageKey: string, patientProfileId: string): Promise<{ exists: boolean; sizeBytes?: number }> {
    validateStorageKey(storageKey, patientProfileId);
    const item = this.objects.get(storageKey);
    return { exists: Boolean(item), sizeBytes: item?.buffer.length };
  }

  async deleteObject(storageKey: string, patientProfileId: string): Promise<void> {
    validateStorageKey(storageKey, patientProfileId);
    this.objects.delete(storageKey);
  }

  /**
   * Deletes every object under a given prefix (e.g. "documents/<patientProfileId>/").
   * Mirrors the S3 provider's behaviour for the in-memory test double.
   */
  async deleteByPrefix(prefix: string, patientProfileId: string): Promise<void> {
    assertOwnPrefix(prefix, patientProfileId);

    for (const key of Array.from(this.objects.keys())) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
      }
    }
  }

  async putObject(storageKey: string, patientProfileId: string, buffer: Buffer, mimeType: string): Promise<void> {
    validateStorageKey(storageKey, patientProfileId);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    this.objects.set(storageKey, {
      buffer,
      metadata: {
        storageKey,
        originalFilename: `doc-${storageKey.split('/').pop()}`,
        mimeType,
        fileSizeBytes: buffer.length,
        sha256Checksum: checksum,
        patientProfileId,
        uploadedAt: new Date(),
      },
    });
  }
}

