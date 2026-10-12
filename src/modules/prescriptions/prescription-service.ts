import crypto from 'crypto';
import {
  PatientPrescriptionReview,
  PatientPrescriptionReviewSchema,
  DosageFormEnum,
  RouteEnum,
} from './schemas.js';
import { DocumentService } from '../documents/document-service.js';
import { ExtractionJobQueue } from '../ai-extraction/job-queue.js';
import { z } from 'zod';

export interface PrescriptionRecord {
  id: string;
  patientProfileId: string;
  documentId: string;
  jobId: string;
  prescriptionDate?: string;
  dateIsUncertain: boolean;
  doctorName?: string;
  clinicHospitalName?: string;
  diagnosis?: string;
  reviewStatus: 'CONFIRMED';
  confirmedAt: Date;
  confirmedByUserId: string;
}

export interface PrescriptionItemRecord {
  id: string;
  prescriptionId: string;
  nameAsWritten: string;
  normalizedMedicineName?: string;
  strength?: string;
  dosageForm: z.infer<typeof DosageFormEnum>;
  frequencyText?: string;
  durationText?: string;
  route: z.infer<typeof RouteEnum>;
  instructions?: string;
  isActiveMedication: boolean;
  sourceDocumentId: string;
}

export interface MedicalTimelineEvent {
  id: string;
  patientProfileId: string;
  eventType: 'PRESCRIPTION_RECORDED';
  eventDate: string;
  title: string;
  summary: string;
  sourceDocumentId: string;
  sourcePrescriptionId: string;
  isVerified: boolean;
  createdAt: Date;
}

export interface ConfirmedPrescriptionResult {
  prescription: PrescriptionRecord;
  items: PrescriptionItemRecord[];
  timelineEvent: MedicalTimelineEvent;
}

export class PrescriptionService {
  private prescriptions: Map<string, PrescriptionRecord> = new Map();
  private prescriptionItems: Map<string, PrescriptionItemRecord[]> = new Map();
  private timelineEvents: Map<string, MedicalTimelineEvent[]> = new Map();
  private confirmedJobIds: Set<string> = new Set();

  constructor(
    private readonly documentService: DocumentService,
    private readonly jobQueue: ExtractionJobQueue
  ) {}

  /**
   * Confirms a prescription extraction after explicit patient review and editing.
   * Creates verified clinical records, preserves provenance, attributes confirmation to user,
   * and ensures historical prescriptions do NOT automatically activate medication regimens.
   */
  async confirmPrescription(
    authContext: { userId: string; patientProfileId: string },
    jobId: string,
    rawReviewData: PatientPrescriptionReview
  ): Promise<ConfirmedPrescriptionResult> {
    const { patientProfileId, userId } = authContext;

    // Check for double confirmation
    if (this.confirmedJobIds.has(jobId)) {
      throw new Error('This extraction job has already been confirmed');
    }

    // 1. Retrieve and verify extraction job
    const job = await this.jobQueue.getJob(patientProfileId, jobId);
    if (job.status !== 'SUCCEEDED') {
      throw new Error(
        `Cannot confirm an unreviewed or non-succeeded extraction job (current status: ${job.status})`
      );
    }

    // 2. Verify source document exists and belongs to the patient
    const doc = await this.documentService.getDocument(patientProfileId, job.documentId);

    // 3. Strict schema validation of patient review inputs
    const validatedReview = PatientPrescriptionReviewSchema.parse(rawReviewData);

    const prescriptionId = crypto.randomUUID();
    const now = new Date();
    const defaultDateStr = now.toISOString().split('T')[0] as string;

    // 4. Create immutable Prescription record
    const prescription: PrescriptionRecord = {
      id: prescriptionId,
      patientProfileId,
      documentId: doc.id,
      jobId: job.id,
      prescriptionDate: validatedReview.prescription_date,
      dateIsUncertain: validatedReview.date_is_uncertain,
      doctorName: validatedReview.doctor_name,
      clinicHospitalName: validatedReview.clinic_hospital_name,
      diagnosis: validatedReview.documented_diagnosis,
      reviewStatus: 'CONFIRMED',
      confirmedAt: now,
      confirmedByUserId: userId,
    };

    // 5. Create immutable Prescription Item records (preserving name as written)
    const items: PrescriptionItemRecord[] = validatedReview.medicines.map((med) => ({
      id: med.id || crypto.randomUUID(),
      prescriptionId,
      nameAsWritten: med.name_as_written,
      normalizedMedicineName: med.normalized_medicine_name,
      strength: med.strength,
      dosageForm: med.dosage_form,
      frequencyText: med.frequency_text,
      durationText: med.duration_text,
      route: med.route,
      instructions: med.instructions,
      // Medical Safety Rule: Historical prescriptions do NOT automatically become active regimens
      isActiveMedication: Boolean(med.is_active_medication),
      sourceDocumentId: doc.id,
    }));

    // 6. Ingest into Verified Clinical Timeline
    const timelineEvent: MedicalTimelineEvent = {
      id: crypto.randomUUID(),
      patientProfileId,
      eventType: 'PRESCRIPTION_RECORDED',
      eventDate: validatedReview.prescription_date ?? defaultDateStr,
      title: validatedReview.doctor_name
        ? `Prescription from ${validatedReview.doctor_name}`
        : validatedReview.clinic_hospital_name
        ? `Prescription from ${validatedReview.clinic_hospital_name}`
        : 'Prescription Document',
      summary: `${items.length} medication${items.length === 1 ? '' : 's'} recorded`,
      sourceDocumentId: doc.id,
      sourcePrescriptionId: prescriptionId,
      isVerified: true,
      createdAt: now,
    };

    // Store records
    this.prescriptions.set(prescriptionId, prescription);
    this.prescriptionItems.set(prescriptionId, items);

    const patientEvents = this.timelineEvents.get(patientProfileId) || [];
    patientEvents.push(timelineEvent);
    this.timelineEvents.set(patientProfileId, patientEvents);

    this.confirmedJobIds.add(jobId);

    // 7. Update document status to CONFIRMED
    await this.documentService.updateStatus(patientProfileId, doc.id, 'CONFIRMED');

    return {
      prescription,
      items,
      timelineEvent,
    };
  }

  /**
   * Retrieves verified prescriptions for the authenticated patient profile.
   */
  async getPrescription(
    patientProfileId: string,
    prescriptionId: string
  ): Promise<{ prescription: PrescriptionRecord; items: PrescriptionItemRecord[] }> {
    const rx = this.prescriptions.get(prescriptionId);
    if (!rx || rx.patientProfileId !== patientProfileId) {
      throw new Error('Prescription not found');
    }
    const items = this.prescriptionItems.get(prescriptionId) || [];
    return { prescription: rx, items };
  }

  /**
   * Retrieves verified timeline events for the authenticated patient profile.
   */
  async getTimelineEvents(patientProfileId: string): Promise<MedicalTimelineEvent[]> {
    return this.timelineEvents.get(patientProfileId) || [];
  }
}
