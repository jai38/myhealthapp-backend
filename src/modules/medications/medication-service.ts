import {
  MedicationRepository,
  MedicationRecord,
  MedicationDetailRecord,
  DoseLogRecord,
  MedicationStatusType,
  DoseStatusType,
} from '../persistence/repositories.js';
import { DocumentService } from '../documents/document-service.js';

export interface MedicationDocumentUrlResponse {
  signedUrl: string;
  expiresInSeconds: number;
  filename: string;
  mimeType: string;
}

export class MedicationService {
  constructor(
    private readonly medicationRepo: MedicationRepository,
    private readonly documentService: DocumentService
  ) {}

  /**
   * List medications for the authenticated patient, optionally filtered by status.
   */
  async listMedications(
    patientProfileId: string,
    status?: MedicationStatusType
  ): Promise<MedicationRecord[]> {
    return this.medicationRepo.listMedications(patientProfileId, status);
  }

  /**
   * Manually creates a medication record and generates dose schedule if reminder times are provided.
   */
  async createManualMedication(
    patientProfileId: string,
    input: {
      nameAsWritten: string;
      dosageForm: string;
      strength?: string;
      route?: string;
      prescribedInstructions?: string;
      reminderTimes?: string[];
      startDate?: string;
      endDate?: string;
      notes?: string;
    }
  ): Promise<MedicationRecord> {
    if (!input.nameAsWritten || !input.nameAsWritten.trim()) {
      const err = new Error('Medication name is required');
      (err as any).statusCode = 400;
      throw err;
    }

    const hasReminders = Boolean(input.reminderTimes && input.reminderTimes.length > 0);
    if (hasReminders && input.reminderTimes) {
      this.validateReminderTimes(input.reminderTimes);
    }

    const created = await this.medicationRepo.createMedication({
      patientProfileId,
      nameAsWritten: input.nameAsWritten.trim(),
      dosageForm: input.dosageForm || 'TABLET',
      strength: input.strength?.trim() || undefined,
      route: input.route || 'ORAL',
      prescribedInstructions: input.prescribedInstructions?.trim() || undefined,
      status: hasReminders ? 'ACTIVE' : 'INACTIVE',
      startDate: input.startDate || new Date().toISOString().split('T')[0],
      endDate: input.endDate,
      reminderTimes: hasReminders ? input.reminderTimes : undefined,
      notes: input.notes?.trim() || undefined,
    });

    if (hasReminders) {
      const now = new Date();
      const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      await this.generateDoseOccurrencesForMedication(created, now, horizon);
    }

    return created;
  }

  /**
   * Retrieves full details, provenance, and dose history for a single medication.
   */
  async getMedicationDetails(
    id: string,
    patientProfileId: string
  ): Promise<MedicationDetailRecord> {
    const med = await this.medicationRepo.getMedicationById(id, patientProfileId);
    if (!med) {
      const err = new Error('Medication record not found');
      (err as any).statusCode = 404;
      throw err;
    }
    return med;
  }

  /**
   * Retrieves a signed URL for the source prescription document.
   */
  async getDocumentSignedUrl(
    id: string,
    patientProfileId: string
  ): Promise<MedicationDocumentUrlResponse> {
    const med = await this.getMedicationDetails(id, patientProfileId);
    if (!med.sourceDocumentId) {
      const err = new Error('No source document associated with this medication');
      (err as any).statusCode = 404;
      throw err;
    }

    try {
      const signedUrl = await this.documentService.getSignedPreviewUrl(
        patientProfileId,
        med.sourceDocumentId
      );
      return {
        signedUrl,
        expiresInSeconds: 900,
        filename: med.sourceDocument?.originalFilename || 'document',
        mimeType: med.sourceDocument?.mimeType || 'application/octet-stream',
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Source document unavailable';
      const error = new Error(`Source document unavailable: ${message}`);
      (error as any).statusCode = 404;
      throw error;
    }
  }

  /**
   * Explicit patient confirmation to activate an eligible medication.
   * CLINICAL SAFETY:
   * - Cannot reactivate completed or discontinued medications.
   * - Requires explicit patient-selected reminder times.
   * - Generates bounded initial rolling window of dose occurrences.
   */
  async activateMedication(
    id: string,
    patientProfileId: string,
    reminderTimes: string[],
    startDate?: string,
    endDate?: string
  ): Promise<MedicationRecord> {
    const med = await this.getMedicationDetails(id, patientProfileId);

    if (med.status === 'COMPLETED' || med.status === 'DISCONTINUED') {
      const err = new Error(
        'Cannot reactivate a completed or discontinued medication. A new prescription or consultation is required.'
      );
      (err as any).statusCode = 400;
      throw err;
    }

    this.validateReminderTimes(reminderTimes);

    // Update schedule preferences and set status to ACTIVE
    await this.medicationRepo.updateReminderSchedule(
      id,
      patientProfileId,
      reminderTimes,
      startDate,
      endDate
    );

    const updated = await this.medicationRepo.updateMedicationStatus(
      id,
      patientProfileId,
      'ACTIVE'
    );

    // Replenish dose occurrences for the next 7 days
    const now = new Date();
    const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    await this.generateDoseOccurrencesForMedication(updated, now, horizon);

    return updated;
  }

  /**
   * Updates patient-selected reminder schedule preferences.
   */
  async updateReminderPreferences(
    id: string,
    patientProfileId: string,
    reminderTimes: string[],
    startDate?: string,
    endDate?: string
  ): Promise<MedicationRecord> {
    const med = await this.getMedicationDetails(id, patientProfileId);

    if (med.status === 'COMPLETED' || med.status === 'DISCONTINUED') {
      const err = new Error('Cannot update schedule for a completed or discontinued medication.');
      (err as any).statusCode = 400;
      throw err;
    }

    this.validateReminderTimes(reminderTimes);

    const updated = await this.medicationRepo.updateReminderSchedule(
      id,
      patientProfileId,
      reminderTimes,
      startDate,
      endDate
    );

    // Cancel future pending doses and regenerate with new times if ACTIVE
    const now = new Date();
    await this.medicationRepo.cancelPendingDosesForMedication(id, patientProfileId, now);

    if (updated.status === 'ACTIVE') {
      const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      await this.generateDoseOccurrencesForMedication(updated, now, horizon);
    }

    return updated;
  }

  /**
   * Pauses an active medication and cancels future pending reminders.
   */
  async pauseMedication(id: string, patientProfileId: string): Promise<MedicationRecord> {
    const med = await this.getMedicationDetails(id, patientProfileId);
    if (med.status !== 'ACTIVE') {
      const err = new Error('Only active medications can be paused');
      (err as any).statusCode = 400;
      throw err;
    }

    const updated = await this.medicationRepo.updateMedicationStatus(
      id,
      patientProfileId,
      'PAUSED'
    );

    // Cancel future pending doses
    await this.medicationRepo.cancelPendingDosesForMedication(id, patientProfileId, new Date());

    return updated;
  }

  /**
   * Resumes a paused medication and regenerates upcoming dose occurrences.
   */
  async resumeMedication(id: string, patientProfileId: string): Promise<MedicationRecord> {
    const med = await this.getMedicationDetails(id, patientProfileId);
    if (med.status !== 'PAUSED') {
      const err = new Error('Only paused medications can be resumed');
      (err as any).statusCode = 400;
      throw err;
    }

    if (!med.reminderTimes || med.reminderTimes.length === 0) {
      const err = new Error('Cannot resume medication without configured reminder times');
      (err as any).statusCode = 400;
      throw err;
    }

    const updated = await this.medicationRepo.updateMedicationStatus(
      id,
      patientProfileId,
      'ACTIVE'
    );

    // Replenish occurrences
    const now = new Date();
    const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    await this.generateDoseOccurrencesForMedication(updated, now, horizon);

    return updated;
  }

  /**
   * Marks a medication as completed (prescribed course finished).
   */
  async completeMedication(id: string, patientProfileId: string): Promise<MedicationRecord> {
    const med = await this.getMedicationDetails(id, patientProfileId);
    if (med.status === 'COMPLETED' || med.status === 'DISCONTINUED') {
      const err = new Error('Medication has already been ended');
      (err as any).statusCode = 400;
      throw err;
    }

    const updated = await this.medicationRepo.updateMedicationStatus(
      id,
      patientProfileId,
      'COMPLETED',
      { completedAt: new Date() }
    );

    // Cancel future pending doses
    await this.medicationRepo.cancelPendingDosesForMedication(id, patientProfileId, new Date());

    return updated;
  }

  /**
   * Marks a medication as discontinued with optional patient-reported reason.
   */
  async discontinueMedication(
    id: string,
    patientProfileId: string,
    reason?: string
  ): Promise<MedicationRecord> {
    const med = await this.getMedicationDetails(id, patientProfileId);
    if (med.status === 'COMPLETED' || med.status === 'DISCONTINUED') {
      const err = new Error('Medication has already been ended');
      (err as any).statusCode = 400;
      throw err;
    }

    const updated = await this.medicationRepo.updateMedicationStatus(
      id,
      patientProfileId,
      'DISCONTINUED',
      {
        discontinuedAt: new Date(),
        discontinuedReason: reason?.trim() || undefined,
      }
    );

    // Cancel future pending doses
    await this.medicationRepo.cancelPendingDosesForMedication(id, patientProfileId, new Date());

    return updated;
  }

  /**
   * Retrieves scheduled dose occurrences within a given time window [from, to].
   * Automatically replenishes occurrences for active medications up to 'to' date (bounded to 14 days max).
   */
  async getDoseOccurrences(
    patientProfileId: string,
    from: Date,
    to: Date
  ): Promise<DoseLogRecord[]> {
    // Bound window to max 30 days
    const maxWindowMs = 30 * 24 * 60 * 60 * 1000;
    if (to.getTime() - from.getTime() > maxWindowMs) {
      const err = new Error('Dose occurrence window cannot exceed 30 days');
      (err as any).statusCode = 400;
      throw err;
    }

    // Replenish active medications within window
    const activeMeds = await this.medicationRepo.listMedications(patientProfileId, 'ACTIVE');
    for (const med of activeMeds) {
      if (med.reminderTimes && med.reminderTimes.length > 0) {
        await this.generateDoseOccurrencesForMedication(med, from, to);
      }
    }

    return this.medicationRepo.listDoseLogs(patientProfileId, from, to);
  }

  /**
   * Records an explicit patient-reported action for a dose occurrence.
   * CLINICAL SAFETY:
   * - Dose actions MUST be explicitly selected by the patient (TAKEN, SKIPPED, SNOOZED).
   * - Viewing or receiving a notification does not record a dose action.
   */
  async recordDoseAction(
    doseLogId: string,
    patientProfileId: string,
    action: 'TAKEN' | 'SKIPPED' | 'SNOOZED',
    meta?: {
      notes?: string;
      snoozeMinutes?: number;
      actionTime?: string;
    }
  ): Promise<DoseLogRecord> {
    const doseLog = await this.medicationRepo.getDoseLogById(doseLogId, patientProfileId);
    if (!doseLog) {
      const err = new Error('Dose log record not found');
      (err as any).statusCode = 404;
      throw err;
    }

    const actionTimestamp = meta?.actionTime ? new Date(meta.actionTime) : new Date();

    let snoozeMinutes = meta?.snoozeMinutes;
    if (action === 'SNOOZED') {
      snoozeMinutes = Math.min(Math.max(snoozeMinutes ?? 15, 5), 120);
    }

    return this.medicationRepo.updateDoseAction(
      doseLogId,
      patientProfileId,
      action,
      actionTimestamp,
      {
        snoozeMinutes,
        notes: meta?.notes?.trim() || undefined,
      }
    );
  }

  /**
   * Corrects a previously recorded dose action if the patient made a mistake.
   */
  async correctDoseAction(
    doseLogId: string,
    patientProfileId: string,
    action: DoseStatusType,
    notes?: string
  ): Promise<DoseLogRecord> {
    const doseLog = await this.medicationRepo.getDoseLogById(doseLogId, patientProfileId);
    if (!doseLog) {
      const err = new Error('Dose log record not found');
      (err as any).statusCode = 404;
      throw err;
    }

    return this.medicationRepo.updateDoseAction(
      doseLogId,
      patientProfileId,
      action,
      new Date(),
      { notes: notes?.trim() || undefined }
    );
  }

  /**
   * Validates array of reminder times in "HH:mm" 24h format.
   */
  private validateReminderTimes(times: string[]): void {
    if (!Array.isArray(times) || times.length === 0) {
      const err = new Error('At least one reminder time is required to activate schedule');
      (err as any).statusCode = 400;
      throw err;
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    for (const t of times) {
      if (!timeRegex.test(t)) {
        const err = new Error(`Invalid reminder time format: "${t}". Expected "HH:mm" in 24-hour time.`);
        (err as any).statusCode = 400;
        throw err;
      }
    }
  }

  /**
   * Helper to generate discrete dose occurrences within a given range [from, to] for a medication.
   */
  private async generateDoseOccurrencesForMedication(
    med: MedicationRecord,
    from: Date,
    to: Date
  ): Promise<void> {
    if (!med.reminderTimes || med.reminderTimes.length === 0) return;

    const medStart = med.startDate ? new Date(med.startDate) : undefined;
    const medEnd = med.endDate ? new Date(med.endDate) : undefined;

    const occurrences: Array<{
      medicationId: string;
      patientProfileId: string;
      scheduledTime: Date;
    }> = [];

    // Iterate through dates from 'from' to 'to'
    const cur = new Date(from);
    cur.setUTCHours(0, 0, 0, 0);

    const endBoundary = new Date(to);
    endBoundary.setUTCHours(23, 59, 59, 999);

    while (cur.getTime() <= endBoundary.getTime()) {
      for (const timeStr of med.reminderTimes) {
        const parts = timeStr.split(':');
        const hours = parseInt(parts[0] ?? '0', 10);
        const minutes = parseInt(parts[1] ?? '0', 10);
        const scheduledTime = new Date(cur);
        scheduledTime.setUTCHours(hours, minutes, 0, 0);

        // Check medication start and end dates
        if (medStart && scheduledTime < medStart) continue;
        if (medEnd) {
          const medEndDay = new Date(medEnd);
          medEndDay.setUTCHours(23, 59, 59, 999);
          if (scheduledTime > medEndDay) continue;
        }

        // Must be within window
        if (scheduledTime >= from && scheduledTime <= to) {
          occurrences.push({
            medicationId: med.id,
            patientProfileId: med.patientProfileId,
            scheduledTime,
          });
        }
      }

      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    if (occurrences.length > 0) {
      await this.medicationRepo.createDoseLogs(occurrences);
    }
  }
}
