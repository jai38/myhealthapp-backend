import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { MemoryStorageProvider } from '../src/modules/storage/storage-provider.js';
import { InMemoryDocumentRepository } from '../src/modules/persistence/repositories.js';

describe('Storage, Document Upload Security & Integrity', () => {
  let storageProvider: MemoryStorageProvider;
  let docRepo: InMemoryDocumentRepository;
  let app: any;

  const userAToken = 'Bearer mock-access-jwt-userA'; // patientProfileId: pat_userA
  const userBToken = 'Bearer mock-access-jwt-userB'; // patientProfileId: pat_userB

  // Helper to generate a genuine valid PDF with pdf-lib
  async function createValidPdfBuffer(pageCount = 1): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
      const page = pdfDoc.addPage([400, 600]);
      page.drawText(`Clinical document page ${i + 1}`);
    }
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  beforeEach(() => {
    storageProvider = new MemoryStorageProvider();
    docRepo = new InMemoryDocumentRepository();
    app = createApp({ storageProvider, docRepo });
  });

  it('generates a short-lived upload intent with opaque tenant-isolated storageKey and 15-min TTL', async () => {
    const res = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'prescription_scan.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 1024 * 50,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('storageKey');
    expect(res.body.data.storageKey).toMatch(/^documents\/pat_userA\/[0-9a-f-]{36}$/);
    expect(res.body.data).toHaveProperty('uploadSignedUrl');
    expect(res.body.data).toHaveProperty('expiresInSeconds', 900);
  });

  it('rejects unsupported MIME types and empty files at intent creation', async () => {
    const exeRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'malicious.exe',
        mimeType: 'application/x-msdownload',
        fileSizeBytes: 1024,
      });
    expect(exeRes.status).toBe(400);
    expect(exeRes.body.error.message).toContain('Unsupported MIME type');

    const zeroRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'empty.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 0,
      });
    expect(zeroRes.status).toBe(400);
    expect(zeroRes.body.error.message).toContain('greater than 0');
  });

  it('rejects files exceeding the 15MB limit at upload intent', async () => {
    const res = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'huge_file.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 16 * 1024 * 1024, // 16 MB
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('exceeds 15MB limit');
  });

  it('fails closed when client attempts confirmation without uploading bytes to storage (absent upload)', async () => {
    // 1. Create upload intent
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'missing_bytes.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 1024,
      });
    const storageKey = intentRes.body.data.storageKey;

    // 2. Client calls confirm-upload WITHOUT having uploaded bytes to storage
    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        mimeType: 'application/pdf',
      });

    // Must fail closed with 400! Zero fabricated fallback!
    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error.message).toContain('Uploaded object not found in private storage');
  });

  it('successfully confirms upload when genuine bytes are uploaded and verified server-side', async () => {
    const validPdf = await createValidPdfBuffer(1);
    const sha256 = crypto.createHash('sha256').update(validPdf).digest('hex');

    // 1. Initialize intent
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'valid_rx.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: validPdf.length,
      });
    const storageKey = intentRes.body.data.storageKey;

    // 2. Client uploads bytes to private storage
    await storageProvider.putObjectDirect(storageKey, validPdf);

    // 3. Client confirms upload with matching SHA-256 checksum
    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        mimeType: 'application/pdf',
        clientChecksum: sha256,
      });

    expect(confirmRes.status).toBe(201);
    expect(confirmRes.body.data).toHaveProperty('id');
    expect(confirmRes.body.data).toHaveProperty('patientProfileId', 'pat_userA');
    expect(confirmRes.body.data).toHaveProperty('sha256Checksum', sha256);
    expect(confirmRes.body.data).toHaveProperty('status', 'UPLOADED');
    expect(confirmRes.body.data).toHaveProperty('pageCount', 1);
  });

  it('rejects confirmation when client checksum does not match server-calculated SHA-256', async () => {
    const validPdf = await createValidPdfBuffer(1);

    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'checksum_tamper.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: validPdf.length,
      });
    const storageKey = intentRes.body.data.storageKey;

    await storageProvider.putObjectDirect(storageKey, validPdf);

    const forgedChecksum = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        mimeType: 'application/pdf',
        clientChecksum: forgedChecksum,
      });

    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error.message).toContain('Integrity check failed');
  });

  it('rejects arbitrary or cross-tenant storage keys (tenant isolation and path traversal defense)', async () => {
    // User B creates an intent
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userBToken)
      .send({
        filename: 'userB_doc.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 1024,
      });
    const userBStorageKey = intentRes.body.data.storageKey;

    // User A attempts to confirm User B's storage key
    const hijackRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey: userBStorageKey,
        mimeType: 'application/pdf',
      });
    expect(hijackRes.status).toBe(403);
    expect(hijackRes.body.error.code).toBe('FORBIDDEN');

    // Path traversal attempt
    const traversalRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey: '../../etc/passwd',
        mimeType: 'application/pdf',
      });
    expect(traversalRes.status).toBe(403);
  });

  it('rejects fake PDF headers (magic bytes %PDF followed by corrupted payload) via parser validation', async () => {
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'fake_header.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 60,
      });
    const storageKey = intentRes.body.data.storageKey;

    // Buffer has magic bytes %PDF but contains invalid garbage data
    const corruptBuffer = Buffer.from('%PDF-1.4 completely invalid non-pdf binary content garbage header', 'utf-8');
    await storageProvider.putObjectDirect(storageKey, corruptBuffer);

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        mimeType: 'application/pdf',
      });

    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error.message).toContain('Malformed PDF document');
  });

  it('rejects PDFs exceeding maximum page limit of 10 pages', async () => {
    const hugePdf = await createValidPdfBuffer(11); // 11 pages (exceeds 10)

    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'excessive_pages.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: hugePdf.length,
      });
    const storageKey = intentRes.body.data.storageKey;

    await storageProvider.putObjectDirect(storageKey, hugePdf);

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        mimeType: 'application/pdf',
      });

    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error.message).toContain('exceeds maximum allowable page count of 10 pages');
  });

  it('rejects corrupt image data with fake magic bytes', async () => {
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'fake_png.png',
        mimeType: 'image/png',
        fileSizeBytes: 30,
      });
    const storageKey = intentRes.body.data.storageKey;

    // PNG magic bytes 89 50 4E 47 followed by random noise
    const corruptPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
    await storageProvider.putObjectDirect(storageKey, corruptPng);

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        mimeType: 'image/png',
      });

    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error.message).toContain('Malformed image data');
  });

  it('allows owner to get signed preview URL and rejects unauthorized cross-user preview attempts (404 behavior)', async () => {
    const validPdf = await createValidPdfBuffer(1);

    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'preview_rx.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: validPdf.length,
      });
    const storageKey = intentRes.body.data.storageKey;

    await storageProvider.putObjectDirect(storageKey, validPdf);

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        mimeType: 'application/pdf',
      });
    const documentId = confirmRes.body.data.id;

    // Owner (User A) requests preview -> 200
    const ownerRes = await request(app)
      .get(`/api/v1/documents/${documentId}/signed-url`)
      .set('Authorization', userAToken);
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body.data).toHaveProperty('signedUrl');

    // Unauthorized User B requests preview -> 404 (ID enumeration protection)
    const attackerRes = await request(app)
      .get(`/api/v1/documents/${documentId}/signed-url`)
      .set('Authorization', userBToken);
    expect(attackerRes.status).toBe(404);
  });
});
