import crypto from 'crypto';

export interface StorageObjectMetadata {
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256Checksum: string;
  patientProfileId: string;
  uploadedAt: Date;
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
  createUploadIntent(request: UploadIntentRequest): Promise<UploadIntentResponse>;
  verifyAndPersistUpload(
    storageKey: string,
    fileBuffer: Buffer,
    expectedChecksum?: string
  ): Promise<StorageObjectMetadata>;
  getDownloadSignedUrl(storageKey: string, patientProfileId: string): Promise<string>;
  deleteObject(storageKey: string, patientProfileId: string): Promise<void>;
  getObjectBuffer(storageKey: string, patientProfileId: string): Promise<Buffer>;
}

// Supported MIME types and file signatures (magic bytes)
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB max limit

/**
 * Validates actual magic bytes of file buffer against expected MIME type.
 * Rejects disguised or malicious file extensions.
 */
export function validateFileMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 4) return false;

  if (mimeType === 'image/jpeg') {
    // JPEG starts with FF D8 FF
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    // PNG starts with 89 50 4E 47
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimeType === 'application/pdf') {
    // PDF starts with %PDF (25 50 44 46)
    return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
  }

  return false;
}

/**
 * Mock/Local Storage Provider
 * Implements S3-compatible private object storage behavior with in-memory / local storage.
 * Enforces ownership, path-traversal prevention, and server-side checksum calculation.
 */
export class MemoryStorageProvider implements StorageProvider {
  private objects: Map<string, { buffer: Buffer; metadata: StorageObjectMetadata }> = new Map();
  private pendingIntents: Map<string, { patientProfileId: string; filename: string; mimeType: string; size: number; expiresAt: number }> = new Map();

  async createUploadIntent(request: UploadIntentRequest): Promise<UploadIntentResponse> {
    if (!ALLOWED_MIME_TYPES.has(request.mimeType)) {
      throw new Error(`Unsupported MIME type: ${request.mimeType}. Only JPEG, PNG, and PDF are allowed.`);
    }

    if (request.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File size ${request.fileSizeBytes} bytes exceeds 15MB limit.`);
    }

    // Sanitize and generate safe opaque key, preventing path traversal
    const randomUuid = crypto.randomUUID();
    const storageKey = `documents/${request.patientProfileId}/${randomUuid}`;
    const expiresInSeconds = 900; // 15 minutes TTL

    this.pendingIntents.set(storageKey, {
      patientProfileId: request.patientProfileId,
      filename: request.filename,
      mimeType: request.mimeType,
      size: request.fileSizeBytes,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    });

    return {
      storageKey,
      uploadSignedUrl: `https://mock-s3.local/upload?key=${encodeURIComponent(storageKey)}&token=${randomUuid}`,
      expiresInSeconds,
    };
  }

  async verifyAndPersistUpload(
    storageKey: string,
    fileBuffer: Buffer,
    expectedChecksum?: string
  ): Promise<StorageObjectMetadata> {
    const intent = this.pendingIntents.get(storageKey);
    if (!intent) {
      throw new Error('Upload intent expired or not found');
    }

    if (Date.now() > intent.expiresAt) {
      this.pendingIntents.delete(storageKey);
      throw new Error('Upload ticket has expired (exceeded 15-minute window)');
    }

    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error('File exceeds maximum allowable size of 15MB');
    }

    // Verify magic bytes
    if (!validateFileMagicBytes(fileBuffer, intent.mimeType)) {
      throw new Error(`File signature does not match claimed MIME type ${intent.mimeType}`);
    }

    // Server-side SHA-256 calculation
    const serverChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    if (expectedChecksum && expectedChecksum !== serverChecksum) {
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
    };

    this.objects.set(storageKey, { buffer: fileBuffer, metadata });
    this.pendingIntents.delete(storageKey);

    return metadata;
  }

  async getDownloadSignedUrl(storageKey: string, patientProfileId: string): Promise<string> {
    const item = this.objects.get(storageKey);
    if (!item) {
      throw new Error('Document not found in storage');
    }

    // Strict ownership verification
    if (item.metadata.patientProfileId !== patientProfileId) {
      throw new Error('Unauthorized storage access attempt');
    }

    const token = crypto.randomUUID();
    return `https://mock-s3.local/download?key=${encodeURIComponent(storageKey)}&token=${token}&expires=900`;
  }

  async getObjectBuffer(storageKey: string, patientProfileId: string): Promise<Buffer> {
    const item = this.objects.get(storageKey);
    if (!item) {
      throw new Error('Document not found in storage');
    }

    if (item.metadata.patientProfileId !== patientProfileId) {
      throw new Error('Unauthorized storage access attempt');
    }

    return item.buffer;
  }

  async deleteObject(storageKey: string, patientProfileId: string): Promise<void> {
    const item = this.objects.get(storageKey);
    if (!item) return;

    if (item.metadata.patientProfileId !== patientProfileId) {
      throw new Error('Unauthorized storage access attempt');
    }

    this.objects.delete(storageKey);
  }
}
