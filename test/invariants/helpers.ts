/**
 * Shared fixture for the invariant kit. One in-memory app, two patients, and a complete set of
 * resources owned by Patient A (document, job, prescription, timeline event, medications, dose,
 * report) so every invariant test can aim Patient B at real identifiers.
 *
 * Tokens use the mock auth adapter format (`mock-access-jwt-<userId>`), which maps to
 * patientProfileId `pat_<userId>`.
 */
import crypto from 'crypto';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import {
  InMemoryDocumentRepository,
  InMemoryExtractionJobRepository,
  InMemoryPrescriptionRepository,
  InMemoryUploadIntentRepository,
  InMemoryTimelineRepository,
  InMemoryMedicationRepository,
} from '../../src/modules/persistence/repositories.js';
import { MemoryStorageProvider } from '../../src/modules/storage/storage-provider.js';
import { MockPrescriptionExtractionProvider } from '../../src/modules/ai-extraction/provider.js';

export const API = '/api/v1';
export const PATIENT_A = 'pat_userA';
export const PATIENT_B = 'pat_userB';
export const TOKEN_A = 'Bearer mock-access-jwt-userA';
export const TOKEN_B = 'Bearer mock-access-jwt-userB';

/** Strings that must never leak into logs, audit rows, or another patient's responses. */
export const PLANTED = {
  drug: 'Zorbexilan-PLANTED-DRUG',
  doctor: 'Dr. Plantedname Quillfeather',
  diagnosis: 'Plantedosis-DIAGNOSIS',
  note: 'planted-private-note-xyzzy',
  instructions: 'planted-instructions-plugh',
  clinic: 'Planted Clinic of Frobnitz',
  filename: 'planted-filename-grault.pdf',
} as const;

export async function makePdf(label = 'Doctor Prescription Note'): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([500, 700]).drawText(label);
  return Buffer.from(await pdf.save());
}

export interface World {
  app: Express;
  storage: MemoryStorageProvider;
  repos: {
    docRepo: InMemoryDocumentRepository;
    jobRepo: InMemoryExtractionJobRepository;
    prescriptionRepo: InMemoryPrescriptionRepository;
    uploadIntentRepo: InMemoryUploadIntentRepository;
    timelineRepo: InMemoryTimelineRepository;
    medicationRepo: InMemoryMedicationRepository;
  };
}

export function buildWorld(extractionProvider?: MockPrescriptionExtractionProvider): World {
  const uploadIntentRepo = new InMemoryUploadIntentRepository();
  const docRepo = new InMemoryDocumentRepository();
  const jobRepo = new InMemoryExtractionJobRepository();
  const prescriptionRepo = new InMemoryPrescriptionRepository(jobRepo, docRepo);
  const timelineRepo = new InMemoryTimelineRepository(prescriptionRepo, docRepo);
  const medicationRepo = new InMemoryMedicationRepository(prescriptionRepo, docRepo);
  prescriptionRepo.setMedicationRepository(medicationRepo);
  const storage = new MemoryStorageProvider(uploadIntentRepo);
  const app = createApp({
    storageProvider: storage,
    docRepo,
    jobRepo,
    prescriptionRepo,
    timelineRepo,
    medicationRepo,
    uploadIntentRepo,
    extractionProvider: extractionProvider ?? new MockPrescriptionExtractionProvider({ mode: 'CLEAN' }),
  });
  return { app, storage, repos: { docRepo, jobRepo, prescriptionRepo, uploadIntentRepo, timelineRepo, medicationRepo } };
}

/** Uploads a real PDF for the given patient through the real intent/confirm endpoints. */
export async function uploadDocument(
  w: World,
  token: string,
  patientProfileId: string,
  filename = 'rx.pdf',
): Promise<{ documentId: string; storageKey: string }> {
  const bytes = await makePdf();
  const intent = await request(w.app)
    .post(`${API}/documents/upload-intent`)
    .set('Authorization', token)
    .send({ filename, mimeType: 'application/pdf', fileSizeBytes: bytes.length });
  if (intent.status !== 200) throw new Error(`upload-intent failed: ${intent.status}`);
  const storageKey: string = intent.body.data.storageKey;
  await w.storage.putObject(storageKey, patientProfileId, bytes, 'application/pdf');
  const confirm = await request(w.app)
    .post(`${API}/documents/confirm-upload`)
    .set('Authorization', token)
    .send({ storageKey, clientChecksum: crypto.createHash('sha256').update(bytes).digest('hex') });
  if (confirm.status !== 201) {
    throw new Error(`confirm-upload failed: ${confirm.status} ${JSON.stringify(confirm.body)}`);
  }
  return { documentId: confirm.body.data.id, storageKey };
}

export function reviewBody(overrides: Record<string, unknown> = {}, medOverrides: Record<string, unknown> = {}) {
  return {
    prescription_date: '2026-10-12',
    date_is_uncertain: false,
    doctor_name: PLANTED.doctor,
    clinic_hospital_name: PLANTED.clinic,
    documented_diagnosis: PLANTED.diagnosis,
    medicines: [
      {
        name_as_written: PLANTED.drug,
        normalized_medicine_name: 'Metformin',
        strength: '500mg',
        dosage_form: 'TABLET',
        frequency_text: 'Once daily',
        duration_text: '30 days',
        route: 'ORAL',
        instructions: PLANTED.instructions,
        is_active_medication: false,
        ...medOverrides,
      },
    ],
    ...overrides,
  };
}

export interface PatientAResources {
  documentId: string;
  storageKey: string;
  queuedJobId: string;
  jobId: string;
  prescriptionId: string;
  eventId: string;
  medicationId: string;
  manualMedicationId: string;
  doseId: string;
  reportId: string;
}

/** Builds a full set of resources owned by Patient A. */
export async function seedPatientA(w: World): Promise<PatientAResources> {
  const { documentId, storageKey } = await uploadDocument(w, TOKEN_A, PATIENT_A, PLANTED.filename);
  const second = await uploadDocument(w, TOKEN_A, PATIENT_A, 'second.pdf');

  const queued = await request(w.app)
    .post(`${API}/prescriptions/extract-job`)
    .set('Authorization', TOKEN_A)
    .send({ documentId: second.documentId, autoProcess: false });
  if (queued.status !== 202) throw new Error(`queued job failed: ${queued.status}`);

  const job = await request(w.app)
    .post(`${API}/prescriptions/extract-job`)
    .set('Authorization', TOKEN_A)
    .send({ documentId });
  if (job.status !== 202) throw new Error(`job failed: ${job.status}`);
  const jobId: string = job.body.data.id;

  const rx = await request(w.app)
    .post(`${API}/prescriptions/${jobId}/confirm`)
    .set('Authorization', TOKEN_A)
    .send(reviewBody());
  if (rx.status !== 201) throw new Error(`confirm failed: ${rx.status} ${JSON.stringify(rx.body)}`);

  const timeline = await request(w.app).get(`${API}/timeline`).set('Authorization', TOKEN_A);
  const meds = await request(w.app).get(`${API}/medications`).set('Authorization', TOKEN_A);

  const manual = await request(w.app)
    .post(`${API}/medications`)
    .set('Authorization', TOKEN_A)
    .send({ nameAsWritten: 'Manual-A-Med', reminderTimes: ['08:00', '20:00'] });
  if (manual.status !== 201) throw new Error(`manual med failed: ${manual.status} ${JSON.stringify(manual.body)}`);

  const doses = await request(w.app).get(`${API}/medications/doses`).set('Authorization', TOKEN_A);
  if (!doses.body.data?.length) throw new Error('no doses were generated for Patient A');

  const report = await request(w.app)
    .post(`${API}/reports/generate`)
    .set('Authorization', TOKEN_A)
    .send({ title: 'A report', includeTimeline: true, includeMedications: true });
  if (report.status !== 201) throw new Error(`report failed: ${report.status}`);

  return {
    documentId,
    storageKey,
    queuedJobId: queued.body.data.id,
    jobId,
    prescriptionId: rx.body.data.prescription.id,
    eventId: timeline.body.data[0].id,
    medicationId: meds.body.data[0].id,
    manualMedicationId: manual.body.data.id,
    doseId: doses.body.data[0].id,
    reportId: report.body.data.reportId,
  };
}
