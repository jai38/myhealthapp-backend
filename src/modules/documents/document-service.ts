import crypto from 'crypto';
import {
  StorageProvider,
  UploadIntentResponse,
  StorageObjectMetadata,
} from '../storage/storage-provider.js';

export type DocumentStatus =
  | 'UPLOADED'
  | 'EXTRACTING'
  | 'READY_FOR_REVIEW'
  | 'CONFIRMED'
  | 'FAILED';

export interface DocumentRecord {
  id: string;
  patientProfileId: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256Checksum: string;
  status: DocumentStatus;
  uploadedAt: Date;
  updatedAt: Date;
}

export class DocumentService {
  private documents: Map<string, DocumentRecord> = new Map();

  constructor(private readonly storageProvider: StorageProvider) {}

  /**
   * Initializes a private pre-signed upload intent.
   * Derives storageKey safely server-side to prevent path traversal.
   */
  async initializeUpload(
    patientProfileId: string,
    filename: string,
    mimeType: string,
    fileSizeBytes: number
  ): Promise<UploadIntentResponse> {
    return this.storageProvider.createUploadIntent({
      patientProfileId,
      filename,
      mimeType,
      fileSizeBytes,
    });
  }

  /**
   * Confirms upload after client completes transmission.
   * Performs server-side checksum calculation and magic bytes verification.
   * Creates an immutable DocumentRecord linked to the authenticated patient profile.
   */
  async confirmUpload(
    patientProfileId: string,
    storageKey: string,
    fileBuffer: Buffer,
    clientChecksum?: string
  ): Promise<DocumentRecord> {
    // Verify ownership of the storage key (must match documents/<patientProfileId>/...)
    const expectedPrefix = `documents/${patientProfileId}/`;
    if (!storageKey.startsWith(expectedPrefix)) {
      throw new Error('Forbidden: Storage key does not belong to the authenticated patient profile');
    }

    const metadata: StorageObjectMetadata = await this.storageProvider.verifyAndPersistUpload(
      storageKey,
      fileBuffer,
      clientChecksum
    );

    const documentId = crypto.randomUUID();
    const now = new Date();

    const record: DocumentRecord = {
      id: documentId,
      patientProfileId,
      storageKey: metadata.storageKey,
      originalFilename: metadata.originalFilename,
      mimeType: metadata.mimeType,
      fileSizeBytes: metadata.fileSizeBytes,
      sha256Checksum: metadata.sha256Checksum,
      status: 'UPLOADED',
      uploadedAt: metadata.uploadedAt,
      updatedAt: now,
    };

    this.documents.set(documentId, record);
    return record;
  }

  /**
   * Retrieves a document record with strict ownership check.
   * Throws Error if not found or unauthorized (safe 404 behavior).
   */
  async getDocument(patientProfileId: string, documentId: string): Promise<DocumentRecord> {
    const doc = this.documents.get(documentId);
    if (!doc || doc.patientProfileId !== patientProfileId) {
      throw new Error('Document not found');
    }
    return doc;
  }

  /**
   * Generates a short-lived preview URL (15-min TTL) for the document with ownership verification.
   */
  async getSignedPreviewUrl(patientProfileId: string, documentId: string): Promise<string> {
    const doc = await this.getDocument(patientProfileId, documentId);
    return this.storageProvider.getDownloadSignedUrl(doc.storageKey, patientProfileId);
  }

  /**
   * Retrieves raw document buffer for backend processing (e.g. AI extraction).
   */
  async getDocumentBuffer(patientProfileId: string, documentId: string): Promise<{ buffer: Buffer; doc: DocumentRecord }> {
    const doc = await this.getDocument(patientProfileId, documentId);
    const buffer = await this.storageProvider.getObjectBuffer(doc.storageKey, patientProfileId);
    return { buffer, doc };
  }

  /**
   * Updates document status during pipeline lifecycle.
   */
  async updateStatus(patientProfileId: string, documentId: string, status: DocumentStatus): Promise<DocumentRecord> {
    const doc = await this.getDocument(patientProfileId, documentId);
    doc.status = status;
    doc.updatedAt = new Date();
    this.documents.set(documentId, doc);
    return doc;
  }

  /**
   * Lists all documents belonging to the authenticated patient.
   */
  async listDocuments(patientProfileId: string): Promise<DocumentRecord[]> {
    return Array.from(this.documents.values()).filter(
      (doc) => doc.patientProfileId === patientProfileId
    );
  }

  /**
   * Hard-deletes a document and deletes the underlying object in storage.
   */
  async deleteDocument(patientProfileId: string, documentId: string): Promise<void> {
    const doc = await this.getDocument(patientProfileId, documentId);
    await this.storageProvider.deleteObject(doc.storageKey, patientProfileId);
    this.documents.delete(documentId);
  }
}
