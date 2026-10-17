import {
  PatientPrescriptionReview,
  PatientPrescriptionReviewSchema,
} from './schemas.js';
import {
  PrescriptionRepository,
  PrescriptionRecord,
  PrescriptionItemRecord,
  TimelineEventRecord,
  ConfirmedPrescriptionResult,
} from '../persistence/repositories.js';

export {
  PrescriptionRecord,
  PrescriptionItemRecord,
  TimelineEventRecord as MedicalTimelineEvent,
  ConfirmedPrescriptionResult,
};

export class PrescriptionService {
  constructor(private readonly prescriptionRepository: PrescriptionRepository) {}

  /**
   * Confirms a prescription extraction after explicit patient review and editing.
   * Runs in a strict database transaction:
   * - One job cannot be confirmed more than once (concurrency-safe unique constraint).
   * - Preserves exact medicine names as written separately from normalized names.
   * - Explicit uncertainty preservation.
   * - Historical prescriptions default to inactive (no auto-activation).
   * - Ingests verified timeline event.
   * - Any failure rolls back all clinical writes.
   */
  async confirmPrescription(
    authContext: { userId: string; patientProfileId: string },
    jobId: string,
    rawReviewData: PatientPrescriptionReview
  ): Promise<ConfirmedPrescriptionResult> {
    const { patientProfileId, userId } = authContext;

    // 1. Strict schema validation of patient review inputs
    const validatedReview = PatientPrescriptionReviewSchema.parse(rawReviewData);

    const now = new Date();
    const defaultDateStr = now.toISOString().split('T')[0] as string;

    // 2. Prepare transaction payload
    const items = validatedReview.medicines.map((med) => ({
      id: med.id,
      nameAsWritten: med.name_as_written,
      normalizedMedicineName: med.normalized_medicine_name,
      strength: med.strength,
      dosageForm: med.dosage_form,
      frequencyText: med.frequency_text,
      durationText: med.duration_text,
      route: med.route,
      instructions: med.instructions,
      // Medical Safety Rule: Historical prescriptions never automatically activate medication schedules
      isActiveMedication: Boolean(med.is_active_medication),
    }));

    const eventTitle = validatedReview.doctor_name
      ? `Prescription from ${validatedReview.doctor_name}`
      : validatedReview.clinic_hospital_name
      ? `Prescription from ${validatedReview.clinic_hospital_name}`
      : 'Prescription Document';

    const resolvedDocumentId =
      validatedReview.documentId ||
      validatedReview.document_id ||
      (rawReviewData as any).documentId ||
      (rawReviewData as any).document_id ||
      '';

    // 3. Execute atomic transaction in durable repository
    return this.prescriptionRepository.confirmPrescriptionTransaction({
      patientProfileId,
      documentId: resolvedDocumentId,
      jobId,
      prescription: {
        prescriptionDate: validatedReview.prescription_date,
        dateIsUncertain: validatedReview.date_is_uncertain,
        doctorName: validatedReview.doctor_name,
        clinicHospitalName: validatedReview.clinic_hospital_name,
        diagnosis: validatedReview.documented_diagnosis,
        confirmedByUserId: userId,
      },
      items,
      timelineEvent: {
        eventDate: validatedReview.prescription_date ?? defaultDateStr,
        title: eventTitle,
        summary: `${items.length} medication${items.length === 1 ? '' : 's'} recorded`,
      },
    });
  }

  /**
   * Retrieves verified prescriptions for the authenticated patient profile.
   */
  async getPrescription(
    patientProfileId: string,
    prescriptionId: string
  ): Promise<{ prescription: PrescriptionRecord; items: PrescriptionItemRecord[] }> {
    const result = await this.prescriptionRepository.findById(prescriptionId, patientProfileId);
    if (!result) {
      throw new Error('Prescription not found');
    }
    return result;
  }

  /**
   * Retrieves verified timeline events for the authenticated patient profile.
   */
  async getTimelineEvents(patientProfileId: string): Promise<TimelineEventRecord[]> {
    return this.prescriptionRepository.listTimelineEvents(patientProfileId);
  }
}
