import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import {
  validateStorageKey,
  MemoryStorageProvider,
} from '../src/modules/storage/storage-provider.js';
import {
  validateDocumentContent,
  validateFileMagicBytes,
  parserConcurrency,
  MAX_FILE_SIZE_BYTES,
} from '../src/modules/storage/file-parser-validator.js';
import {
  InMemoryDocumentRepository,
  InMemoryUploadIntentRepository,
} from '../src/modules/persistence/repositories.js';
import { DocumentService } from '../src/modules/documents/document-service.js';
import { createApp } from '../src/app.js';
import request from 'supertest';

describe('Blocker A & C: Storage Key Validation, Upload Intent Lifecycle & Retry Semantics', () => {
  let uploadIntentRepo: InMemoryUploadIntentRepository;
  let docRepo: InMemoryDocumentRepository;
  let storageProvider: MemoryStorageProvider;
  let docService: DocumentService;
  let app: any;

  const patientA = 'pat_userA';
  const patientB = 'pat_userB';
  const userAToken = 'Bearer mock-access-jwt-userA';
  const userBToken = 'Bearer mock-access-jwt-userB';

  async function createValidPdfBuffer(pageCount = 1): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
      const page = pdfDoc.addPage([400, 600]);
      page.drawText(`Page ${i + 1} content`);
    }
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  beforeEach(() => {
    uploadIntentRepo = new InMemoryUploadIntentRepository();
    storageProvider = new MemoryStorageProvider(uploadIntentRepo);
    docRepo = new InMemoryDocumentRepository();
    docService = new DocumentService(storageProvider, docRepo);
    app = createApp({ storageProvider, docRepo, uploadIntentRepo });
    parserConcurrency.reset();
  });

  // ==========================================
  // BLOCKER A: STORAGE KEY VALIDATION
  // ==========================================
  describe('Blocker A: validateStorageKey validation enforcement', () => {
    it('accepts valid UUID keys matching the authenticated patient profile', () => {
      const validUuid = crypto.randomUUID();
      const validKey = `documents/${patientA}/${validUuid}`;
      expect(() => validateStorageKey(validKey, patientA)).not.toThrow();
    });

    it('rejects malformed keys with non-UUID final path segments (e.g. integ-<id>.pdf)', () => {
      const nonUuidKey = `documents/${patientA}/integ-12345.pdf`;
      expect(() => validateStorageKey(nonUuidKey, patientA)).toThrow(
        /Forbidden: Storage key has an invalid format/
      );

      const filenameKey = `documents/${patientA}/prescription_scan.pdf`;
      expect(() => validateStorageKey(filenameKey, patientA)).toThrow(
        /Forbidden: Storage key has an invalid format/
      );

      const shortIdKey = `documents/${patientA}/12345`;
      expect(() => validateStorageKey(shortIdKey, patientA)).toThrow(
        /Forbidden: Storage key has an invalid format/
      );
    });

    it('rejects directory traversal attempts in storage keys', () => {
      const traversalKey1 = `documents/${patientA}/../../etc/passwd`;
      expect(() => validateStorageKey(traversalKey1, patientA)).toThrow();

      const traversalKey2 = `documents/${patientA}/..%2f..%2fsecret`;
      expect(() => validateStorageKey(traversalKey2, patientA)).toThrow();
    });

    it('rejects storage keys belonging to a different patient profile (cross-tenant)', () => {
      const validUuid = crypto.randomUUID();
      const crossPatientKey = `documents/${patientB}/${validUuid}`;
      expect(() => validateStorageKey(crossPatientKey, patientA)).toThrow(
        /Forbidden: Storage key does not belong to the authenticated patient profile/
      );
    });

    it('rejects storage keys with missing or extra path segments', () => {
      const validUuid = crypto.randomUUID();
      expect(() => validateStorageKey(`documents/${validUuid}`, patientA)).toThrow();
      expect(() => validateStorageKey(`documents/${patientA}/${validUuid}/extra`, patientA)).toThrow();
      expect(() => validateStorageKey(`uploads/${patientA}/${validUuid}`, patientA)).toThrow();
      expect(() => validateStorageKey('', patientA)).toThrow();
    });
  });

  // ==========================================
  // BLOCKER C: UPLOAD INTENT DURABLE LIFECYCLE & RETRY SEMANTICS
  // ==========================================
  describe('Blocker C: Upload intent state transitions, retries & concurrency', () => {
    it('handles object not yet uploaded by keeping intent PENDING so client can retry', async () => {
      const validPdf = await createValidPdfBuffer(1);
      const intentRes = await request(app)
        .post('/api/v1/documents/upload-intent')
        .set('Authorization', userAToken)
        .send({
          filename: 'pending_rx.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: validPdf.length,
        });

      const storageKey = intentRes.body.data.storageKey;

      // Client calls confirm BEFORE uploading bytes to storage
      const prematureConfirmRes = await request(app)
        .post('/api/v1/documents/confirm-upload')
        .set('Authorization', userAToken)
        .send({ storageKey, mimeType: 'application/pdf' });

      expect(prematureConfirmRes.status).toBe(400);
      expect(prematureConfirmRes.body.error.message).toContain('Uploaded object not found in private storage');

      // Crucial: Intent must NOT be permanently consumed or rejected! It must be PENDING for retry.
      const intentRecord = await uploadIntentRepo.getIntent(storageKey);
      expect(intentRecord).not.toBeNull();
      expect(intentRecord!.status).toBe('PENDING');
      expect(intentRecord!.consumed).toBe(false);

      // Now client uploads the bytes to storage
      await storageProvider.putObjectDirect(storageKey, validPdf);

      // Second confirmation attempt succeeds!
      const successfulRetryRes = await request(app)
        .post('/api/v1/documents/confirm-upload')
        .set('Authorization', userAToken)
        .send({ storageKey, mimeType: 'application/pdf' });

      expect(successfulRetryRes.status).toBe(201);
      expect(successfulRetryRes.body.data.storageKey).toBe(storageKey);

      // After successful finalization, intent is VERIFIED and consumed
      const finalizedIntent = await uploadIntentRepo.getIntent(storageKey);
      expect(finalizedIntent!.status).toBe('VERIFIED');
      expect(finalizedIntent!.consumed).toBe(true);
    });

    it('rejects declared size mismatch and transitions intent to terminal REJECTED state', async () => {
      const validPdf = await createValidPdfBuffer(1);
      const intentRes = await request(app)
        .post('/api/v1/documents/upload-intent')
        .set('Authorization', userAToken)
        .send({
          filename: 'size_mismatch.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: validPdf.length + 500, // Intent declares larger size
        });

      const storageKey = intentRes.body.data.storageKey;
      await storageProvider.putObjectDirect(storageKey, validPdf);

      const confirmRes = await request(app)
        .post('/api/v1/documents/confirm-upload')
        .set('Authorization', userAToken)
        .send({ storageKey, mimeType: 'application/pdf' });

      expect(confirmRes.status).toBe(400);
      expect(confirmRes.body.error.message).toContain('File size mismatch');

      // Intent must be moved to terminal REJECTED state
      const intentRecord = await uploadIntentRepo.getIntent(storageKey);
      expect(intentRecord!.status).toBe('REJECTED');
      expect(intentRecord!.rejectionReason).toContain('Declared size');
    });

    it('rejects invalid file content (corrupted bytes with magic header) and marks REJECTED', async () => {
      // Fake PDF: Starts with %PDF but followed by garbage
      const fakePdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(500)]);

      const intentRes = await request(app)
        .post('/api/v1/documents/upload-intent')
        .set('Authorization', userAToken)
        .send({
          filename: 'corrupted.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: fakePdf.length,
        });

      const storageKey = intentRes.body.data.storageKey;
      await storageProvider.putObjectDirect(storageKey, fakePdf);

      const confirmRes = await request(app)
        .post('/api/v1/documents/confirm-upload')
        .set('Authorization', userAToken)
        .send({ storageKey, mimeType: 'application/pdf' });

      expect(confirmRes.status).toBe(400);
      expect(confirmRes.body.error.message).toContain('Document validation failed');

      // Intent is marked REJECTED
      const intentRecord = await uploadIntentRepo.getIntent(storageKey);
      expect(intentRecord!.status).toBe('REJECTED');
    });

    it('prevents two concurrent requests from finalizing the same intent inconsistently', async () => {
      const validPdf = await createValidPdfBuffer(1);
      const intentRes = await request(app)
        .post('/api/v1/documents/upload-intent')
        .set('Authorization', userAToken)
        .send({
          filename: 'concurrency.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: validPdf.length,
        });

      const storageKey = intentRes.body.data.storageKey;
      await storageProvider.putObjectDirect(storageKey, validPdf);

      // Launch two concurrent finalization requests racing for the same intent
      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/v1/documents/confirm-upload')
          .set('Authorization', userAToken)
          .send({ storageKey, mimeType: 'application/pdf' }),
        request(app)
          .post('/api/v1/documents/confirm-upload')
          .set('Authorization', userAToken)
          .send({ storageKey, mimeType: 'application/pdf' }),
      ]);

      const statuses = [res1.status, res2.status];
      // Exactly one request must succeed (201 Created)
      expect(statuses).toContain(201);
      // The other request must be rejected (400 Bad Request)
      expect(statuses).toContain(400);

      // Verify in document repository: exactly 1 document was created
      const docs = await docRepo.listByPatient(patientA);
      const matchingDocs = docs.filter((d) => d.storageKey === storageKey);
      expect(matchingDocs).toHaveLength(1);
    });

    it('rejects repeated finalization of an already-verified upload without duplicate document creation', async () => {
      const validPdf = await createValidPdfBuffer(1);
      const intentRes = await request(app)
        .post('/api/v1/documents/upload-intent')
        .set('Authorization', userAToken)
        .send({
          filename: 'repeat_finalization.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: validPdf.length,
        });

      const storageKey = intentRes.body.data.storageKey;
      await storageProvider.putObjectDirect(storageKey, validPdf);

      // First finalization -> 201 Created
      const firstRes = await request(app)
        .post('/api/v1/documents/confirm-upload')
        .set('Authorization', userAToken)
        .send({ storageKey, mimeType: 'application/pdf' });
      expect(firstRes.status).toBe(201);

      // Repeated finalization attempt -> 400 Bad Request
      const secondRes = await request(app)
        .post('/api/v1/documents/confirm-upload')
        .set('Authorization', userAToken)
        .send({ storageKey, mimeType: 'application/pdf' });
      expect(secondRes.status).toBe(400);
      expect(secondRes.body.error.message).toContain('already been consumed');

      // Verify exactly one document exists in repository
      const docs = await docRepo.listByPatient(patientA);
      const matching = docs.filter((d) => d.storageKey === storageKey);
      expect(matching).toHaveLength(1);
    });

    it('rejects finalization of expired intents', async () => {
      const validPdf = await createValidPdfBuffer(1);
      const fileId = crypto.randomUUID();
      const storageKey = `documents/${patientA}/${fileId}`;

      // Create intent that expired 1 minute ago
      await uploadIntentRepo.createIntent({
        patientProfileId: patientA,
        storageKey,
        originalFilename: 'expired.pdf',
        mimeType: 'application/pdf',
        declaredSizeBytes: validPdf.length,
        expiresAt: new Date(Date.now() - 60000),
      });

      await storageProvider.putObjectDirect(storageKey, validPdf);

      const res = await request(app)
        .post('/api/v1/documents/confirm-upload')
        .set('Authorization', userAToken)
        .send({ storageKey, mimeType: 'application/pdf' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('expired');
    });

    it('rejects cross-patient finalization attempts with 403 Forbidden', async () => {
      const validPdf = await createValidPdfBuffer(1);
      const intentRes = await request(app)
        .post('/api/v1/documents/upload-intent')
        .set('Authorization', userAToken)
        .send({
          filename: 'userA_doc.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: validPdf.length,
        });

      const storageKey = intentRes.body.data.storageKey;
      await storageProvider.putObjectDirect(storageKey, validPdf);

      // User B attempts to finalize User A's upload intent
      const res = await request(app)
        .post('/api/v1/documents/confirm-upload')
        .set('Authorization', userBToken)
        .send({ storageKey, mimeType: 'application/pdf' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain('does not belong to the authenticated patient');
    });
  });
});

// ==========================================
// BLOCKER D: REAL PARSER RESOURCE LIMITS & THREAD TERMINATION
// ==========================================
describe('Blocker D: Real Parser Resource Limits, Worker Isolation & Termination', () => {
  beforeEach(() => {
    parserConcurrency.reset();
  });

  it('rejects oversized files exceeding 15MB before spawning worker or memory exhaustion', async () => {
    // 16MB virtual buffer check
    const hugeBuffer = Buffer.alloc(16 * 1024 * 1024);
    hugeBuffer[0] = 0x25; // %PDF
    hugeBuffer[1] = 0x50;
    hugeBuffer[2] = 0x44;
    hugeBuffer[3] = 0x46;

    const result = await validateDocumentContent(hugeBuffer, 'application/pdf');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('exceeds maximum limit of 15MB');
  });

  it('rejects empty (0 byte) files fail-closed', async () => {
    const emptyBuf = Buffer.alloc(0);
    const result = await validateDocumentContent(emptyBuf, 'application/pdf');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('empty (0 bytes)');
  });

  it('rejects malformed files safely without unhandled crashes', async () => {
    const corruptPdf = Buffer.from('%PDF-corrupted-and-truncated-syntax');
    const result = await validateDocumentContent(corruptPdf, 'application/pdf');
    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Malformed PDF document');
  });

  it('terminates hanging parser worker thread forcefully via worker.terminate() on timeout', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([400, 600]);
    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    // Call validateDocumentContent with synthetic hang and short 200ms timeout
    const startTime = Date.now();
    const result = await validateDocumentContent(
      pdfBuffer,
      'application/pdf',
      200,
      { _simulateHang: true }
    );
    const elapsed = Date.now() - startTime;

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Document parser timed out and execution was terminated');
    // Ensure timeout happened promptly around ~200ms, not running indefinitely
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1500);

    // Concurrency slot must be cleanly released back to 0
    expect(parserConcurrency.getActiveCount()).toBe(0);
  });

  it('bounds concurrent worker threads and queues excess parsing tasks', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([400, 600]);
    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    // Launch 8 parallel validations (concurrency limit is 4)
    const promises = Array.from({ length: 8 }, () =>
      validateDocumentContent(pdfBuffer, 'application/pdf', 5000)
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.isValid).toBe(true);
      expect(res.pageCount).toBe(1);
    }

    // All active worker slots returned to 0
    expect(parserConcurrency.getActiveCount()).toBe(0);
  });
});
