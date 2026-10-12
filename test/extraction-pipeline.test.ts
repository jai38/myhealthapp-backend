import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { MemoryStorageProvider } from '../src/modules/storage/storage-provider.js';
import { MockPrescriptionExtractionProvider } from '../src/modules/ai-extraction/provider.js';
import {
  InMemoryDocumentRepository,
  InMemoryExtractionJobRepository,
  InMemoryPrescriptionRepository,
  InMemoryUploadIntentRepository,
} from '../src/modules/persistence/repositories.js';

describe('Prescription Extraction Job Lifecycle & Patient Confirmation', () => {
  const userAToken = 'Bearer mock-access-jwt-userA'; // pat_userA
  const userBToken = 'Bearer mock-access-jwt-userB'; // pat_userB

  let storageProvider: MemoryStorageProvider;
  let docRepo: InMemoryDocumentRepository;
  let jobRepo: InMemoryExtractionJobRepository;
  let prescriptionRepo: InMemoryPrescriptionRepository;
  let uploadIntentRepo: InMemoryUploadIntentRepository;

  async function createValidPdfBuffer(pageCount = 1): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
      const page = pdfDoc.addPage([400, 600]);
      page.drawText(`Clinical document page ${i + 1}`);
    }
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }

  // Helper to upload a genuine valid test document
  async function uploadTestDocument(app: any, token: string = userAToken): Promise<string> {
    const validPdf = await createValidPdfBuffer(1);

    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', token)
      .send({
        filename: 'rx_test.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: validPdf.length,
      });

    const storageKey = intentRes.body.data.storageKey;
    await storageProvider.putObjectDirect(storageKey, validPdf);

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', token)
      .send({
        storageKey,
        mimeType: 'application/pdf',
      });

    return confirmRes.body.data.id;
  }

  beforeEach(() => {
    uploadIntentRepo = new InMemoryUploadIntentRepository();
    storageProvider = new MemoryStorageProvider(uploadIntentRepo);
    docRepo = new InMemoryDocumentRepository();
    jobRepo = new InMemoryExtractionJobRepository();
    prescriptionRepo = new InMemoryPrescriptionRepository(jobRepo, docRepo);
  });


  it('runs the extraction lifecycle: QUEUED -> PROCESSING -> SUCCEEDED', async () => {
    const mockProvider = new MockPrescriptionExtractionProvider({ mode: 'CLEAN' });
    const app = createApp({
      storageProvider,
      docRepo,
      jobRepo,
      prescriptionRepo,
      extractionProvider: mockProvider,
    });

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
    const app = createApp({ storageProvider, docRepo, jobRepo, prescriptionRepo });
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

  it('proves atomic job claiming prevents concurrent duplicate worker processing', async () => {
    const app = createApp({ storageProvider, docRepo, jobRepo, prescriptionRepo });
    const documentId = await uploadTestDocument(app);

    const submitRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId, autoProcess: false });

    const jobId = submitRes.body.data.id;
    expect(submitRes.body.data.status).toBe('QUEUED');

    // Worker 1 claims job
    const claim1 = await jobRepo.claimJobForProcessing(jobId);
    expect(claim1).not.toBeNull();
    expect(claim1?.status).toBe('PROCESSING');

    // Worker 2 attempts concurrent claim on the same job
    const claim2 = await jobRepo.claimJobForProcessing(jobId);
    expect(claim2).toBeNull(); // Concurrency safety: atomic claim blocks second worker!
  });

  it('allows job cancellation before completion and prevents late provider response from overwriting CANCELLED state', async () => {
    const app = createApp({ storageProvider, docRepo, jobRepo, prescriptionRepo });
    const documentId = await uploadTestDocument(app);

    // Submit with autoProcess: false
    const submitRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId, autoProcess: false });

    const jobId = submitRes.body.data.id;

    // Cancel job
    const cancelRes = await request(app)
      .post(`/api/v1/prescriptions/extract-job/${jobId}/cancel`)
      .set('Authorization', userAToken);

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('CANCELLED');

    // Late provider response attempts to mark it SUCCEEDED
    const lateAttempt = await jobRepo.completeProcessing(
      jobId,
      { medicines: [] },
      'SUCCEEDED'
    );

    expect(lateAttempt).toBeNull(); // Overwrite protection: late completion was rejected!
    const finalJob = await jobRepo.findById(jobId);
    expect(finalJob?.status).toBe('CANCELLED');
  });

  it('handles provider failures with bounded retries up to max 3 attempts and marks FAILED', async () => {
    const failingProvider = new MockPrescriptionExtractionProvider({ mode: 'PROVIDER_ERROR' });
    const app = createApp({
      storageProvider,
      docRepo,
      jobRepo,
      prescriptionRepo,
      extractionProvider: failingProvider,
    });
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

    // Source document remains intact in storage and status is FAILED
    const doc = await docRepo.findById(documentId);
    expect(doc?.status).toBe('FAILED');
  });

  it('recovers jobs left in PROCESSING state after worker interruption', async () => {
    const app = createApp({ storageProvider, docRepo, jobRepo, prescriptionRepo });
    const documentId = await uploadTestDocument(app);

    const submitRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId, autoProcess: false });

    const jobId = submitRes.body.data.id;
    await jobRepo.claimJobForProcessing(jobId);

    // Simulate worker crash: job remains in PROCESSING with old timestamp
    await jobRepo.setJobStartedAtForTesting(jobId, new Date(Date.now() - 120000)); // 2 minutes ago

    const recovered = await jobRepo.recoverStaleProcessingJobs(60000); // threshold 1 min
    expect(recovered.length).toBe(1);
    expect(recovered[0]!.id).toBe(jobId);
    expect(recovered[0]!.status).toBe('QUEUED');
    expect(recovered[0]!.retryCount).toBe(1);
  });

  it('guarantees unreviewed AI output NEVER appears as verified clinical data in the timeline', async () => {
    const app = createApp({ storageProvider, docRepo, jobRepo, prescriptionRepo });
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
    const app = createApp({
      storageProvider,
      docRepo,
      jobRepo,
      prescriptionRepo,
      extractionProvider: failingProvider,
    });
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
    const app = createApp({ storageProvider, docRepo, jobRepo, prescriptionRepo });
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
          name_as_written: 'Glycomet 500 SR (morning/night)',
          normalized_medicine_name: 'Metformin 500mg SR',
          strength: '500 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-1',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'After breakfast and dinner',
          is_active_medication: false, // Non-negotiable: historical rx does NOT automatically activate
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

    // 4. Verify duplicate confirmation is strictly prevented
    const duplicateConfirmRes = await request(app)
      .post(`/api/v1/prescriptions/${jobId}/confirm`)
      .set('Authorization', userAToken)
      .send(patientReviewPayload);

    expect(duplicateConfirmRes.status).toBe(400);
    expect(duplicateConfirmRes.body.error.message).toContain('already been confirmed');
  });

  it('proves clinical records survive service reinitialization and duplicate confirmation across instances is blocked', async () => {
    // Instance 1 creates and confirms prescription
    const appInstance1 = createApp({ storageProvider, docRepo, jobRepo, prescriptionRepo });
    const documentId = await uploadTestDocument(appInstance1);

    const submitRes = await request(appInstance1)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', userAToken)
      .send({ documentId });
    const jobId = submitRes.body.data.id;

    const patientReviewPayload = {
      prescription_date: '2026-10-12',
      date_is_uncertain: false,
      medicines: [
        {
          name_as_written: 'Paracetamol 650',
          dosage_form: 'TABLET',
          route: 'ORAL',
          is_active_medication: false,
        },
      ],
    };

    await request(appInstance1)
      .post(`/api/v1/prescriptions/${jobId}/confirm`)
      .set('Authorization', userAToken)
      .send(patientReviewPayload);

    // Reinitialize brand new service/app instance pointing to the SAME durable repositories
    const appInstance2 = createApp({ storageProvider, docRepo, jobRepo, prescriptionRepo });

    // Verify timeline records survived service reinitialization
    const timelineRes = await request(appInstance2)
      .get('/api/v1/prescriptions/timeline')
      .set('Authorization', userAToken);

    expect(timelineRes.status).toBe(200);
    expect(timelineRes.body.data.length).toBe(1);

    // Verify instance 2 cannot confirm the same job again
    const reconfirmRes = await request(appInstance2)
      .post(`/api/v1/prescriptions/${jobId}/confirm`)
      .set('Authorization', userAToken)
      .send(patientReviewPayload);

    expect(reconfirmRes.status).toBe(400);
    expect(reconfirmRes.body.error.message).toContain('already been confirmed');
  });

  it('rejects cross-user access to extraction jobs (User B accessing User A job returns 404)', async () => {
    const app = createApp({ storageProvider, docRepo, jobRepo, prescriptionRepo });
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
