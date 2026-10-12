import crypto from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  validateDocumentContent,
  DocumentValidationResult,
  MAX_FILE_SIZE_BYTES,
} from './file-parser-validator.js';

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

export interface PendingIntentRecord {
  patientProfileId: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  expiresAt: number;
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
  checkObjectExists(storageKey: string, patientProfileId: string): Promise<{ exists: boolean; sizeBytes?: number }>;
}

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);

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
 * Production S3 / MinIO Storage Provider.
 * Connects to S3-compatible private object storage using AWS SDK v3.
 * Generates genuine presigned PUT & GET URLs, retrieves uploaded objects server-side,
 * and performs cryptographic integrity and deep parser verification.
 */
export class S3StorageProvider implements StorageProvider {
  readonly providerType = 's3';
  private s3Client: S3Client;
  private bucket: string;
  private pendingIntents: Map<string, PendingIntentRecord> = new Map();

  constructor(options?: {
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    useSsl?: boolean;
  }) {
    const endpoint = options?.endpoint || process.env.STORAGE_ENDPOINT || 'http://localhost:9000';
    const region = options?.region || process.env.STORAGE_REGION || 'us-east-1';
    this.bucket = options?.bucket || process.env.STORAGE_BUCKET || 'myhealthapp-documents';
    const accessKeyId = options?.accessKeyId || process.env.STORAGE_ACCESS_KEY || 'minioadmin';
    const secretAccessKey = options?.secretAccessKey || process.env.STORAGE_SECRET_KEY || 'minioadminpassword';

    this.s3Client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: true, // Required for MinIO and local S3 emulators
    });
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

    this.pendingIntents.set(storageKey, {
      patientProfileId: request.patientProfileId,
      filename: request.filename,
      mimeType: request.mimeType,
      fileSizeBytes: request.fileSizeBytes,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    });

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      ContentType: request.mimeType,
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

    const intent = this.pendingIntents.get(storageKey);
    if (!intent) {
      throw new Error('Upload intent expired or not found. Please initialize a new upload.');
    }

    if (claimedMimeType && claimedMimeType !== intent.mimeType) {
      throw new Error(`Claimed MIME type ${claimedMimeType} does not match intent MIME type ${intent.mimeType}`);
    }

    if (Date.now() > intent.expiresAt) {
      this.pendingIntents.delete(storageKey);
      throw new Error('Upload ticket has expired (exceeded 15-minute window)');
    }

    // 1. Retrieve actual stored object from S3/MinIO
    let fileBuffer: Buffer;
    try {
      fileBuffer = await this.getObjectBuffer(storageKey, patientProfileId);
    } catch {
      throw new Error('Uploaded object not found in private storage. Client must upload bytes before confirming.');
    }

    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error('Uploaded object is empty (0 bytes). Upload must fail closed.');
    }

    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File size ${fileBuffer.length} bytes exceeds 15MB limit`);
    }

    // 2. Perform deep parser-based validation (PDF structure, encryption, image dimensions)
    const validation = await validateDocumentContent(fileBuffer, intent.mimeType);
    if (!validation.isValid) {
      throw new Error(`Document validation failed: ${validation.error}`);
    }

    // 3. Server-side SHA-256 calculation
    const serverChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    if (expectedChecksum && expectedChecksum.toLowerCase() !== serverChecksum.toLowerCase()) {
      throw new Error('Integrity check failed: Client checksum does not match server-calculated SHA-256');
    }

    const metadata: StorageObjectMetadata = {
      storageKey,
      originalFilename: intent.filename,
      mimeType: intent.mimeType,
      fileSizeBytes: fileBuffer.length,
      sha256Checksum: serverChecksum,
      patientProfileId: intent.patientProfileId,
      uploadedAt: new Date(),
      validationDetails: validation,
    };

    // Clean up consumed intent
    this.pendingIntents.delete(storageKey);

    return metadata;
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

      // Convert readable stream to Buffer
      const byteArray = await response.Body.transformToByteArray();
      return Buffer.from(byteArray);
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
}

/**
 * Memory Storage Provider Test Double.
 * Retained STRICTLY as an explicitly injected test double for isolated unit testing.
 * Fails closed if an object was not uploaded or staged before finalization.
 */
export class MemoryStorageProvider implements StorageProvider {
  readonly providerType = 'memory';
  private objects: Map<string, { buffer: Buffer; metadata: StorageObjectMetadata }> = new Map();
  private pendingIntents: Map<string, PendingIntentRecord> = new Map();

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

    this.pendingIntents.set(storageKey, {
      patientProfileId: request.patientProfileId,
      filename: request.filename,
      mimeType: request.mimeType,
      fileSizeBytes: request.fileSizeBytes,
      expiresAt: Date.now() + expiresInSeconds * 1000,
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
    const intent = this.pendingIntents.get(storageKey);
    const patientProfileId = intent ? intent.patientProfileId : storageKey.split('/')[1] || '';

    const metadata: StorageObjectMetadata = {
      storageKey,
      originalFilename: intent?.filename || 'test-file',
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

    const intent = this.pendingIntents.get(storageKey);
    if (!intent) {
      throw new Error('Upload intent expired or not found. Please initialize a new upload.');
    }

    if (claimedMimeType && claimedMimeType !== intent.mimeType) {
      throw new Error(`Claimed MIME type ${claimedMimeType} does not match intent MIME type ${intent.mimeType}`);
    }

    if (Date.now() > intent.expiresAt) {
      this.pendingIntents.delete(storageKey);
      throw new Error('Upload ticket has expired (exceeded 15-minute window)');
    }

    const stored = this.objects.get(storageKey);
    if (!stored || !stored.buffer || stored.buffer.length === 0) {
      // Must fail closed! No fabricated fallback!
      throw new Error('Uploaded object not found in private storage. Client must upload bytes before confirming.');
    }

    const fileBuffer = stored.buffer;
    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error('File exceeds maximum allowable size of 15MB');
    }

    // Parser-based validation
    const validation = await validateDocumentContent(fileBuffer, intent.mimeType);
    if (!validation.isValid) {
      throw new Error(`Document validation failed: ${validation.error}`);
    }

    // Server-side SHA-256 calculation
    const serverChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    if (expectedChecksum && expectedChecksum.toLowerCase() !== serverChecksum.toLowerCase()) {
      throw new Error('Integrity check failed: Client checksum does not match server-calculated SHA-256');
    }

    const metadata: StorageObjectMetadata = {
      storageKey,
      originalFilename: intent.filename,
      mimeType: intent.mimeType,
      fileSizeBytes: fileBuffer.length,
      sha256Checksum: serverChecksum,
      patientProfileId: intent.patientProfileId,
      uploadedAt: new Date(),
      validationDetails: validation,
    };

    this.objects.set(storageKey, { buffer: fileBuffer, metadata });
    this.pendingIntents.delete(storageKey);

    return metadata;
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
}
