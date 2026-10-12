import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../src/app.js';
import {
  InMemoryDocumentRepository,
  InMemoryExtractionJobRepository,
  InMemoryPrescriptionRepository,
  InMemoryUploadIntentRepository,
  InMemoryTimelineRepository,
  InMemoryMedicationRepository,
} from '../src/modules/persistence/repositories.js';
import { DocumentService } from '../src/modules/documents/document-service.js';
import { MemoryStorageProvider } from '../src/modules/storage/storage-provider.js';
import { ExtractionJobQueue } from '../src/modules/ai-extraction/job-queue.js';
import { MockPrescriptionExtractionProvider } from '../src/modules/ai-extraction/provider.js';
import { PrescriptionService } from '../src/modules/prescriptions/prescription-service.js';
import { TimelineService } from '../src/modules/timeline/timeline-service.js';
import { MedicationService } from '../src/modules/medications/medication-service.js';
import { ReportService } from '../src/modules/reports/report-service.js';

describe('Phase 5: Medical PDF Reports & Secure Export API', () => {
  let app: any;
  let docRepo: InMemoryDocumentRepository;
  let jobRepo: InMemoryExtractionJobRepository;
  let prescriptionRepo: InMemoryPrescriptionRepository;
  let uploadIntentRepo: InMemoryUploadIntentRepository;
  let timelineRepo: InMemoryTimelineRepository;
  let medicationRepo: InMemoryMedicationRepository;
  let storageProvider: MemoryStorageProvider;
  let documentService: DocumentService;
  let jobQueue: ExtractionJobQueue;
  let prescriptionService: PrescriptionService;
  let timelineService: TimelineService;
  let medicationService: MedicationService;
  let reportService: ReportService;

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
    medicationRepo = new InMemoryMedicationRepository(prescriptionRepo, docRepo);
    prescriptionRepo.setMedicationRepository(medicationRepo);
    storageProvider = new MemoryStorageProvider(uploadIntentRepo);
    documentService = new DocumentService(storageProvider, docRepo);
    jobQueue = new ExtractionJobQueue(new MockPrescriptionExtractionProvider(), documentService, jobRepo);
    prescriptionService = new PrescriptionService(prescriptionRepo);
    timelineService = new TimelineService(timelineRepo, documentService);
    medicationService = new MedicationService(medicationRepo, documentService);
    reportService = new ReportService(timelineRepo, medicationRepo, documentService);

    app = createApp({
      storageProvider,
      documentService,
      jobQueue,
      prescriptionService,
      timelineService,
      medicationService,
      reportService,
      docRepo,
      jobRepo,
      prescriptionRepo,
      uploadIntentRepo,
      timelineRepo,
      medicationRepo,
    });
  });

  /**
   * Helper to seed a confirmed prescription with medications and timeline events.
   */
  const seedPrescription = async (patientId: string, dateStr: string, options: {
    doctorName?: string;
    clinicHospitalName?: string;
    datePrecision?: string;
    dateIsUncertain?: boolean;
    medicines?: Array<{
      nameAsWritten: string;
      normalizedMedicineName?: string;
      strength?: string;
      dosageForm?: string;
      instructions?: string;
    }>;
  } = {}) => {
    const docUuid = crypto.randomUUID();
    const storageKey = `documents/${patientId}/${docUuid}`;
    await storageProvider.putObject(storageKey, patientId, Buffer.from('%PDF-1.4 mock rx content'), 'application/pdf');

    const doc = await docRepo.create({
      id: docUuid,
      patientProfileId: patientId,
      storageKey,
      originalFilename: `rx-${dateStr}.pdf`,
      mimeType: 'application/pdf',
      fileSizeBytes: 1024,
      status: 'VERIFIED',
    });

    const job = await jobRepo.create({
      patientProfileId: patientId,
      documentId: doc.id,
      idempotencyKey: `job-${Date.now()}-${Math.random()}`,
      status: 'SUCCEEDED',
      providerName: 'mock',
    });

    const defaultMeds = [
      {
        nameAsWritten: 'Tab Metformin 500mg',
        normalizedMedicineName: 'Metformin',
        strength: '500mg',
        dosageForm: 'TABLET',
        route: 'ORAL',
        instructions: '1 tab twice daily with meals',
        isActiveMedication: false,
      },
    ];

    const confirmResult = await prescriptionRepo.confirmPrescriptionTransaction({
      patientProfileId: patientId,
      documentId: doc.id,
      jobId: job.id,
      prescription: {
        prescriptionDate: dateStr,
        dateIsUncertain: options.dateIsUncertain ?? false,
        doctorName: options.doctorName ?? 'Dr. S. Patel',
        clinicHospitalName: options.clinicHospitalName ?? 'Apollo Clinic',
        diagnosis: 'Type 2 Diabetes',
        confirmedByUserId: 'usr-1',
      },
      items: (options.medicines || defaultMeds).map((m) => ({
        nameAsWritten: m.nameAsWritten,
        normalizedMedicineName: m.normalizedMedicineName,
        strength: m.strength || '500mg',
        dosageForm: m.dosageForm || 'TABLET',
        route: 'ORAL',
        instructions: m.instructions || '1 tab daily',
        isActiveMedication: false,
      })),
      timelineEvent: {
        eventDate: dateStr,
        title: `Prescription -- ${options.doctorName ?? 'Dr. S. Patel'}`,
        summary: 'Consultation and medication prescription recorded',
        datePrecision: options.datePrecision ?? 'EXACT',
        dateIsUncertain: options.dateIsUncertain ?? false,
      },
    });

    return { doc, job, confirmResult };
  };

  describe('1. Export Data Configuration & Preview', () => {
    it('retrieves verified records for authenticated patient with full summary counts', async () => {
      await seedPrescription(patientA, '2026-02-15');
      await seedPrescription(patientA, '2026-05-20');

      const res = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          title: 'Full Annual Health Summary',
          includeTimeline: true,
          includeMedications: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.reportTitle).toBe('Full Annual Health Summary');
      expect(res.body.data.summary.timelineEventsCount).toBe(2);
      expect(res.body.data.summary.medicationsCount).toBe(2);
      expect(res.body.data.summary.totalRecords).toBe(4);
      expect(res.body.data.timelineEvents.length).toBe(2);
      expect(res.body.data.medications.length).toBe(2);
    });

    it('correctly filters records strictly by date range', async () => {
      await seedPrescription(patientA, '2026-01-10');
      await seedPrescription(patientA, '2026-04-15');
      await seedPrescription(patientA, '2026-08-20');

      // Request date range: 2026-03-01 to 2026-06-01 (should only include the April record)
      const res = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          startDate: '2026-03-01',
          endDate: '2026-06-01',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.summary.timelineEventsCount).toBe(1);
      expect(res.body.data.timelineEvents[0].eventDate).toBe('2026-04-15');
    });

    it('respects section toggles (timeline-only and medication-only)', async () => {
      await seedPrescription(patientA, '2026-03-15');

      // Timeline-only export
      const resTimelineOnly = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          includeTimeline: true,
          includeMedications: false,
        });

      expect(resTimelineOnly.status).toBe(200);
      expect(resTimelineOnly.body.data.summary.timelineEventsCount).toBe(1);
      expect(resTimelineOnly.body.data.summary.medicationsCount).toBe(0);
      expect(resTimelineOnly.body.data.medications.length).toBe(0);

      // Medication-only export
      const resMedsOnly = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          includeTimeline: false,
          includeMedications: true,
        });

      expect(resMedsOnly.status).toBe(200);
      expect(resMedsOnly.body.data.summary.timelineEventsCount).toBe(0);
      expect(resMedsOnly.body.data.summary.medicationsCount).toBe(1);
      expect(resMedsOnly.body.data.timelineEvents.length).toBe(0);
    });

    it('respects specific record identifier selection filters', async () => {
      const p1 = await seedPrescription(patientA, '2026-01-15');
      const p2 = await seedPrescription(patientA, '2026-02-15');

      const allEvents = await timelineRepo.listTimelineEvents(patientA);
      const selectedId = allEvents.events[0].id;
      const unselectedId = allEvents.events[1].id;

      const res = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          selectedEventIds: [selectedId],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.timelineEvents.length).toBe(1);
      expect(res.body.data.timelineEvents[0].id).toBe(selectedId);
      expect(res.body.data.timelineEvents.some((e: any) => e.id === unselectedId)).toBe(false);
    });
  });

  describe('2. Patient Authorization & Tenant Isolation (IDOR Protection)', () => {
    it('guarantees Patient B cannot export Patient A records (returns only Patient B data)', async () => {
      await seedPrescription(patientA, '2026-03-01');

      // Patient B requests export
      const res = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientB}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.summary.totalRecords).toBe(0);
      expect(res.body.data.timelineEvents.length).toBe(0);
      expect(res.body.data.medications.length).toBe(0);
    });

    it('rejects attempt by Patient B to include Patient A record IDs (cross-tenant ID injection)', async () => {
      await seedPrescription(patientA, '2026-03-01');
      const patientAEvents = await timelineRepo.listTimelineEvents(patientA);
      const patientAEventId = patientAEvents.events[0].id;

      // Patient B specifies Patient A's event ID in selectedEventIds
      const res = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientB}`)
        .send({
          selectedEventIds: [patientAEventId],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.timelineEvents.length).toBe(0);
      expect(res.body.data.summary.totalRecords).toBe(0);
    });

    it('prevents Patient B from downloading a report generated by Patient A (returns 404)', async () => {
      await seedPrescription(patientA, '2026-03-01');

      // Patient A generates report
      const genRes = await request(app)
        .post('/api/v1/reports/generate')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ title: 'Confidential Report' });

      expect(genRes.status).toBe(201);
      const reportId = genRes.body.data.reportId;

      // Patient B attempts to download Patient A's report
      const downloadRes = await request(app)
        .get(`/api/v1/reports/${reportId}/download`)
        .set('Authorization', `Bearer ${tokenPatientB}`);

      expect(downloadRes.status).toBe(404);
      expect(downloadRes.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('3. Medical Data Integrity & Safety Rules', () => {
    it('guarantees unreviewed AI extraction drafts are NEVER included in reports', async () => {
      // 1. Create a confirmed prescription for Patient A
      await seedPrescription(patientA, '2026-03-01');

      // 2. Create an unreviewed / in-progress job that is NOT confirmed
      const unreviewedDoc = await docRepo.create({
        id: crypto.randomUUID(),
        patientProfileId: patientA,
        storageKey: `documents/${patientA}/${crypto.randomUUID()}`,
        originalFilename: 'unreviewed-draft.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 500,
        status: 'UPLOADED',
      });

      await jobRepo.create({
        patientProfileId: patientA,
        documentId: unreviewedDoc.id,
        idempotencyKey: 'unreviewed-job-1',
        status: 'PROCESSING',
        providerName: 'mock',
        extractedPayload: {
          medicines: [{ nameAsWritten: 'Unverified Medicine X' }],
        },
      });

      // Request export
      const res = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.summary.timelineEventsCount).toBe(1);
      // Unreviewed document must not appear
      const eventFilenames = res.body.data.timelineEvents.map((e: any) => e.sourceDocument?.originalFilename);
      expect(eventFilenames).not.toContain('unreviewed-draft.pdf');
    });

    it('preserves date precision and date uncertainty without silent rounding', async () => {
      await seedPrescription(patientA, '2025-06-01', {
        datePrecision: 'MONTH',
        dateIsUncertain: true,
      });

      const res = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({});

      expect(res.status).toBe(200);
      const ev = res.body.data.timelineEvents[0];
      expect(ev.datePrecision).toBe('UNCERTAIN');
      expect(ev.dateIsUncertain).toBe(true);
    });

    it('proves report generation is strictly read-only and does not mutate medication state', async () => {
      await seedPrescription(patientA, '2026-03-01');
      const medsBefore = await medicationRepo.listMedications(patientA);
      expect(medsBefore[0].status).toBe('INACTIVE');

      // Generate report
      const res = await request(app)
        .post('/api/v1/reports/generate')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ title: 'Safety Audit Report' });

      expect(res.status).toBe(201);

      // Verify medications state after generation
      const medsAfter = await medicationRepo.listMedications(patientA);
      expect(medsAfter[0].status).toBe('INACTIVE');
      expect(medsAfter[0].updatedAt.getTime()).toBe(medsBefore[0].updatedAt.getTime());
    });
  });

  describe('4. Validation & Error Handling', () => {
    it('rejects invalid date format with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ startDate: 'not-a-valid-date' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Invalid start date format');
    });

    it('rejects inverted date range (start date after end date) with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/v1/reports/export-data')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          startDate: '2026-12-01',
          endDate: '2026-01-01',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Start date cannot be after end date');
    });

    it('rejects generation when no records match and allowEmpty is false', async () => {
      // Patient A has no records in 2020
      const res = await request(app)
        .post('/api/v1/reports/generate')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          startDate: '2020-01-01',
          endDate: '2020-02-01',
          allowEmpty: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('EMPTY_REPORT_ERROR');
    });

    it('allows generation when allowEmpty is explicitly true', async () => {
      const res = await request(app)
        .post('/api/v1/reports/generate')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          startDate: '2020-01-01',
          endDate: '2020-02-01',
          allowEmpty: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.summary.totalRecords).toBe(0);
      expect(res.body.data.reportId).toBeDefined();
    });

    it('rejects invalid report ID format on download with 400', async () => {
      const res = await request(app)
        .get('/api/v1/reports/invalid-uuid-format/download')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ID');
    });
  });

  describe('5. PDF Generation & Secure Artifact Streaming', () => {
    it('generates a confidential report, creates a private document record, and returns signed URL and base64', async () => {
      await seedPrescription(patientA, '2026-03-15');

      const res = await request(app)
        .post('/api/v1/reports/generate')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          title: 'Comprehensive Clinical Export',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.reportId).toBeDefined();
      expect(res.body.data.filename).toMatch(/^medical-report-/);
      expect(res.body.data.fileSizeBytes).toBeGreaterThan(500);
      expect(res.body.data.pageCount).toBeGreaterThanOrEqual(1);
      expect(res.body.data.downloadUrl).toBeDefined();
      expect(res.body.data.pdfBase64).toBeDefined();

      // Verify the base64 payload decodes to a valid PDF
      const pdfBuffer = Buffer.from(res.body.data.pdfBase64, 'base64');
      expect(pdfBuffer.slice(0, 4).toString()).toBe('%PDF');
    });

    it('directly streams binary PDF via POST /api/v1/reports/generate-pdf', async () => {
      await seedPrescription(patientA, '2026-03-15');

      const res = await request(app)
        .post('/api/v1/reports/generate-pdf')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          title: 'Direct Stream Export',
        })
        .responseType('blob');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      const bodyBuffer = Buffer.from(res.body);
      expect(bodyBuffer.slice(0, 4).toString()).toBe('%PDF');
    });

    it('streams stored report PDF via GET /api/v1/reports/:id/download for authorized owner', async () => {
      await seedPrescription(patientA, '2026-03-15');

      const genRes = await request(app)
        .post('/api/v1/reports/generate')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ title: 'Downloadable Report' });

      const reportId = genRes.body.data.reportId;

      const downloadRes = await request(app)
        .get(`/api/v1/reports/${reportId}/download`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .responseType('blob');

      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers['content-type']).toContain('application/pdf');
      expect(downloadRes.headers['content-disposition']).toContain('attachment');
      const bodyBuffer = Buffer.from(downloadRes.body);
      expect(bodyBuffer.slice(0, 4).toString()).toBe('%PDF');
    });
  });
});
