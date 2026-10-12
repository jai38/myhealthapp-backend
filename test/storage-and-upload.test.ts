import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../src/app.js';

describe('Storage, Document Upload Security & Integrity', () => {
  const app = createApp();
  const userAToken = 'Bearer mock-access-jwt-userA'; // patientProfileId: pat_userA
  const userBToken = 'Bearer mock-access-jwt-userB'; // patientProfileId: pat_userB

  it('generates a short-lived upload intent for allowed MIME types (JPEG, PNG, PDF)', async () => {
    const res = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'prescription_scan.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 1024 * 500, // 500 KB
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('storageKey');
    expect(res.body.data.storageKey).toMatch(/^documents\/pat_userA\//);
    expect(res.body.data).toHaveProperty('uploadSignedUrl');
    expect(res.body.data).toHaveProperty('expiresInSeconds', 900);
  });

  it('rejects unsupported MIME types (e.g., text/plain, exe, zip)', async () => {
    const res = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'malicious.exe',
        mimeType: 'application/x-msdownload',
        fileSizeBytes: 1024,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Unsupported MIME type');
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

  it('successfully confirms upload when magic bytes and checksum match', async () => {
    // 1. Initialize intent
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'valid_rx.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 50,
      });
    const storageKey = intentRes.body.data.storageKey;

    // 2. Prepare valid PDF buffer with %PDF magic bytes
    const pdfBuffer = Buffer.from('%PDF-1.4 simulated clinical document header', 'utf-8');
    const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

    // 3. Confirm upload
    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        fileBufferBase64: pdfBuffer.toString('base64'),
        clientChecksum: sha256,
      });

    expect(confirmRes.status).toBe(201);
    expect(confirmRes.body.data).toHaveProperty('id');
    expect(confirmRes.body.data).toHaveProperty('patientProfileId', 'pat_userA');
    expect(confirmRes.body.data).toHaveProperty('sha256Checksum', sha256);
    expect(confirmRes.body.data).toHaveProperty('status', 'UPLOADED');
  });

  it('rejects upload confirmation when magic bytes do not match declared MIME type (anti-spoofing)', async () => {
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'spoofed.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 30,
      });
    const storageKey = intentRes.body.data.storageKey;

    // Provide plain text buffer without %PDF magic bytes
    const fakeBuffer = Buffer.from('Just plain text disguised as pdf', 'utf-8');

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        fileBufferBase64: fakeBuffer.toString('base64'),
      });

    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error.message).toContain('File signature does not match');
  });

  it('rejects upload confirmation when client checksum does not match server calculation', async () => {
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'checksum_tamper.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 40,
      });
    const storageKey = intentRes.body.data.storageKey;

    const pdfBuffer = Buffer.from('%PDF-1.4 honest buffer', 'utf-8');
    const forgedChecksum = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        fileBufferBase64: pdfBuffer.toString('base64'),
        clientChecksum: forgedChecksum,
      });

    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error.message).toContain('Integrity check failed');
  });

  it('rejects cross-user upload confirmation (User A attempting to confirm User B storage key)', async () => {
    // User B creates intent
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userBToken)
      .send({
        filename: 'userB_doc.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 40,
      });
    const userBStorageKey = intentRes.body.data.storageKey;

    // User A attempts to confirm User B's storage key
    const pdfBuffer = Buffer.from('%PDF-1.4 user A trying to hijack', 'utf-8');
    const res = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey: userBStorageKey,
        fileBufferBase64: pdfBuffer.toString('base64'),
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows owner to get signed preview URL and rejects unauthorized cross-user preview attempts', async () => {
    // User A uploads document
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', userAToken)
      .send({
        filename: 'preview_test.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 40,
      });
    const storageKey = intentRes.body.data.storageKey;
    const pdfBuffer = Buffer.from('%PDF-1.4 valid test preview', 'utf-8');

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', userAToken)
      .send({
        storageKey,
        fileBufferBase64: pdfBuffer.toString('base64'),
      });
    const documentId = confirmRes.body.data.id;

    // Owner (User A) requests signed preview URL -> 200
    const ownerRes = await request(app)
      .get(`/api/v1/documents/${documentId}/signed-url`)
      .set('Authorization', userAToken);
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body.data).toHaveProperty('signedUrl');
    expect(ownerRes.body.data).toHaveProperty('expiresInSeconds', 900);

    // Cross-user (User B) attempts to get signed preview URL -> 404 (ID enumeration protection)
    const attackerRes = await request(app)
      .get(`/api/v1/documents/${documentId}/signed-url`)
      .set('Authorization', userBToken);
    expect(attackerRes.status).toBe(404);
  });
});
