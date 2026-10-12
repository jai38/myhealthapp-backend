import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
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
import { MockPrescriptionExtractionProvider } from '../src/modules/ai-extraction/provider.js';
import { PrescriptionService } from '../src/modules/prescriptions/prescription-service.js';
import { TimelineService } from '../src/modules/timeline/timeline-service.js';
import { MedicationService } from '../src/modules/medications/medication-service.js';
import { ReportService } from '../src/modules/reports/report-service.js';

describe('Phase 6 End-to-End Validation: Complete Patient Workflow & Release Readiness', () => {
  let app: any;
  let docRepo: InMemoryDocumentRepository;
  let jobRepo: InMemoryExtractionJobRepository;
  let prescriptionRepo: InMemoryPrescriptionRepository;
  let uploadIntentRepo: InMemoryUploadIntentRepository;
  let timelineRepo: InMemoryTimelineRepository;
  let medicationRepo: InMemoryMedicationRepository;
  let storageProvider: MemoryStorageProvider;
  let documentService: DocumentService;
  let prescriptionService: PrescriptionService;
  let timelineService: TimelineService;
  let medicationService: MedicationService;
  let reportService: ReportService;

  const patientA = 'pat_userA';
  const patientB = 'pat_userB';
  const tokenA = 'Bearer mock-access-jwt-userA';
  const tokenB = 'Bearer mock-access-jwt-userB';

  async function createValidPdf(pages = 1): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) {
      const page = pdfDoc.addPage([500, 700]);
      page.drawText(`Doctor Prescription Note - Page ${i + 1}`);
    }
    return Buffer.from(await pdfDoc.save());
  }

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
    prescriptionService = new PrescriptionService(prescriptionRepo);
    timelineService = new TimelineService(timelineRepo, documentService);
    medicationService = new MedicationService(medicationRepo, documentService);
    reportService = new ReportService(timelineRepo, medicationRepo, documentService);

    const extractionProvider = new MockPrescriptionExtractionProvider({ mode: 'CLEAN' });

    app = createApp({
      storageProvider,
      docRepo,
      jobRepo,
      prescriptionRepo,
      timelineRepo,
      medicationRepo,
      uploadIntentRepo,
      documentService,
      extractionProvider,
      prescriptionService,
      timelineService,
      medicationService,
      reportService,
    });
  });

  it('executes full sequential patient journey: Upload -> AI Draft -> Confirmation -> Timeline -> Medications -> Report Export', async () => {
    // -------------------------------------------------------------
    // WORKFLOW A: Prescription Upload & Confirmation
    // -------------------------------------------------------------
    // 1. Generate valid PDF bytes
    const pdfBytes = await createValidPdf(1);
    const checksum = crypto.createHash('sha256').update(pdfBytes).digest('hex');

    // 2. Request pre-signed upload intent with declared size
    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', tokenA)
      .send({
        filename: 'dr_sharma_rx.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: pdfBytes.length,
      });
    expect(intentRes.status).toBe(200);
    const { storageKey } = intentRes.body.data;
    expect(storageKey).toContain(`documents/${patientA}/`);

    // 3. Client uploads genuine PDF bytes directly to storage key
    await storageProvider.putObject(storageKey, patientA, pdfBytes, 'application/pdf');

    // 4. Confirm upload server-side
    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', tokenA)
      .send({
        storageKey,
        clientChecksum: checksum,
      });
    expect(confirmRes.status).toBe(201);
    const documentId = confirmRes.body.data.id;
    expect(confirmRes.body.data.status).toBe('UPLOADED');

    // 5. Start AI extraction job
    const extractRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', tokenA)
      .send({
        documentId,
      });
    expect(extractRes.status).toBe(202);
    const jobId = extractRes.body.data.id;
    expect(extractRes.body.data.status).toBe('SUCCEEDED');

    // CRITICAL SAFETY CHECK: Verify unreviewed AI draft does NOT appear in timeline
    const preConfirmTimeline = await request(app)
      .get('/api/v1/timeline')
      .set('Authorization', tokenA);
    expect(preConfirmTimeline.status).toBe(200);
    expect(preConfirmTimeline.body.data.length).toBe(0);

    // 6. Explicit Patient Confirmation with clinical review
    const confirmRxRes = await request(app)
      .post(`/api/v1/prescriptions/${jobId}/confirm`)
      .set('Authorization', tokenA)
      .send({
        prescription_date: '2026-10-12',
        date_is_uncertain: false,
        doctor_name: 'Dr. Sharma',
        clinic_hospital_name: 'City Heart Clinic',
        documented_diagnosis: 'Hypertension',
        medicines: [
          {
            name_as_written: 'Tab Metformin 500mg',
            normalized_medicine_name: 'Metformin',
            strength: '500mg',
            dosage_form: 'TABLET',
            frequency_text: 'Once daily',
            duration_text: '30 days',
            route: 'ORAL',
            instructions: 'Take after meals',
            is_active_medication: false, // Does not activate without explicit patient action
          },
        ],
      });
    expect(confirmRxRes.status).toBe(201);
    expect(confirmRxRes.body.data.prescription).toBeDefined();
    const prescriptionId = confirmRxRes.body.data.prescription.id;

    // -------------------------------------------------------------
    // WORKFLOW B: Medical Timeline Validation
    // -------------------------------------------------------------
    // 7. Query confirmed timeline events
    const timelineRes = await request(app)
      .get('/api/v1/timeline')
      .set('Authorization', tokenA);
    expect(timelineRes.status).toBe(200);
    expect(timelineRes.body.data.length).toBe(1);
    const timelineEvent = timelineRes.body.data[0];
    expect(timelineEvent.eventType).toBe('PRESCRIPTION_RECORDED');
    expect(timelineEvent.title).toContain('Dr. Sharma');
    expect(timelineEvent.sourcePrescriptionId).toBe(prescriptionId);
    expect(timelineEvent.sourceDocumentId).toBe(documentId);

    // Verify detail retrieval and document signed URL
    const eventDetail = await request(app)
      .get(`/api/v1/timeline/${timelineEvent.id}`)
      .set('Authorization', tokenA);
    expect(eventDetail.status).toBe(200);
    expect(eventDetail.body.data.sourceDocument.originalFilename).toBe('dr_sharma_rx.pdf');

    // -------------------------------------------------------------
    // WORKFLOW C: Medication Lifecycle & Dose Tracking
    // -------------------------------------------------------------
    // 8. Query medications - newly confirmed medications start INACTIVE
    const medsRes = await request(app)
      .get('/api/v1/medications')
      .set('Authorization', tokenA);
    expect(medsRes.status).toBe(200);
    expect(medsRes.body.data.length).toBe(1);
    const med = medsRes.body.data[0];
    expect(med.nameAsWritten).toContain('Metformin');
    expect(med.status).toBe('INACTIVE'); // Requires explicit patient activation

    // 9. Explicit Patient Activation with reminder preferences
    const activateRes = await request(app)
      .post(`/api/v1/medications/${med.id}/activate`)
      .set('Authorization', tokenA)
      .send({
        reminderTimes: ['08:00', '20:00'],
        patientScheduleNotes: 'Take morning dose with toast',
      });
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.data.status).toBe('ACTIVE');
    expect(activateRes.body.data.reminderTimes).toEqual(['08:00', '20:00']);
    expect(activateRes.body.data.prescribedInstructions).toBe('Take after meals'); // Prescribed text preserved

    // 10. Record dose taken
    const dosesSchedule = await request(app)
      .get('/api/v1/medications/doses')
      .set('Authorization', tokenA);
    expect(dosesSchedule.status).toBe(200);
    expect(dosesSchedule.body.data.length).toBeGreaterThanOrEqual(1);

    const firstDose = dosesSchedule.body.data[0];
    const actionRes = await request(app)
      .post(`/api/v1/medications/doses/${firstDose.id}/action`)
      .set('Authorization', tokenA)
      .send({
        action: 'TAKEN',
        notes: 'Taken on time with water',
      });
    expect(actionRes.status).toBe(200);
    expect(actionRes.body.data.status).toBe('TAKEN');
    expect(actionRes.body.data.notes).toBe('Taken on time with water');

    // Verify updated doses history
    const dosesList = await request(app)
      .get('/api/v1/medications/doses')
      .set('Authorization', tokenA);
    expect(dosesList.status).toBe(200);
    const updatedDose = dosesList.body.data.find((d: any) => d.id === firstDose.id);
    expect(updatedDose).toBeDefined();
    expect(updatedDose.status).toBe('TAKEN');



    // -------------------------------------------------------------
    // WORKFLOW D: Medical PDF Report Export
    // -------------------------------------------------------------
    // 11. Preview export records
    const previewRes = await request(app)
      .post('/api/v1/reports/export-data')
      .set('Authorization', tokenA)
      .send({
        includeTimeline: true,
        includeMedications: true,
      });
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.data.summary.totalRecords).toBe(2); // 1 timeline event + 1 medication
    expect(previewRes.body.data.summary.timelineEventsCount).toBe(1);
    expect(previewRes.body.data.summary.medicationsCount).toBe(1);

    // 12. Generate confidential doctor-ready PDF report
    const generateRes = await request(app)
      .post('/api/v1/reports/generate')
      .set('Authorization', tokenA)
      .send({
        title: 'Complete Medical History Summary',
        includeTimeline: true,
        includeMedications: true,
      });
    expect(generateRes.status).toBe(201);
    const reportData = generateRes.body.data;
    expect(reportData.reportId).toBeDefined();
    expect(reportData.downloadUrl).toBeDefined();
    expect(reportData.pageCount).toBeGreaterThanOrEqual(1);
    expect(reportData.pdfBase64).toBeDefined();

    // Verify generated PDF bytes can be parsed by pdf-lib
    const parsedReportPdf = await PDFDocument.load(Buffer.from(reportData.pdfBase64, 'base64'));
    expect(parsedReportPdf.getPageCount()).toBe(reportData.pageCount);

    // 13. Download authorization check (streams PDF binary)
    const downloadRes = await request(app)
      .get(`/api/v1/reports/${reportData.reportId}/download`)
      .set('Authorization', tokenA);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers['content-type']).toBe('application/pdf');
    expect(downloadRes.body.length).toBeGreaterThan(0);

  });

  it('strictly enforces cross-patient IDOR boundaries across all endpoints', async () => {
    // Patient A creates an upload and confirms a prescription
    const pdfBytes = await createValidPdf(1);
    const checksum = crypto.createHash('sha256').update(pdfBytes).digest('hex');

    const intentRes = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', tokenA)
      .send({ filename: 'a.pdf', mimeType: 'application/pdf', fileSizeBytes: pdfBytes.length });
    expect(intentRes.status).toBe(200);
    const { storageKey } = intentRes.body.data;

    await storageProvider.putObject(storageKey, patientA, pdfBytes, 'application/pdf');

    const confirmRes = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', tokenA)
      .send({ storageKey, clientChecksum: checksum });
    expect(confirmRes.status).toBe(201);
    const docAId = confirmRes.body.data.id;

    // 1. Patient B attempts to preview Patient A document -> 404
    const idorDoc = await request(app)
      .get(`/api/v1/documents/${docAId}/preview-url`)
      .set('Authorization', tokenB);
    expect(idorDoc.status).toBe(404);

    // Start extraction job
    const jobRes = await request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', tokenA)
      .send({ documentId: docAId });
    expect(jobRes.status).toBe(202);
    const jobAId = jobRes.body.data.id;

    // 2. Patient B attempts to view Patient A extraction job -> 404
    const idorJob = await request(app)
      .get(`/api/v1/prescriptions/extract-job/${jobAId}`)
      .set('Authorization', tokenB);
    expect(idorJob.status).toBe(404);

    // Confirm prescription for Patient A
    const rxRes = await request(app)
      .post(`/api/v1/prescriptions/${jobAId}/confirm`)
      .set('Authorization', tokenA)
      .send({
        prescription_date: '2026-10-12',
        doctor_name: 'Dr. Private',
        medicines: [
          {
            name_as_written: 'Medicine A',
            dosage_form: 'TABLET',
            route: 'ORAL',
            is_active_medication: false,
          },
        ],
      });
    expect(rxRes.status).toBe(201);

    // 3. Patient B views timeline -> empty (isolated)
    const idorTimeline = await request(app)
      .get('/api/v1/timeline')
      .set('Authorization', tokenB);
    expect(idorTimeline.status).toBe(200);
    expect(idorTimeline.body.data.length).toBe(0);

    // 4. Patient B views medications -> empty (isolated)
    const idorMeds = await request(app)
      .get('/api/v1/medications')
      .set('Authorization', tokenB);
    expect(idorMeds.status).toBe(200);
    expect(idorMeds.body.data.length).toBe(0);

    // Patient A generates a report
    const genReportRes = await request(app)
      .post('/api/v1/reports/generate')
      .set('Authorization', tokenA)
      .send({ title: 'Confidential Report', includeTimeline: true, includeMedications: true });
    expect(genReportRes.status).toBe(201);
    const reportAId = genReportRes.body.data.reportId;

    // 5. Patient B attempts to download Patient A report -> 404
    const idorReport = await request(app)
      .get(`/api/v1/reports/${reportAId}/download`)
      .set('Authorization', tokenB);
    expect(idorReport.status).toBe(404);
  });
});
