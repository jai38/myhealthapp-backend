import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  InMemoryDocumentRepository,
  InMemoryExtractionJobRepository,
  InMemoryPrescriptionRepository,
  InMemoryUploadIntentRepository,
  InMemoryTimelineRepository,
} from '../src/modules/persistence/repositories.js';
import { DocumentService } from '../src/modules/documents/document-service.js';
import { MemoryStorageProvider } from '../src/modules/storage/storage-provider.js';
import { ExtractionJobQueue } from '../src/modules/ai-extraction/job-queue.js';
import { MockPrescriptionExtractionProvider } from '../src/modules/ai-extraction/provider.js';
import { PrescriptionService } from '../src/modules/prescriptions/prescription-service.js';
import { TimelineService } from '../src/modules/timeline/timeline-service.js';

describe('Phase 3: Medical Timeline API & Clinical Integrity', () => {
  let app: any;
  let docRepo: InMemoryDocumentRepository;
  let jobRepo: InMemoryExtractionJobRepository;
  let prescriptionRepo: InMemoryPrescriptionRepository;
  let uploadIntentRepo: InMemoryUploadIntentRepository;
  let timelineRepo: InMemoryTimelineRepository;
  let storageProvider: MemoryStorageProvider;
  let documentService: DocumentService;
  let jobQueue: ExtractionJobQueue;
  let prescriptionService: PrescriptionService;
  let timelineService: TimelineService;

  const patientA = 'pat_userA';
  const patientB = 'pat_userB';
  const tokenPatientA = 'mock-access-jwt-userA';
  const tokenPatientB = 'mock-access-jwt-userB';

  beforeEach(() => {
    uploadIntentRepo = new InMemoryUploadIntentRepository();
    docRepo = new InMemoryDocumentRepository();
    jobRepo = new InMemoryExtractionJobRepository();
    prescriptionRepo = new InMemoryPrescriptionRepository(jobRepo, docRepo);
    timelineRepo = new InMemoryTimelineRepository(prescriptionRepo, docRepo);
    storageProvider = new MemoryStorageProvider(uploadIntentRepo);
    documentService = new DocumentService(storageProvider, docRepo);
    jobQueue = new ExtractionJobQueue(new MockPrescriptionExtractionProvider(), documentService, jobRepo);
    prescriptionService = new PrescriptionService(prescriptionRepo);
    timelineService = new TimelineService(timelineRepo, documentService);

    app = createApp({
      storageProvider,
      documentService,
      jobQueue,
      prescriptionService,
      timelineService,
      docRepo,
      jobRepo,
      prescriptionRepo,
      uploadIntentRepo,
      timelineRepo,
    });
  });

  // Helper to create and confirm a prescription for testing
  async function seedConfirmedPrescription(options: {
    patientProfileId: string;
    prescriptionDate: string;
    dateIsUncertain?: boolean;
    doctorName?: string;
    clinicHospitalName?: string;
    diagnosis?: string;
    medicines: Array<{
      nameAsWritten: string;
      normalizedMedicineName?: string;
      isActiveMedication?: boolean;
    }>;
    fileContent?: string;
    filename?: string;
  }) {
    const docUuid = crypto.randomUUID();
    const storageKey = `documents/${options.patientProfileId}/${docUuid}`;
    const filename = options.filename || 'rx_scan.pdf';

    // 1. Upload document bytes to storage
    await storageProvider.putObjectDirect(storageKey, Buffer.from(options.fileContent || '%PDF-test'));

    // 2. Create document record
    const doc = await docRepo.create({
      id: docUuid,
      patientProfileId: options.patientProfileId,
      storageKey,
      originalFilename: filename,
      mimeType: 'application/pdf',
      fileSizeBytes: 1024,
      sha256Checksum: 'dummy-checksum',
      status: 'CONFIRMED',
      pageCount: 1,
    });

    // 3. Create succeeded extraction job
    const job = await jobRepo.create({
      patientProfileId: options.patientProfileId,
      documentId: doc.id,
      idempotencyKey: `idemp-${docUuid}`,
      providerName: 'mock',
      status: 'SUCCEEDED',
      retryCount: 0,
      maxRetries: 3,
      extractedPayload: { medicines: [] },
    });

    // 4. Confirm prescription
    const confirmationResult = await prescriptionRepo.confirmPrescriptionTransaction({
      patientProfileId: options.patientProfileId,
      documentId: doc.id,
      jobId: job.id,
      prescription: {
        prescriptionDate: options.prescriptionDate,
        dateIsUncertain: options.dateIsUncertain ?? false,
        doctorName: options.doctorName,
        clinicHospitalName: options.clinicHospitalName,
        diagnosis: options.diagnosis,
        confirmedByUserId: 'usr-1',
      },
      items: options.medicines.map((m) => ({
        nameAsWritten: m.nameAsWritten,
        normalizedMedicineName: m.normalizedMedicineName,
        dosageForm: 'TABLET',
        route: 'ORAL',
        isActiveMedication: Boolean(m.isActiveMedication),
      })),
      timelineEvent: {
        eventDate: options.prescriptionDate,
        title: `Prescription — ${options.doctorName || 'General Consultation'}`,
        summary: `${options.medicines.length} medication(s) prescribed`,
      },
    });

    return {
      doc,
      job,
      prescription: confirmationResult.prescription,
      timelineEvent: confirmationResult.timelineEvent,
    };
  }

  it('presents an empty timeline with 200 OK and totalCount: 0 when no events exist', async () => {
    const res = await request(app)
      .get('/api/v1/timeline')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toEqual({
      totalCount: 0,
      limit: 20,
      offset: 0,
      hasMore: false,
    });
  });

  it('guarantees unreviewed AI extraction drafts NEVER enter the verified timeline', async () => {
    // 1. Create a document and a job that is still QUEUED / PROCESSING
    const doc = await docRepo.create({
      id: crypto.randomUUID(),
      patientProfileId: patientA,
      storageKey: `documents/${patientA}/${crypto.randomUUID()}`,
      originalFilename: 'unreviewed.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 2048,
      sha256Checksum: 'hash1',
      status: 'UPLOADED',
    });

    await jobRepo.create({
      patientProfileId: patientA,
      documentId: doc.id,
      idempotencyKey: 'idemp-unreviewed',
      providerName: 'mock',
    });

    // Timeline must remain completely empty because no explicit patient confirmation occurred
    const res = await request(app)
      .get('/api/v1/timeline')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('orders confirmed medical events chronologically, newest eventDate first by default', async () => {
    await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2024-03-15',
      doctorName: 'Dr. Oldest',
      medicines: [{ nameAsWritten: 'Aspirin 75mg' }],
    });

    await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-10-12',
      doctorName: 'Dr. Newest',
      medicines: [{ nameAsWritten: 'Telmisartan 40mg' }],
    });

    await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2025-06-20',
      doctorName: 'Dr. Middle',
      medicines: [{ nameAsWritten: 'Metformin 500mg' }],
    });

    const res = await request(app)
      .get('/api/v1/timeline')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    // Newest first
    expect(res.body.data[0].eventDate).toBe('2026-10-12');
    expect(res.body.data[0].title).toContain('Dr. Newest');

    expect(res.body.data[1].eventDate).toBe('2025-06-20');
    expect(res.body.data[1].title).toContain('Dr. Middle');

    expect(res.body.data[2].eventDate).toBe('2024-03-15');
    expect(res.body.data[2].title).toContain('Dr. Oldest');
  });

  it('correctly tags date uncertainty and preserves date precision', async () => {
    await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-01-01',
      dateIsUncertain: true,
      doctorName: 'Dr. Uncertain',
      medicines: [{ nameAsWritten: 'Paracetamol' }],
    });

    const res = await request(app)
      .get('/api/v1/timeline')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0].dateIsUncertain).toBe(true);
    expect(res.body.data[0].datePrecision).toBe('UNCERTAIN');
  });

  it('filters timeline events by year', async () => {
    await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2025-05-10',
      doctorName: 'Dr. 2025',
      medicines: [{ nameAsWritten: 'Med 1' }],
    });
    await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-08-14',
      doctorName: 'Dr. 2026',
      medicines: [{ nameAsWritten: 'Med 2' }],
    });

    const res2026 = await request(app)
      .get('/api/v1/timeline?year=2026')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(res2026.status).toBe(200);
    expect(res2026.body.data).toHaveLength(1);
    expect(res2026.body.data[0].eventDate).toContain('2026');

    const res2025 = await request(app)
      .get('/api/v1/timeline?year=2025')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(res2025.status).toBe(200);
    expect(res2025.body.data).toHaveLength(1);
    expect(res2025.body.data[0].eventDate).toContain('2025');

    const res2020 = await request(app)
      .get('/api/v1/timeline?year=2020')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(res2020.status).toBe(200);
    expect(res2020.body.data).toHaveLength(0);
  });

  it('filters timeline events by category', async () => {
    await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-02-14',
      doctorName: 'Dr. Cardiology',
      medicines: [{ nameAsWritten: 'Atorvastatin' }],
    });

    const resRx = await request(app)
      .get('/api/v1/timeline?category=PRESCRIPTION')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(resRx.status).toBe(200);
    expect(resRx.body.data).toHaveLength(1);

    const resConsult = await request(app)
      .get('/api/v1/timeline?category=INVESTIGATION')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(resConsult.status).toBe(200);
    expect(resConsult.body.data).toHaveLength(0);
  });

  it('searches events across title, summary, doctor, clinic, diagnosis, and medicine names', async () => {
    await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-03-01',
      doctorName: 'Dr. A. K. Sen',
      clinicHospitalName: 'Max Healthcare',
      diagnosis: 'Hypertension Stage 2',
      medicines: [
        { nameAsWritten: 'Tab Telma-AM', normalizedMedicineName: 'Telmisartan + Amlodipine' },
      ],
    });

    await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-04-01',
      doctorName: 'Dr. Sunita Rao',
      clinicHospitalName: 'Apollo Cradle',
      diagnosis: 'Iron Deficiency Anemia',
      medicines: [{ nameAsWritten: 'Orofer XT', normalizedMedicineName: 'Ferrous Ascorbate' }],
    });

    // 1. Search by doctor name
    const resDoctor = await request(app)
      .get('/api/v1/timeline?search=Sen')
      .set('Authorization', `Bearer ${tokenPatientA}`);
    expect(resDoctor.body.data).toHaveLength(1);
    expect(resDoctor.body.data[0].title).toContain('Dr. A. K. Sen');

    // 2. Search by diagnosis
    const resDiag = await request(app)
      .get('/api/v1/timeline?search=Anemia')
      .set('Authorization', `Bearer ${tokenPatientA}`);
    expect(resDiag.body.data).toHaveLength(1);
    expect(resDiag.body.data[0].title).toContain('Dr. Sunita Rao');

    // 3. Search by medicine name as written
    const resMedWritten = await request(app)
      .get('/api/v1/timeline?search=Telma')
      .set('Authorization', `Bearer ${tokenPatientA}`);
    expect(resMedWritten.body.data).toHaveLength(1);

    // 4. Search by normalized medicine name
    const resNorm = await request(app)
      .get('/api/v1/timeline?search=Ferrous')
      .set('Authorization', `Bearer ${tokenPatientA}`);
    expect(resNorm.body.data).toHaveLength(1);
  });

  it('supports stable pagination with limit, offset, and totalCount', async () => {
    // Seed 5 records
    for (let i = 1; i <= 5; i++) {
      await seedConfirmedPrescription({
        patientProfileId: patientA,
        prescriptionDate: `2026-0${i}-10`,
        doctorName: `Dr. Number ${i}`,
        medicines: [{ nameAsWritten: `Medicine ${i}` }],
      });
    }

    // Page 1: take 2
    const page1 = await request(app)
      .get('/api/v1/timeline?limit=2&offset=0')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.pagination.totalCount).toBe(5);
    expect(page1.body.pagination.hasMore).toBe(true);
    expect(page1.body.data[0].eventDate).toBe('2026-05-10'); // newest

    // Page 2: take 2 offset 2
    const page2 = await request(app)
      .get('/api/v1/timeline?limit=2&offset=2')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.pagination.offset).toBe(2);
    expect(page2.body.pagination.hasMore).toBe(true);

    // Page 3: take 2 offset 4 (last 1 item)
    const page3 = await request(app)
      .get('/api/v1/timeline?limit=2&offset=4')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(page3.status).toBe(200);
    expect(page3.body.data).toHaveLength(1);
    expect(page3.body.pagination.hasMore).toBe(false);
  });

  it('retrieves detailed event info including prescription items and document metadata', async () => {
    const seed = await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-07-22',
      doctorName: 'Dr. V. Mohan',
      clinicHospitalName: 'Dr. Mohans Diabetes Centre',
      diagnosis: 'Type 2 Diabetes Mellitus',
      filename: 'dr_mohan_rx.pdf',
      medicines: [
        {
          nameAsWritten: 'Glucophage 500mg',
          normalizedMedicineName: 'Metformin',
          isActiveMedication: true,
        },
        {
          nameAsWritten: 'Januvia 100mg',
          normalizedMedicineName: 'Sitagliptin',
          isActiveMedication: false,
        },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/timeline/${seed.timelineEvent.id}`)
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(res.status).toBe(200);
    const event = res.body.data;
    expect(event.id).toBe(seed.timelineEvent.id);
    expect(event.eventDate).toBe('2026-07-22');
    expect(event.sourceDocument.originalFilename).toBe('dr_mohan_rx.pdf');
    expect(event.prescription.doctorName).toBe('Dr. V. Mohan');
    expect(event.prescription.diagnosis).toBe('Type 2 Diabetes Mellitus');
    expect(event.prescription.items).toHaveLength(2);
    expect(event.prescription.items[0].nameAsWritten).toBe('Glucophage 500mg');
    expect(event.prescription.items[0].isActiveMedication).toBe(true);
    expect(event.prescription.items[1].nameAsWritten).toBe('Januvia 100mg');
    expect(event.prescription.items[1].isActiveMedication).toBe(false);
  });

  it('rejects cross-patient access to timeline events with 404 (IDOR prevention)', async () => {
    const seedA = await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-08-01',
      doctorName: 'Dr. Secret Patient A',
      medicines: [{ nameAsWritten: 'Confidential Med' }],
    });

    // Patient B attempts to access Patient A's timeline event
    const res = await request(app)
      .get(`/api/v1/timeline/${seedA.timelineEvent.id}`)
      .set('Authorization', `Bearer ${tokenPatientB}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });

  it('generates secure short-lived signed URL to preview the original source document', async () => {
    const seed = await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-09-01',
      filename: 'original_prescription.pdf',
      medicines: [{ nameAsWritten: 'Paracetamol' }],
    });

    const res = await request(app)
      .get(`/api/v1/timeline/${seed.timelineEvent.id}/document-url`)
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.signedUrl).toContain('http');
    expect(res.body.data.expiresInSeconds).toBe(900);
    expect(res.body.data.filename).toBe('original_prescription.pdf');
  });

  it('rejects cross-patient requests for source document URL with 404', async () => {
    const seedA = await seedConfirmedPrescription({
      patientProfileId: patientA,
      prescriptionDate: '2026-09-01',
      medicines: [{ nameAsWritten: 'Paracetamol' }],
    });

    const res = await request(app)
      .get(`/api/v1/timeline/${seedA.timelineEvent.id}/document-url`)
      .set('Authorization', `Bearer ${tokenPatientB}`);

    expect(res.status).toBe(404);
  });

  it('rejects invalid query parameters with 400 Bad Request', async () => {
    const resBadYear = await request(app)
      .get('/api/v1/timeline?year=not-a-year')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(resBadYear.status).toBe(400);
    expect(resBadYear.body.error.code).toBe('INVALID_QUERY_PARAMETERS');

    const resBadLimit = await request(app)
      .get('/api/v1/timeline?limit=999')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(resBadLimit.status).toBe(400);

    const resBadId = await request(app)
      .get('/api/v1/timeline/not-a-uuid')
      .set('Authorization', `Bearer ${tokenPatientA}`);

    expect(resBadId.status).toBe(400);
    expect(resBadId.body.error.code).toBe('INVALID_ID');
  });
});
