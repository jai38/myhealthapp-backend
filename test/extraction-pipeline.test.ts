import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MockPrescriptionExtractionProvider } from '../src/modules/ai-extraction/provider.js';

describe('Prescription Extraction Job Lifecycle & Patient Confirmation', () => {
  const userAToken = 'Bearer mock-access-jwt-userA'; // pat_userA
  const userBToken = 'Bearer mock-access-jwt-userB'; // pat_userB

  // Helper to upload a valid test document for User A
  async function uploadTestDocument(app: any, token: string = userAToken) {
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', token)
      .send({
        filename: 'rx_test.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 100,
      });

    const pdfBuffer = Buffer.from('%PDF-1.4 simulated clinical document', 'utf-8');
    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', token)
      .send({
        storageKey: intentRes.body.data.storageKey,
        fileBufferBase64: pdfBuffer.toString('base64'),
      });

    return confirmRes.body.data.id;
  }

  it('runs the extraction lifecycle: QUEUED -> PROCESSING -> SUCCEEDED', async () => {
    const mockProvider = new MockPrescriptionExtractionProvider({ mode: 'CLEAN' });
    const app = createApp({ extractionProvider: mockProvider });

    const documentId = await uploadTestDocument(app);

    // 1. Submit extraction job
    const jobRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId });

    expect(jobRes.status).toBe(202);
    expect(jobRes.body.data).toHaveProperty('id');
    expect(jobRes.body.data.status).toBe('SUCCEEDED');
    expect(jobRes.body.data.extractedPayload).toHaveProperty('medicines');
    expect(jobRes.body.data.extractedPayload.medicines.length).toBeGreaterThanOrEqual(1);

    // 2. Poll job status
    const pollRes = await request(app)
      .get(`/api/v1/prescriptions/extract-job/${jobRes.body.data.id}`)
      .set('Authorization', userAToken);

    expect(pollRes.status).toBe(200);
    expect(pollRes.body.data.status).toBe('SUCCEEDED');
    expect(pollRes.body.data.extractedPayload.medicines[0].name_as_written).toBe('Glycomet 500 SR');
  });

  it('enforces idempotency on duplicate job submissions with the same key', async () => {
    const app = createApp();
    const documentId = await uploadTestDocument(app);
    const customIdempotencyKey = 'client-unique-request-xyz-123';

    // First submission
    const res1 = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId, idempotencyKey: customIdempotencyKey });

    const jobId1 = res1.body.data.id;

    // Duplicate submission
    const res2 = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId, idempotencyKey: customIdempotencyKey });

    const jobId2 = res2.body.data.id;

    // Must return the exact same job without re-executing or creating duplicates
    expect(jobId1).toBe(jobId2);
  });

  it('allows job cancellation before completion', async () => {
    const app = createApp();
    const documentId = await uploadTestDocument(app);

    // Submit with autoProcess: false to keep it QUEUED
    const submitRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId, autoProcess: false });

    const jobId = submitRes.body.data.id;
    expect(submitRes.body.data.status).toBe('QUEUED');

    // Cancel job
    const cancelRes = await request(app)
      .post(`/api/v1/prescriptions/extract-job/${jobId}/cancel`)
      .set('Authorization', userAToken);

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('CANCELLED');
  });

  it('handles provider failures with bounded retries up to max 3 attempts and marks FAILED', async () => {
    const failingProvider = new MockPrescriptionExtractionProvider({ mode: 'PROVIDER_ERROR' });
    const app = createApp({ extractionProvider: failingProvider });
    const documentId = await uploadTestDocument(app);

    // Submit with autoProcess: false
    const submitRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId, autoProcess: false });

    const jobId = submitRes.body.data.id;

    // Process attempt 1 -> fails, retryCount = 1, status QUEUED
    const attempt1 = await request(app)
      .post(`/api/v1/prescriptions/extract-job/${jobId}/process`)
      .set('Authorization', userAToken);
    expect(attempt1.body.data.retryCount).toBe(1);
    expect(attempt1.body.data.status).toBe('QUEUED');

    // Process attempt 2 -> fails, retryCount = 2, status QUEUED
    const attempt2 = await request(app)
      .post(`/api/v1/prescriptions/extract-job/${jobId}/process`)
      .set('Authorization', userAToken);
    expect(attempt2.body.data.retryCount).toBe(2);

    // Process attempt 3 -> reaches maxRetries (3), status FAILED
    const attempt3 = await request(app)
      .post(`/api/v1/prescriptions/extract-job/${jobId}/process`)
      .set('Authorization', userAToken);
    expect(attempt3.body.data.retryCount).toBe(3);
    expect(attempt3.body.data.status).toBe('FAILED');
    expect(attempt3.body.data.errorMessage).toContain('simulated 500');
  });

  it('guarantees unreviewed AI output NEVER appears as verified clinical data in the timeline', async () => {
    const app = createApp();
    const documentId = await uploadTestDocument(app);

    // Run extraction to SUCCEEDED state
    await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId });

    // Timeline must be empty (0 verified events)
    const timelineRes = await request(app)
      .get('/api/v1/prescriptions/timeline')
      .set('Authorization', userAToken);

    expect(timelineRes.status).toBe(200);
    expect(timelineRes.body.data).toHaveLength(0);
  });

  it('rejects confirmation attempts on unreviewed or non-succeeded extraction jobs', async () => {
    const failingProvider = new MockPrescriptionExtractionProvider({ mode: 'PROVIDER_ERROR' });
    const app = createApp({ extractionProvider: failingProvider });
    const documentId = await uploadTestDocument(app);

    // Submit and let it exhaust retries to FAILED
    const submitRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId });

    const jobId = submitRes.body.data.id;

    const confirmRes = await request(app)
      .post(`/api/v1/prescriptions/${jobId}/confirm`)
      .set('Authorization', userAToken)
      .send({
        prescription_date: '2026-10-12',
        medicines: [
          {
            name_as_written: 'Test Drug',
            dosage_form: 'TABLET',
            route: 'ORAL',
          },
        ],
      });

    expect(confirmRes.status).toBe(400);
    expect(confirmRes.body.error.message).toContain('Cannot confirm an unreviewed or non-succeeded');
  });

  it('executes explicit patient confirmation, preserves exact text, enforces medical safety rules', async () => {
    const app = createApp();
    const documentId = await uploadTestDocument(app);

    // 1. Submit extraction
    const submitRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId });
    const jobId = submitRes.body.data.id;

    // 2. Patient reviews and submits corrections
    const patientReviewPayload = {
      prescription_date: '2026-10-12',
      date_is_uncertain: false,
      doctor_name: 'Dr. A. Verma, MD',
      clinic_hospital_name: 'Apollo Indiranagar',
      documented_diagnosis: 'T2DM & Hypertension',
      medicines: [
        {
          name_as_written: 'Glycomet 500 SR (morning/night)', // Exact text preserved
          normalized_medicine_name: 'Metformin 500mg SR',
          strength: '500 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-1',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'After breakfast and dinner',
          is_active_medication: false, // Non-negotiable rule: historical rx does NOT automatically activate
        },
        {
          name_as_written: 'Telma 40',
          normalized_medicine_name: 'Telmisartan 40mg',
          strength: '40 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-0',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'Morning with water',
          is_active_medication: false,
        },
      ],
    };

    const confirmRes = await request(app)
      .post(`/api/v1/prescriptions/${jobId}/confirm`)
      .set('Authorization', userAToken)
      .send(patientReviewPayload);

    expect(confirmRes.status).toBe(201);
    expect(confirmRes.body.data).toHaveProperty('prescription');
    expect(confirmRes.body.data.prescription).toHaveProperty('documentId', documentId);
    expect(confirmRes.body.data.prescription).toHaveProperty('confirmedByUserId', 'userA');
    expect(confirmRes.body.data.prescription.reviewStatus).toBe('CONFIRMED');

    // Verify exact name as written preserved
    expect(confirmRes.body.data.items[0].nameAsWritten).toBe('Glycomet 500 SR (morning/night)');
    // Verify historical rx does NOT activate medications
    expect(confirmRes.body.data.items[0].isActiveMedication).toBe(false);

    // Verify verified timeline event was ingested
    expect(confirmRes.body.data).toHaveProperty('timelineEvent');
    expect(confirmRes.body.data.timelineEvent.isVerified).toBe(true);
    expect(confirmRes.body.data.timelineEvent.sourceDocumentId).toBe(documentId);

    // 3. Verify timeline now reflects verified clinical record
    const timelineRes = await request(app)
      .get('/api/v1/prescriptions/timeline')
      .set('Authorization', userAToken);

    expect(timelineRes.status).toBe(200);
    expect(timelineRes.body.data).toHaveLength(1);
    expect(timelineRes.body.data[0].title).toBe('Prescription from Dr. A. Verma, MD');

    // 4. Verify duplicate confirmation is prevented
    const duplicateConfirmRes = await request(app)
      .post(`/api/v1/prescriptions/${jobId}/confirm`)
      .set('Authorization', userAToken)
      .send(patientReviewPayload);

    expect(duplicateConfirmRes.status).toBe(400);
    expect(duplicateConfirmRes.body.error.message).toContain('already been confirmed');
  });

  it('rejects cross-user access to extraction jobs (User B accessing User A job returns 404)', async () => {
    const app = createApp();
    const documentId = await uploadTestDocument(app, userAToken);

    const submitRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId });
    const userAJobId = submitRes.body.data.id;

    // User B tries to inspect User A's extraction job -> 404
    const attackerRes = await request(app)
      .get(`/api/v1/prescriptions/extract-job/${userAJobId}`)
      .set('Authorization', userBToken);

    expect(attackerRes.status).toBe(404);
  });
});
