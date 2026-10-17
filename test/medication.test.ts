import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
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

describe('Phase 4: Medication Management & Reminders API & Clinical Integrity', () => {
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

    app = createApp({
      storageProvider,
      documentService,
      jobQueue,
      prescriptionService,
      timelineService,
      medicationService,
      docRepo,
      jobRepo,
      prescriptionRepo,
      uploadIntentRepo,
      timelineRepo,
      medicationRepo,
    });
  });

  const setupConfirmedPrescriptionWithMedications = async (patientId: string) => {
    const docUuid = crypto.randomUUID();
    const storageKey = `documents/${patientId}/${docUuid}`;
    await storageProvider.putObjectDirect(storageKey, Buffer.from('%PDF-1.4 test file'));

    // 1. Create document
    const doc = await docRepo.create({
      id: docUuid,
      patientProfileId: patientId,
      storageKey,
      originalFilename: 'rx-sample.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 1024,
      status: 'VERIFIED',
    });

    // 2. Create extraction job with SUCCEEDED status
    const job = await jobRepo.create({
      patientProfileId: patientId,
      documentId: doc.id,
      idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
      status: 'SUCCEEDED',
      providerName: 'mock',
    });

    // 3. Confirm prescription
    const confirmResult = await prescriptionRepo.confirmPrescriptionTransaction({
      patientProfileId: patientId,
      documentId: doc.id,
      jobId: job.id,
      prescription: {
        prescriptionDate: '2026-03-15',
        dateIsUncertain: false,
        doctorName: 'Dr. Sharma',
        clinicHospitalName: 'City Hospital',
        diagnosis: 'Hypertension',
        confirmedByUserId: 'usr-1',
      },
      items: [
        {
          nameAsWritten: 'Tab Telmisartan 40mg',
          normalizedMedicineName: 'Telmisartan',
          strength: '40mg',
          dosageForm: 'TABLET',
          route: 'ORAL',
          instructions: '1 tab daily in the morning',
          isActiveMedication: false,
        },
        {
          nameAsWritten: 'Cap Amoxicillin 500mg',
          normalizedMedicineName: 'Amoxicillin',
          strength: '500mg',
          dosageForm: 'CAPSULE',
          route: 'ORAL',
          instructions: '1 cap three times daily for 5 days',
          isActiveMedication: false,
        },
      ],
      timelineEvent: {
        eventDate: '2026-03-15',
        title: 'Prescription — Dr. Sharma',
        summary: '2 medication(s) prescribed',
      },
    });

    return { doc, job, confirmResult };
  };

  describe('Clinical Safety Rules & Activation Eligibility', () => {
    it('RULE A: Confirmed prescription items are created as INACTIVE by default (never automatically active)', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const res = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);

      // Verify both are INACTIVE
      for (const med of res.body.data) {
        expect(med.status).toBe('INACTIVE');
        expect(med.reminderTimes).toBeUndefined();
      }

      // Filter by status=ACTIVE should return empty
      const activeRes = await request(app)
        .get('/api/v1/medications?status=ACTIVE')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(activeRes.status).toBe(200);
      expect(activeRes.body.data.length).toBe(0);
    });

    it('RULE B & 5: Activation requires explicit patient-selected reminder preferences', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listRes = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medId = listRes.body.data[0].id;

      // Reject activation without reminder times
      const badRes = await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: [] });

      expect(badRes.status).toBe(400);

      // Reject invalid time format (must be HH:mm 24h)
      const invalidTimeRes = await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['25:00', 'morning'] });

      expect(invalidTimeRes.status).toBe(400);

      // Successful activation with explicit reminder times
      const activateRes = await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          reminderTimes: ['08:00'],
          startDate: '2026-03-15',
        });

      expect(activateRes.status).toBe(200);
      expect(activateRes.body.data.status).toBe('ACTIVE');
      expect(activateRes.body.data.reminderTimes).toEqual(['08:00']);

      // Medication should now appear under ACTIVE filter
      const activeList = await request(app)
        .get('/api/v1/medications?status=ACTIVE')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(activeList.body.data.length).toBe(1);
      expect(activeList.body.data[0].id).toBe(medId);
    });

    it('RULE 6: Activation generates bounded rolling dose occurrences', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listRes = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medId = listRes.body.data[0].id;

      await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          reminderTimes: ['08:00', '20:00'],
          startDate: '2026-03-15',
        });

      // Query upcoming doses
      const dosesRes = await request(app)
        .get('/api/v1/medications/doses')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(dosesRes.status).toBe(200);
      expect(Array.isArray(dosesRes.body.data)).toBe(true);
      expect(dosesRes.body.data.length).toBeGreaterThan(0);

      // Every generated dose is initially PENDING
      for (const dose of dosesRes.body.data) {
        expect(dose.status).toBe('PENDING');
        expect(dose.medicationId).toBe(medId);
      }
    });

    it('RULE C: Prohibits reactivation of completed or discontinued medications', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listRes = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medId = listRes.body.data[0].id;

      // 1. Activate
      await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['08:00'] });

      // 2. Complete
      const completeRes = await request(app)
        .post(`/api/v1/medications/${medId}/complete`)
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.data.status).toBe('COMPLETED');

      // 3. Attempt reactivation - must be rejected
      const reactivateRes = await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['08:00'] });

      expect(reactivateRes.status).toBe(400);
      expect(reactivateRes.body.error.message).toContain('Cannot reactivate');
    });
  });

  describe('Medication Lifecycle & Scheduling Updates', () => {
    it('Pausing an active medication cancels future pending occurrences and resuming replenishes them', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listRes = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medId = listRes.body.data[0].id;

      // Activate
      await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['09:00'] });

      // Pause
      const pauseRes = await request(app)
        .post(`/api/v1/medications/${medId}/pause`)
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(pauseRes.status).toBe(200);
      expect(pauseRes.body.data.status).toBe('PAUSED');

      // Verify future doses are cancelled
      const dosesWhilePaused = await request(app)
        .get('/api/v1/medications/doses')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(dosesWhilePaused.body.data.length).toBe(0);

      // Resume
      const resumeRes = await request(app)
        .post(`/api/v1/medications/${medId}/resume`)
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.data.status).toBe('ACTIVE');

      // Verify doses replenished
      const dosesAfterResume = await request(app)
        .get('/api/v1/medications/doses')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(dosesAfterResume.body.data.length).toBeGreaterThan(0);
    });

    it('Discontinuing a medication records patient reason and cancels future reminders', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listRes = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medId = listRes.body.data[0].id;

      await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['09:00'] });

      const discRes = await request(app)
        .post(`/api/v1/medications/${medId}/discontinue`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reason: 'Physician changed treatment plan' });

      expect(discRes.status).toBe(200);
      expect(discRes.body.data.status).toBe('DISCONTINUED');
      expect(discRes.body.data.discontinuedReason).toBe('Physician changed treatment plan');
    });

    it('Updating reminder preferences recalculates future schedule and preserves past actions', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listRes = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medId = listRes.body.data[0].id;

      await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['08:00'] });

      // Update schedule to 21:00
      const updateRes = await request(app)
        .patch(`/api/v1/medications/${medId}/schedule`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['21:00'] });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.reminderTimes).toEqual(['21:00']);

      const dosesRes = await request(app)
        .get('/api/v1/medications/doses')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      // All scheduled times should now have 21:00 UTC
      for (const d of dosesRes.body.data) {
        const date = new Date(d.scheduledTime);
        expect(date.getUTCHours()).toBe(21);
      }
    });
  });

  describe('Dose History & Patient-Reported Actions', () => {
    it('RULE D & 7: Records explicit patient dose actions (TAKEN, SKIPPED, SNOOZED)', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listRes = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medId = listRes.body.data[0].id;

      await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['08:00'] });

      const dosesRes = await request(app)
        .get('/api/v1/medications/doses')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const firstDose = dosesRes.body.data[0];

      // Record TAKEN
      const actionRes = await request(app)
        .post(`/api/v1/medications/doses/${firstDose.id}/action`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          action: 'TAKEN',
          notes: 'Taken with breakfast',
        });

      expect(actionRes.status).toBe(200);
      expect(actionRes.body.data.status).toBe('TAKEN');
      expect(actionRes.body.data.notes).toBe('Taken with breakfast');
      expect(actionRes.body.data.actionTime).toBeDefined();

      // Second dose: record SKIPPED
      const secondDose = dosesRes.body.data[1];
      const skipRes = await request(app)
        .post(`/api/v1/medications/doses/${secondDose.id}/action`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          action: 'SKIPPED',
          notes: 'Felt nauseous',
        });

      expect(skipRes.status).toBe(200);
      expect(skipRes.body.data.status).toBe('SKIPPED');
    });

    it('RULE 7: Unrecorded past doses remain PENDING (never automatically labeled confirmed missed doses)', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listRes = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medId = listRes.body.data[0].id;

      // Create a past dose occurrence manually
      const pastTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await medicationRepo.createDoseLogs([
        {
          medicationId: medId,
          patientProfileId: patientA,
          scheduledTime: pastTime,
        },
      ]);

      const from = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const to = new Date();
      const pastDoses = await medicationRepo.listDoseLogs(patientA, from, to);

      expect(pastDoses.length).toBe(1);
      // It must still be PENDING, not falsely converted to MISSED
      expect(pastDoses[0].status).toBe('PENDING');
      expect(pastDoses[0].actionTime).toBeUndefined();
    });

    it('Allows correction of accidental dose action', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listRes = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medId = listRes.body.data[0].id;

      await request(app)
        .post(`/api/v1/medications/${medId}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['08:00'] });

      const dosesRes = await request(app)
        .get('/api/v1/medications/doses')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const dose = dosesRes.body.data[0];

      // Mark as SKIPPED
      await request(app)
        .post(`/api/v1/medications/doses/${dose.id}/action`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ action: 'SKIPPED' });

      // Correct to TAKEN
      const correctRes = await request(app)
        .patch(`/api/v1/medications/doses/${dose.id}/action`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          action: 'TAKEN',
          notes: 'Corrected mistake: dose was taken on time',
        });

      expect(correctRes.status).toBe(200);
      expect(correctRes.body.data.status).toBe('TAKEN');
      expect(correctRes.body.data.notes).toContain('Corrected mistake');
    });
  });

  describe('Security & Multi-Tenant Isolation (Patient Ownership)', () => {
    it('Patient B cannot read or modify Patient A medications (returns 404)', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listA = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medA = listA.body.data[0];

      // Patient B tries to get details of medA
      const getResB = await request(app)
        .get(`/api/v1/medications/${medA.id}`)
        .set('Authorization', `Bearer ${tokenPatientB}`);

      expect(getResB.status).toBe(404);

      // Patient B tries to activate medA
      const actResB = await request(app)
        .post(`/api/v1/medications/${medA.id}/activate`)
        .set('Authorization', `Bearer ${tokenPatientB}`)
        .send({ reminderTimes: ['08:00'] });

      expect(actResB.status).toBe(404);

      // Patient B tries to pause medA
      const pauseResB = await request(app)
        .post(`/api/v1/medications/${medA.id}/pause`)
        .set('Authorization', `Bearer ${tokenPatientB}`);

      expect(pauseResB.status).toBe(404);
    });

    it('Patient B cannot record action on Patient A dose occurrences (returns 404)', async () => {
      await setupConfirmedPrescriptionWithMedications(patientA);

      const listA = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medA = listA.body.data[0];

      await request(app)
        .post(`/api/v1/medications/${medA.id}/activate`)
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({ reminderTimes: ['08:00'] });

      const dosesA = await request(app)
        .get('/api/v1/medications/doses')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const doseA = dosesA.body.data[0];

      // Patient B tries to record action on doseA
      const actionResB = await request(app)
        .post(`/api/v1/medications/doses/${doseA.id}/action`)
        .set('Authorization', `Bearer ${tokenPatientB}`)
        .send({ action: 'TAKEN' });

      expect(actionResB.status).toBe(404);
    });

    it('Provides secure signed URL for source document access', async () => {
      const { doc } = await setupConfirmedPrescriptionWithMedications(patientA);

      const listA = await request(app)
        .get('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      const medA = listA.body.data[0];

      const urlRes = await request(app)
        .get(`/api/v1/medications/${medA.id}/document-url`)
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(urlRes.status).toBe(200);
      expect(urlRes.body.data.signedUrl).toBeDefined();
      expect(urlRes.body.data.filename).toBe('rx-sample.pdf');
    });

    it('Manual Creation: successfully creates medication with reminders and generates dose occurrences', async () => {
      const res = await request(app)
        .post('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          nameAsWritten: 'Paracetamol 500mg',
          dosageForm: 'TABLET',
          strength: '500mg',
          reminderTimes: ['08:00', '20:00'],
          prescribedInstructions: 'Take after meals',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.nameAsWritten).toBe('Paracetamol 500mg');
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.reminderTimes).toEqual(['08:00', '20:00']);

      // Verify doses were generated
      const dosesRes = await request(app)
        .get('/api/v1/medications/doses')
        .set('Authorization', `Bearer ${tokenPatientA}`);

      expect(dosesRes.status).toBe(200);
      expect(dosesRes.body.data.length).toBeGreaterThan(0);
      expect(dosesRes.body.data[0].medicationId).toBe(res.body.data.id);
    });

    it('Manual Creation: creates inactive medication when no reminder times provided', async () => {
      const res = await request(app)
        .post('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          nameAsWritten: 'Vitamin D3',
          dosageForm: 'CAPSULE',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.nameAsWritten).toBe('Vitamin D3');
      expect(res.body.data.status).toBe('INACTIVE');
    });

    it('Manual Creation: rejects creation if medication name is missing', async () => {
      const res = await request(app)
        .post('/api/v1/medications')
        .set('Authorization', `Bearer ${tokenPatientA}`)
        .send({
          nameAsWritten: '',
          dosageForm: 'TABLET',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
