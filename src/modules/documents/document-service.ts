import {
  StorageProvider,
  UploadIntentResponse,
  StorageObjectMetadata,
} from '../storage/storage-provider.js';
import {
  DocumentRepository,
  DocumentRecord,
  DocumentStatus,
} from '../persistence/repositories.js';

export { DocumentRecord, DocumentStatus };

export class DocumentService {
  constructor(
    private readonly storageProvider: StorageProvider,
    private readonly docRepository: DocumentRepository
  ) {}

  /**
   * Initializes a private pre-signed upload intent.
   * Derives storageKey safely server-side: documents/<patientProfileId>/<uuid>
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
   * Confirms upload after client completes transmission to the pre-signed storage URL.
   * Retrieves the actual uploaded object server-side.
   * Performs magic bytes, parser-based validation, and SHA-256 verification.
   * Fails closed if object does not exist or is empty.
   * Persists an immutable DocumentRecord in the database.
   */
  async confirmUpload(
    patientProfileId: string,
    storageKey: string,
    claimedMimeType: string,
    clientChecksum?: string
  ): Promise<DocumentRecord> {
    // 1. Retrieve, parse, and verify actual object from private storage
    const metadata: StorageObjectMetadata = await this.storageProvider.verifyAndFinalizeUpload(
      storageKey,
      patientProfileId,
      claimedMimeType,
      clientChecksum
    );

    // 2. Persist in authoritative database repository
    const record = await this.docRepository.create({
      patientProfileId,
      storageKey: metadata.storageKey,
      originalFilename: metadata.originalFilename,
      mimeType: metadata.mimeType,
      fileSizeBytes: metadata.fileSizeBytes,
      sha256Checksum: metadata.sha256Checksum,
      status: 'UPLOADED',
      pageCount: metadata.validationDetails?.pageCount,
      imageWidth: metadata.validationDetails?.imageDimensions?.width,
      imageHeight: metadata.validationDetails?.imageDimensions?.height,
    });

    return record;
  }

  /**
   * Retrieves a document record with strict patient ownership check.
   * Throws Error if not found or unauthorized (safe 404 behavior).
   */
  async getDocument(patientProfileId: string, documentId: string): Promise<DocumentRecord> {
    const doc = await this.docRepository.findById(documentId);
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
    await this.getDocument(patientProfileId, documentId);
    return this.docRepository.updateStatus(documentId, status);
  }

  /**
   * Lists all documents belonging to the authenticated patient.
   */
  async listDocuments(patientProfileId: string): Promise<DocumentRecord[]> {
    return this.docRepository.listByPatient(patientProfileId);
  }

  /**
   * Hard-deletes a document and deletes the underlying object in storage.
   */
  async deleteDocument(patientProfileId: string, documentId: string): Promise<void> {
    const doc = await this.getDocument(patientProfileId, documentId);
    await this.storageProvider.deleteObject(doc.storageKey, patientProfileId);
    await this.docRepository.delete(documentId);
  }
}
