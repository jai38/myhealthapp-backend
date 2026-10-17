import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from './database.js';

export type DocumentStatus =
  | 'UPLOADED'
  | 'EXTRACTING'
  | 'READY_FOR_REVIEW'
  | 'CONFIRMED'
  | 'FAILED';

export type JobStatus = 'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface DocumentRecord {
  id: string;
  patientProfileId: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256Checksum: string;
  status: DocumentStatus;
  pageCount?: number;
  imageWidth?: number;
  imageHeight?: number;
  uploadedAt: Date;
  updatedAt: Date;
}

export interface ExtractionJobRecord {
  id: string;
  patientProfileId: string;
  documentId: string;
  idempotencyKey: string;
  status: JobStatus;
  retryCount: number;
  maxRetries: number;
  providerName: string;
  extractedPayload?: any;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  confirmedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

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
  createdAt: Date;
  updatedAt: Date;
}

export interface PrescriptionItemRecord {
  id: string;
  prescriptionId: string;
  nameAsWritten: string;
  normalizedMedicineName?: string;
  strength?: string;
  dosageForm: string;
  frequencyText?: string;
  durationText?: string;
  route: string;
  instructions?: string;
  isActiveMedication: boolean;
  sourceDocumentId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TimelineEventRecord {
  id: string;
  patientProfileId: string;
  eventType: string;
  eventDate: string;
  dateIsUncertain?: boolean;
  datePrecision?: string;
  title: string;
  summary: string;
  sourceDocumentId: string;
  sourcePrescriptionId?: string;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TimelineFilterOptions {
  search?: string;
  year?: number;
  category?: string;
  limit?: number;
  offset?: number;
}

export interface TimelineEventDetailRecord extends TimelineEventRecord {
  sourceDocument?: {
    id: string;
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
    pageCount?: number | null;
    uploadedAt: Date;
  };
  prescription?: {
    id: string;
    prescriptionDate?: string;
    dateIsUncertain: boolean;
    doctorName?: string;
    clinicHospitalName?: string;
    diagnosis?: string;
    confirmedAt: Date;
    items: PrescriptionItemRecord[];
  };
}

export interface TimelineRepository {
  listTimelineEvents(
    patientProfileId: string,
    options?: TimelineFilterOptions
  ): Promise<{ events: TimelineEventDetailRecord[]; totalCount: number }>;
  getTimelineEventById(
    id: string,
    patientProfileId: string
  ): Promise<TimelineEventDetailRecord | null>;
}

export type MedicationStatusType = 'INACTIVE' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'DISCONTINUED';
export type DoseStatusType = 'PENDING' | 'TAKEN' | 'SKIPPED' | 'SNOOZED' | 'MISSED';

export interface MedicationRecord {
  id: string;
  patientProfileId: string;
  prescriptionItemId?: string | null;
  prescriptionId?: string | null;
  sourceDocumentId?: string | null;
  nameAsWritten: string;
  normalizedMedicineName?: string | null;
  strength?: string | null;
  dosageForm: string;
  route: string;
  prescribedInstructions?: string | null;
  status: MedicationStatusType;
  startDate?: string | null;
  endDate?: string | null;
  reminderTimes?: string[] | null;
  notes?: string | null;
  discontinuedReason?: string | null;
  discontinuedAt?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DoseLogRecord {
  id: string;
  medicationId: string;
  patientProfileId: string;
  scheduledTime: Date;
  status: DoseStatusType;
  actionTime?: Date | null;
  snoozeMinutes?: number | null;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MedicationDetailRecord extends MedicationRecord {
  prescription?: {
    id: string;
    prescriptionDate?: string | null;
    doctorName?: string | null;
    clinicHospitalName?: string | null;
  } | null;
  sourceDocument?: {
    id: string;
    originalFilename: string;
    mimeType: string;
  } | null;
  doseLogs?: DoseLogRecord[];
}

export interface CreateMedicationInput {
  patientProfileId: string;
  nameAsWritten: string;
  normalizedMedicineName?: string;
  strength?: string;
  dosageForm: string;
  route?: string;
  prescribedInstructions?: string;
  status?: MedicationStatusType;
  startDate?: string;
  endDate?: string;
  reminderTimes?: string[];
  prescriptionItemId?: string;
  prescriptionId?: string;
  sourceDocumentId?: string;
  notes?: string;
}

export interface MedicationRepository {
  createMedication(input: CreateMedicationInput): Promise<MedicationRecord>;
  listMedications(patientProfileId: string, status?: MedicationStatusType): Promise<MedicationRecord[]>;
  getMedicationById(id: string, patientProfileId: string): Promise<MedicationDetailRecord | null>;
  updateMedicationStatus(
    id: string,
    patientProfileId: string,
    status: MedicationStatusType,
    meta?: { discontinuedReason?: string; completedAt?: Date; discontinuedAt?: Date }
  ): Promise<MedicationRecord>;
  updateReminderSchedule(
    id: string,
    patientProfileId: string,
    reminderTimes: string[],
    startDate?: string,
    endDate?: string
  ): Promise<MedicationRecord>;
  createDoseLogs(logs: Array<{ medicationId: string; patientProfileId: string; scheduledTime: Date }>): Promise<DoseLogRecord[]>;
  listDoseLogs(patientProfileId: string, from: Date, to: Date): Promise<DoseLogRecord[]>;
  getDoseLogById(id: string, patientProfileId: string): Promise<DoseLogRecord | null>;
  updateDoseAction(
    id: string,
    patientProfileId: string,
    status: DoseStatusType,
    actionTime: Date,
    meta?: { snoozeMinutes?: number; notes?: string }
  ): Promise<DoseLogRecord>;
  cancelPendingDosesForMedication(medicationId: string, patientProfileId: string, fromDate?: Date): Promise<number>;
}

export interface ConfirmPrescriptionTransactionInput {
  patientProfileId: string;
  documentId: string;
  jobId: string;
  prescription: {
    prescriptionDate?: string;
    dateIsUncertain: boolean;
    doctorName?: string;
    clinicHospitalName?: string;
    diagnosis?: string;
    confirmedByUserId: string;
  };
  items: Array<{
    id?: string;
    nameAsWritten: string;
    normalizedMedicineName?: string;
    strength?: string;
    dosageForm: string;
    frequencyText?: string;
    durationText?: string;
    route: string;
    instructions?: string;
    isActiveMedication: boolean;
  }>;
  timelineEvent: {
    eventDate: string;
    title: string;
    summary: string;
  };
}

export interface ConfirmedPrescriptionResult {
  prescription: PrescriptionRecord;
  items: PrescriptionItemRecord[];
  timelineEvent: TimelineEventRecord;
}

export type UploadIntentStatus = 'PENDING' | 'VERIFYING' | 'VERIFIED' | 'REJECTED';

export interface UploadIntentRecord {
  id: string;
  patientProfileId: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  declaredSizeBytes: number;
  expiresAt: Date;
  consumed: boolean;
  status: UploadIntentStatus;
  rejectionReason?: string;
  verifyingStartedAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export interface CreateUploadIntentInput {
  patientProfileId: string;
  storageKey: string;
  originalFilename?: string;
  mimeType: string;
  declaredSizeBytes: number;
  expiresAt: Date;
}

export interface AcquireLockResult {
  success: boolean;
  intent?: UploadIntentRecord;
  reason?: string;
  retryable?: boolean;
}

export interface UploadIntentRepository {
  createIntent(input: CreateUploadIntentInput): Promise<UploadIntentRecord>;
  getIntent(storageKey: string): Promise<UploadIntentRecord | null>;
  acquireVerificationLock(storageKey: string, patientProfileId: string, leaseTimeoutMs?: number): Promise<AcquireLockResult>;
  releaseVerificationLock(storageKey: string, patientProfileId: string): Promise<void>;
  markVerified(storageKey: string, patientProfileId: string): Promise<UploadIntentRecord>;
  markRejected(storageKey: string, patientProfileId: string, reason: string): Promise<UploadIntentRecord>;
  consumeIntent(storageKey: string, patientProfileId: string): Promise<UploadIntentRecord | null>;
}

// ==========================================
// REPOSITORY INTERFACES
// ==========================================

export interface DocumentRepository {
  create(data: Omit<DocumentRecord, 'id' | 'uploadedAt' | 'updatedAt'> & { id?: string }): Promise<DocumentRecord>;
  findById(id: string): Promise<DocumentRecord | null>;
  findByStorageKey(storageKey: string): Promise<DocumentRecord | null>;
  updateStatus(id: string, status: DocumentStatus): Promise<DocumentRecord>;
  listByPatient(patientProfileId: string): Promise<DocumentRecord[]>;
  delete(id: string): Promise<void>;
}

export interface ExtractionJobRepository {
  create(data: Omit<ExtractionJobRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<ExtractionJobRecord>;
  findById(id: string): Promise<ExtractionJobRecord | null>;
  findByPatientAndIdempotencyKey(patientProfileId: string, idempotencyKey: string): Promise<ExtractionJobRecord | null>;
  claimJobForProcessing(id: string): Promise<ExtractionJobRecord | null>;
  completeProcessing(
    id: string,
    extractedPayload: any,
    status: 'SUCCEEDED' | 'FAILED',
    errorMessage?: string
  ): Promise<ExtractionJobRecord | null>;
  cancelJob(id: string, patientProfileId: string): Promise<ExtractionJobRecord>;
  recordRetry(id: string, errorMessage: string, maxRetries: number): Promise<ExtractionJobRecord>;
  recoverStaleProcessingJobs(staleThresholdMs: number): Promise<ExtractionJobRecord[]>;
}

export interface PrescriptionRepository {
  confirmPrescriptionTransaction(input: ConfirmPrescriptionTransactionInput): Promise<ConfirmedPrescriptionResult>;
  findById(id: string, patientProfileId: string): Promise<{ prescription: PrescriptionRecord; items: PrescriptionItemRecord[] } | null>;
  listTimelineEvents(patientProfileId: string): Promise<TimelineEventRecord[]>;
}

// ==========================================
// PRISMA (POSTGRESQL) REPOSITORY IMPLEMENTATIONS
// ==========================================

export class PrismaUploadIntentRepository implements UploadIntentRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async createIntent(input: CreateUploadIntentInput): Promise<UploadIntentRecord> {
    const record = await this.prisma.uploadIntent.create({
      data: {
        id: crypto.randomUUID(),
        patientProfileId: input.patientProfileId,
        storageKey: input.storageKey,
        originalFilename: input.originalFilename || `upload-${input.storageKey.split('/').pop()}`,
        mimeType: input.mimeType,
        expectedSizeBytes: input.declaredSizeBytes,
        expiresAt: input.expiresAt,
        consumed: false,
        status: 'PENDING',
      },
    });

    return {
      id: record.id,
      patientProfileId: record.patientProfileId,
      storageKey: record.storageKey,
      originalFilename: record.originalFilename,
      mimeType: record.mimeType,
      declaredSizeBytes: record.expectedSizeBytes,
      expiresAt: record.expiresAt,
      consumed: record.consumed,
      status: (record.status as UploadIntentStatus) || 'PENDING',
      rejectionReason: record.rejectionReason ?? undefined,
      verifyingStartedAt: record.verifyingStartedAt ?? undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt ?? undefined,
    };
  }

  async getIntent(storageKey: string): Promise<UploadIntentRecord | null> {
    const record = await this.prisma.uploadIntent.findUnique({
      where: { storageKey },
    });
    if (!record) return null;
    return {
      id: record.id,
      patientProfileId: record.patientProfileId,
      storageKey: record.storageKey,
      originalFilename: record.originalFilename,
      mimeType: record.mimeType,
      declaredSizeBytes: record.expectedSizeBytes,
      expiresAt: record.expiresAt,
      consumed: record.consumed,
      status: (record.status as UploadIntentStatus) || 'PENDING',
      rejectionReason: record.rejectionReason ?? undefined,
      verifyingStartedAt: record.verifyingStartedAt ?? undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt ?? undefined,
    };
  }

  async acquireVerificationLock(
    storageKey: string,
    patientProfileId: string,
    leaseTimeoutMs = 30000
  ): Promise<AcquireLockResult> {
    const now = new Date();
    const leaseCutoff = new Date(now.getTime() - leaseTimeoutMs);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.uploadIntent.findUnique({
        where: { storageKey },
      });

      if (!existing) {
        return { success: false, reason: 'Upload intent not found. Please initialize a new upload.', retryable: false };
      }

      if (existing.patientProfileId !== patientProfileId) {
        return { success: false, reason: 'Forbidden: Upload intent does not belong to the authenticated patient', retryable: false };
      }

      if (existing.status === 'VERIFIED') {
        return { success: false, reason: 'Upload intent has already been consumed. Duplicate confirmation rejected.', retryable: false };
      }

      if (existing.status === 'REJECTED') {
        return { success: false, reason: `Upload intent was rejected: ${existing.rejectionReason || 'Invalid upload'}`, retryable: false };
      }

      if (now > existing.expiresAt) {
        return { success: false, reason: 'Upload ticket has expired (exceeded 15-minute window)', retryable: false };
      }

      if (existing.status === 'VERIFYING' && existing.verifyingStartedAt && existing.verifyingStartedAt > leaseCutoff) {
        return { success: false, reason: 'Upload verification is currently in progress. Please wait.', retryable: true };
      }

      // Atomically transition to VERIFYING
      const updateResult = await tx.uploadIntent.updateMany({
        where: {
          id: existing.id,
          OR: [
            { status: 'PENDING' },
            {
              status: 'VERIFYING',
              OR: [
                { verifyingStartedAt: null },
                { verifyingStartedAt: { lte: leaseCutoff } },
              ],
            },
          ],
        },
        data: {
          status: 'VERIFYING',
          verifyingStartedAt: now,
          updatedAt: now,
        },
      });

      if (updateResult.count === 0) {
        return { success: false, reason: 'Upload verification is currently in progress. Please wait.', retryable: true };
      }

      const updated = await tx.uploadIntent.findUniqueOrThrow({ where: { id: existing.id } });
      return {
        success: true,
        intent: {
          id: updated.id,
          patientProfileId: updated.patientProfileId,
          storageKey: updated.storageKey,
          originalFilename: updated.originalFilename,
          mimeType: updated.mimeType,
          declaredSizeBytes: updated.expectedSizeBytes,
          expiresAt: updated.expiresAt,
          consumed: updated.consumed,
          status: (updated.status as UploadIntentStatus) || 'VERIFYING',
          rejectionReason: updated.rejectionReason ?? undefined,
          verifyingStartedAt: updated.verifyingStartedAt ?? undefined,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      };
    });
  }

  async releaseVerificationLock(storageKey: string, patientProfileId: string): Promise<void> {
    const now = new Date();
    await this.prisma.uploadIntent.updateMany({
      where: {
        storageKey,
        patientProfileId,
        status: 'VERIFYING',
      },
      data: {
        status: 'PENDING',
        verifyingStartedAt: null,
        updatedAt: now,
      },
    });
  }

  async markVerified(storageKey: string, patientProfileId: string): Promise<UploadIntentRecord> {
    const now = new Date();
    const updateResult = await this.prisma.uploadIntent.updateMany({
      where: { storageKey, patientProfileId },
      data: {
        status: 'VERIFIED',
        consumed: true,
        verifyingStartedAt: null,
        updatedAt: now,
      },
    });

    if (updateResult.count === 0) {
      throw new Error('Upload intent not found or patient profile mismatch');
    }

    const updated = await this.prisma.uploadIntent.findUniqueOrThrow({ where: { storageKey } });

    return {
      id: updated.id,
      patientProfileId: updated.patientProfileId,
      storageKey: updated.storageKey,
      originalFilename: updated.originalFilename,
      mimeType: updated.mimeType,
      declaredSizeBytes: updated.expectedSizeBytes,
      expiresAt: updated.expiresAt,
      consumed: updated.consumed,
      status: 'VERIFIED',
      rejectionReason: updated.rejectionReason ?? undefined,
      verifyingStartedAt: undefined,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async markRejected(storageKey: string, patientProfileId: string, reason: string): Promise<UploadIntentRecord> {
    const now = new Date();
    const updateResult = await this.prisma.uploadIntent.updateMany({
      where: { storageKey, patientProfileId },
      data: {
        status: 'REJECTED',
        consumed: false,
        rejectionReason: reason,
        verifyingStartedAt: null,
        updatedAt: now,
      },
    });

    if (updateResult.count === 0) {
      throw new Error('Upload intent not found or patient profile mismatch');
    }

    const updated = await this.prisma.uploadIntent.findUniqueOrThrow({ where: { storageKey } });

    return {
      id: updated.id,
      patientProfileId: updated.patientProfileId,
      storageKey: updated.storageKey,
      originalFilename: updated.originalFilename,
      mimeType: updated.mimeType,
      declaredSizeBytes: updated.expectedSizeBytes,
      expiresAt: updated.expiresAt,
      consumed: updated.consumed,
      status: 'REJECTED',
      rejectionReason: reason,
      verifyingStartedAt: undefined,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async consumeIntent(storageKey: string, patientProfileId: string): Promise<UploadIntentRecord | null> {
    const lock = await this.acquireVerificationLock(storageKey, patientProfileId);
    if (!lock.success || !lock.intent) {
      return null;
    }
    return this.markVerified(storageKey, patientProfileId);
  }
}


export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async create(data: Omit<DocumentRecord, 'id' | 'uploadedAt' | 'updatedAt'> & { id?: string }): Promise<DocumentRecord> {
    const doc = await this.prisma.document.create({
      data: {
        id: data.id || crypto.randomUUID(),
        patientProfileId: data.patientProfileId,
        storageKey: data.storageKey,
        originalFilename: data.originalFilename,
        mimeType: data.mimeType,
        fileSizeBytes: data.fileSizeBytes,
        sha256Checksum: data.sha256Checksum,
        status: data.status,
        pageCount: data.pageCount,
        imageWidth: data.imageWidth,
        imageHeight: data.imageHeight,
      },
    });

    return {
      ...doc,
      pageCount: doc.pageCount ?? undefined,
      imageWidth: doc.imageWidth ?? undefined,
      imageHeight: doc.imageHeight ?? undefined,
    };
  }

  async findById(id: string): Promise<DocumentRecord | null> {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) return null;
    return {
      ...doc,
      pageCount: doc.pageCount ?? undefined,
      imageWidth: doc.imageWidth ?? undefined,
      imageHeight: doc.imageHeight ?? undefined,
    };
  }

  async findByStorageKey(storageKey: string): Promise<DocumentRecord | null> {
    const doc = await this.prisma.document.findUnique({ where: { storageKey } });
    if (!doc) return null;
    return {
      ...doc,
      pageCount: doc.pageCount ?? undefined,
      imageWidth: doc.imageWidth ?? undefined,
      imageHeight: doc.imageHeight ?? undefined,
    };
  }

  async updateStatus(id: string, status: DocumentStatus): Promise<DocumentRecord> {
    const doc = await this.prisma.document.update({
      where: { id },
      data: { status },
    });
    return {
      ...doc,
      pageCount: doc.pageCount ?? undefined,
      imageWidth: doc.imageWidth ?? undefined,
      imageHeight: doc.imageHeight ?? undefined,
    };
  }

  async listByPatient(patientProfileId: string): Promise<DocumentRecord[]> {
    const docs = await this.prisma.document.findMany({
      where: { patientProfileId },
      orderBy: { uploadedAt: 'desc' },
    });
    return docs.map((doc) => ({
      ...doc,
      pageCount: doc.pageCount ?? undefined,
      imageWidth: doc.imageWidth ?? undefined,
      imageHeight: doc.imageHeight ?? undefined,
    }));
  }

  async delete(id: string): Promise<void> {
    await this.prisma.document.delete({ where: { id } });
  }
}

export class PrismaExtractionJobRepository implements ExtractionJobRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async create(data: Omit<ExtractionJobRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<ExtractionJobRecord> {
    const job = await this.prisma.extractionJob.create({
      data: {
        id: data.id || crypto.randomUUID(),
        patientProfileId: data.patientProfileId,
        documentId: data.documentId,
        idempotencyKey: data.idempotencyKey,
        status: data.status,
        retryCount: data.retryCount,
        maxRetries: data.maxRetries,
        providerName: data.providerName,
        extractedPayload: data.extractedPayload,
        errorMessage: data.errorMessage,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        confirmedAt: data.confirmedAt,
      },
    });

    return {
      ...job,
      startedAt: job.startedAt ?? undefined,
      completedAt: job.completedAt ?? undefined,
      confirmedAt: job.confirmedAt ?? undefined,
      errorMessage: job.errorMessage ?? undefined,
      extractedPayload: job.extractedPayload ?? undefined,
    };
  }

  async findById(id: string): Promise<ExtractionJobRecord | null> {
    const job = await this.prisma.extractionJob.findUnique({ where: { id } });
    if (!job) return null;
    return {
      ...job,
      startedAt: job.startedAt ?? undefined,
      completedAt: job.completedAt ?? undefined,
      confirmedAt: job.confirmedAt ?? undefined,
      errorMessage: job.errorMessage ?? undefined,
      extractedPayload: job.extractedPayload ?? undefined,
    };
  }

  async findByPatientAndIdempotencyKey(patientProfileId: string, idempotencyKey: string): Promise<ExtractionJobRecord | null> {
    const job = await this.prisma.extractionJob.findUnique({
      where: {
        patientProfileId_idempotencyKey: {
          patientProfileId,
          idempotencyKey,
        },
      },
    });
    if (!job) return null;
    return {
      ...job,
      startedAt: job.startedAt ?? undefined,
      completedAt: job.completedAt ?? undefined,
      confirmedAt: job.confirmedAt ?? undefined,
      errorMessage: job.errorMessage ?? undefined,
      extractedPayload: job.extractedPayload ?? undefined,
    };
  }

  /**
   * Concurrency-safe atomic job claim.
   * Only transitions if status is currently QUEUED.
   */
  async claimJobForProcessing(id: string): Promise<ExtractionJobRecord | null> {
    const now = new Date();
    // Prisma atomic updateMany with condition ensures concurrency safety
    const updated = await this.prisma.extractionJob.updateMany({
      where: {
        id,
        status: 'QUEUED',
      },
      data: {
        status: 'PROCESSING',
        startedAt: now,
      },
    });

    if (updated.count === 0) {
      return null; // Already claimed or not queued
    }

    return this.findById(id);
  }

  /**
   * Concurrency-safe status completion.
   * Only updates if status is currently PROCESSING.
   * Prevents late provider response from overwriting a CANCELLED job.
   */
  async completeProcessing(
    id: string,
    extractedPayload: any,
    status: 'SUCCEEDED' | 'FAILED',
    errorMessage?: string
  ): Promise<ExtractionJobRecord | null> {
    const now = new Date();
    const updated = await this.prisma.extractionJob.updateMany({
      where: {
        id,
        status: 'PROCESSING',
      },
      data: {
        status,
        extractedPayload,
        errorMessage,
        completedAt: now,
      },
    });

    if (updated.count === 0) {
      return null; // Job was cancelled or already in terminal state!
    }

    return this.findById(id);
  }

  async cancelJob(id: string, patientProfileId: string): Promise<ExtractionJobRecord> {
    const job = await this.findById(id);
    if (!job || job.patientProfileId !== patientProfileId) {
      throw new Error('Extraction job not found');
    }

    if (job.status === 'SUCCEEDED' || job.confirmedAt) {
      throw new Error('Cannot cancel a completed or confirmed job');
    }

    const updated = await this.prisma.extractionJob.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
      },
    });

    return {
      ...updated,
      startedAt: updated.startedAt ?? undefined,
      completedAt: updated.completedAt ?? undefined,
      confirmedAt: updated.confirmedAt ?? undefined,
      errorMessage: updated.errorMessage ?? undefined,
      extractedPayload: updated.extractedPayload ?? undefined,
    };
  }

  async recordRetry(id: string, errorMessage: string, maxRetries: number): Promise<ExtractionJobRecord> {
    const job = await this.findById(id);
    if (!job) throw new Error('Job not found');

    const newRetryCount = job.retryCount + 1;
    const isExhausted = newRetryCount >= maxRetries;
    const newStatus: JobStatus = isExhausted ? 'FAILED' : 'QUEUED';

    const updated = await this.prisma.extractionJob.update({
      where: { id },
      data: {
        retryCount: newRetryCount,
        status: newStatus,
        errorMessage,
        completedAt: isExhausted ? new Date() : undefined,
      },
    });

    return {
      ...updated,
      startedAt: updated.startedAt ?? undefined,
      completedAt: updated.completedAt ?? undefined,
      confirmedAt: updated.confirmedAt ?? undefined,
      errorMessage: updated.errorMessage ?? undefined,
      extractedPayload: updated.extractedPayload ?? undefined,
    };
  }

  async recoverStaleProcessingJobs(staleThresholdMs: number): Promise<ExtractionJobRecord[]> {
    const thresholdDate = new Date(Date.now() - staleThresholdMs);

    // Find stale processing jobs
    const staleJobs = await this.prisma.extractionJob.findMany({
      where: {
        status: 'PROCESSING',
        startedAt: { lt: thresholdDate },
      },
    });

    const recovered: ExtractionJobRecord[] = [];

    for (const job of staleJobs) {
      const newRetryCount = job.retryCount + 1;
      const newStatus = newRetryCount >= job.maxRetries ? 'FAILED' : 'QUEUED';

      const updated = await this.prisma.extractionJob.update({
        where: { id: job.id },
        data: {
          retryCount: newRetryCount,
          status: newStatus,
          errorMessage: 'Worker timeout or unexpected crash during processing',
          completedAt: newStatus === 'FAILED' ? new Date() : undefined,
        },
      });

      recovered.push({
        ...updated,
        startedAt: updated.startedAt ?? undefined,
        completedAt: updated.completedAt ?? undefined,
        confirmedAt: updated.confirmedAt ?? undefined,
        errorMessage: updated.errorMessage ?? undefined,
        extractedPayload: updated.extractedPayload ?? undefined,
      });
    }

    return recovered;
  }
}

export class PrismaPrescriptionRepository implements PrescriptionRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async confirmPrescriptionTransaction(
    input: ConfirmPrescriptionTransactionInput
  ): Promise<ConfirmedPrescriptionResult> {
    const prescriptionId = crypto.randomUUID();
    const timelineEventId = crypto.randomUUID();
    const now = new Date();

    // STRICT ATOMIC TRANSACTION IN POSTGRESQL
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock and verify extraction job
      const job = await tx.extractionJob.findUnique({
        where: { id: input.jobId },
      });

      if (!job || job.patientProfileId !== input.patientProfileId) {
        throw new Error('Extraction job not found');
      }

      if (job.confirmedAt) {
        throw new Error('This extraction job has already been confirmed');
      }

      if (job.status !== 'SUCCEEDED') {
        throw new Error(`Cannot confirm an unreviewed or non-succeeded extraction job (current status: ${job.status})`);
      }

      // 2. Verify source document exists
      const docId = input.documentId || job.documentId;
      const doc = await tx.document.findUnique({
        where: { id: docId },
      });

      if (!doc || doc.patientProfileId !== input.patientProfileId) {
        throw new Error('Source document not found');
      }

      // 3. Create Prescription record (DB unique constraint on jobId guarantees single confirmation)
      const parseDate = (d?: string) => (d ? new Date(d) : undefined);

      const createdRx = await tx.prescription.create({
        data: {
          id: prescriptionId,
          patientProfileId: input.patientProfileId,
          documentId: docId,
          jobId: input.jobId,
          prescriptionDate: parseDate(input.prescription.prescriptionDate),
          dateIsUncertain: input.prescription.dateIsUncertain,
          doctorName: input.prescription.doctorName,
          clinicHospitalName: input.prescription.clinicHospitalName,
          diagnosis: input.prescription.diagnosis,
          reviewStatus: 'CONFIRMED',
          confirmedAt: now,
          confirmedByUserId: input.prescription.confirmedByUserId,
        },
      });

      // 4. Create Prescription Item records
      const itemRows = input.items.map((item) => ({
        id: item.id || crypto.randomUUID(),
        prescriptionId,
        nameAsWritten: item.nameAsWritten,
        normalizedMedicineName: item.normalizedMedicineName,
        strength: item.strength,
        dosageForm: item.dosageForm,
        frequencyText: item.frequencyText,
        durationText: item.durationText,
        route: item.route,
        instructions: item.instructions,
        isActiveMedication: Boolean(item.isActiveMedication),
        sourceDocumentId: docId,
      }));

      await tx.prescriptionItem.createMany({
        data: itemRows,
      });

      // 4b. Create corresponding Medication records
      const medicationRows = itemRows.map((item) => {
        const isActive = Boolean(item.isActiveMedication);
        return {
          id: crypto.randomUUID(),
          patientProfileId: input.patientProfileId,
          prescriptionItemId: item.id,
          prescriptionId,
          sourceDocumentId: docId,
          nameAsWritten: item.nameAsWritten,
          normalizedMedicineName: item.normalizedMedicineName,
          strength: item.strength,
          dosageForm: item.dosageForm,
          route: item.route,
          prescribedInstructions: item.instructions || item.frequencyText,
          status: isActive ? ('ACTIVE' as const) : ('INACTIVE' as const),
          startDate: parseDate(input.prescription.prescriptionDate),
          reminderTimes: isActive ? ['08:00', '20:00'] : undefined,
          createdAt: now,
          updatedAt: now,
        };
      });

      await tx.medication.createMany({
        data: medicationRows,
      });

      // 4c. Generate initial 7-day dose schedule for active medications
      const activeMedications = medicationRows.filter((m) => m.status === 'ACTIVE');
      if (activeMedications.length > 0) {
        const doseLogsToCreate: Array<{
          id: string;
          medicationId: string;
          patientProfileId: string;
          scheduledTime: Date;
          status: 'PENDING';
          createdAt: Date;
          updatedAt: Date;
        }> = [];

        const defaultTimes = ['08:00', '20:00'];
        for (const med of activeMedications) {
          for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
            for (const timeStr of defaultTimes) {
              const [h, m] = timeStr.split(':').map(Number);
              const target = new Date(now);
              target.setDate(target.getDate() + dayOffset);
              target.setHours(h ?? 8, m ?? 0, 0, 0);
              if (target.getTime() > now.getTime()) {
                doseLogsToCreate.push({
                  id: crypto.randomUUID(),
                  medicationId: med.id,
                  patientProfileId: input.patientProfileId,
                  scheduledTime: target,
                  status: 'PENDING',
                  createdAt: now,
                  updatedAt: now,
                });
              }
            }
          }
        }

        if (doseLogsToCreate.length > 0) {
          await tx.doseLog.createMany({
            data: doseLogsToCreate,
          });
        }
      }

      // 5. Ingest into Verified Clinical Timeline
      const createdTimeline = await tx.timelineEvent.create({
        data: {
          id: timelineEventId,
          patientProfileId: input.patientProfileId,
          eventType: 'PRESCRIPTION_RECORDED',
          eventDate: parseDate(input.timelineEvent.eventDate) || now,
          dateIsUncertain: input.prescription.dateIsUncertain,
          datePrecision: input.prescription.dateIsUncertain ? 'UNCERTAIN' : 'EXACT',
          title: input.timelineEvent.title,
          summary: input.timelineEvent.summary,
          sourceDocumentId: docId,
          sourcePrescriptionId: prescriptionId,
          isVerified: true,
          createdAt: now,
        },
      });

      // 6. Atomically mark job as confirmed
      await tx.extractionJob.update({
        where: { id: input.jobId },
        data: { confirmedAt: now },
      });

      // 7. Update document status to CONFIRMED
      await tx.document.update({
        where: { id: docId },
        data: { status: 'CONFIRMED' },
      });

      const prescriptionRecord: PrescriptionRecord = {
        id: createdRx.id,
        patientProfileId: createdRx.patientProfileId,
        documentId: createdRx.documentId,
        jobId: createdRx.jobId,
        prescriptionDate: createdRx.prescriptionDate ? createdRx.prescriptionDate.toISOString().split('T')[0] : undefined,
        dateIsUncertain: createdRx.dateIsUncertain,
        doctorName: createdRx.doctorName ?? undefined,
        clinicHospitalName: createdRx.clinicHospitalName ?? undefined,
        diagnosis: createdRx.diagnosis ?? undefined,
        reviewStatus: 'CONFIRMED',
        confirmedAt: createdRx.confirmedAt,
        confirmedByUserId: createdRx.confirmedByUserId,
        createdAt: createdRx.createdAt,
        updatedAt: createdRx.updatedAt,
      };

      const itemsRecords: PrescriptionItemRecord[] = itemRows.map((r) => ({
        ...r,
        normalizedMedicineName: r.normalizedMedicineName ?? undefined,
        strength: r.strength ?? undefined,
        frequencyText: r.frequencyText ?? undefined,
        durationText: r.durationText ?? undefined,
        instructions: r.instructions ?? undefined,
        createdAt: now,
        updatedAt: now,
      }));

      const timelineRecord: TimelineEventRecord = {
        id: createdTimeline.id,
        patientProfileId: createdTimeline.patientProfileId,
        eventType: createdTimeline.eventType,
        eventDate: createdTimeline.eventDate.toISOString().split('T')[0] as string,
        title: createdTimeline.title,
        summary: createdTimeline.summary,
        sourceDocumentId: createdTimeline.sourceDocumentId,
        sourcePrescriptionId: createdTimeline.sourcePrescriptionId ?? undefined,
        isVerified: createdTimeline.isVerified,
        createdAt: createdTimeline.createdAt,
        updatedAt: createdTimeline.updatedAt,
      };

      return {
        prescription: prescriptionRecord,
        items: itemsRecords,
        timelineEvent: timelineRecord,
      };
    });
  }

  async findById(
    id: string,
    patientProfileId: string
  ): Promise<{ prescription: PrescriptionRecord; items: PrescriptionItemRecord[] } | null> {
    const rx = await this.prisma.prescription.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!rx || rx.patientProfileId !== patientProfileId) return null;

    return {
      prescription: {
        id: rx.id,
        patientProfileId: rx.patientProfileId,
        documentId: rx.documentId,
        jobId: rx.jobId,
        prescriptionDate: rx.prescriptionDate ? rx.prescriptionDate.toISOString().split('T')[0] : undefined,
        dateIsUncertain: rx.dateIsUncertain,
        doctorName: rx.doctorName ?? undefined,
        clinicHospitalName: rx.clinicHospitalName ?? undefined,
        diagnosis: rx.diagnosis ?? undefined,
        reviewStatus: 'CONFIRMED',
        confirmedAt: rx.confirmedAt,
        confirmedByUserId: rx.confirmedByUserId,
        createdAt: rx.createdAt,
        updatedAt: rx.updatedAt,
      },
      items: rx.items.map((it) => ({
        id: it.id,
        prescriptionId: it.prescriptionId,
        nameAsWritten: it.nameAsWritten,
        normalizedMedicineName: it.normalizedMedicineName ?? undefined,
        strength: it.strength ?? undefined,
        dosageForm: it.dosageForm,
        frequencyText: it.frequencyText ?? undefined,
        durationText: it.durationText ?? undefined,
        route: it.route,
        instructions: it.instructions ?? undefined,
        isActiveMedication: it.isActiveMedication,
        sourceDocumentId: it.sourceDocumentId,
        createdAt: it.createdAt,
        updatedAt: it.updatedAt,
      })),
    };
  }

  async listTimelineEvents(patientProfileId: string): Promise<TimelineEventRecord[]> {
    const events = await this.prisma.timelineEvent.findMany({
      where: { patientProfileId },
      orderBy: { eventDate: 'desc' },
    });

    return events.map((ev) => ({
      id: ev.id,
      patientProfileId: ev.patientProfileId,
      eventType: ev.eventType,
      eventDate: ev.eventDate.toISOString().split('T')[0] as string,
      dateIsUncertain: ev.dateIsUncertain,
      datePrecision: ev.datePrecision,
      title: ev.title,
      summary: ev.summary,
      sourceDocumentId: ev.sourceDocumentId,
      sourcePrescriptionId: ev.sourcePrescriptionId ?? undefined,
      isVerified: ev.isVerified,
      createdAt: ev.createdAt,
      updatedAt: ev.updatedAt,
    }));
  }
}

export class PrismaTimelineRepository implements TimelineRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async listTimelineEvents(
    patientProfileId: string,
    options?: TimelineFilterOptions
  ): Promise<{ events: TimelineEventDetailRecord[]; totalCount: number }> {
    const where: any = {
      patientProfileId,
      isVerified: true,
    };

    if (options?.category && options.category !== 'ALL') {
      if (options.category === 'PRESCRIPTION') {
        where.eventType = { in: ['PRESCRIPTION', 'PRESCRIPTION_RECORDED'] };
      } else {
        where.eventType = options.category;
      }
    }

    if (options?.year) {
      const startOfYear = new Date(Date.UTC(options.year, 0, 1));
      const endOfYear = new Date(Date.UTC(options.year + 1, 0, 1));
      where.eventDate = {
        gte: startOfYear,
        lt: endOfYear,
      };
    }

    if (options?.search && options.search.trim()) {
      const q = options.search.trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { summary: { contains: q, mode: 'insensitive' } },
        {
          sourcePrescription: {
            OR: [
              { doctorName: { contains: q, mode: 'insensitive' } },
              { clinicHospitalName: { contains: q, mode: 'insensitive' } },
              { diagnosis: { contains: q, mode: 'insensitive' } },
              {
                items: {
                  some: {
                    OR: [
                      { nameAsWritten: { contains: q, mode: 'insensitive' } },
                      { normalizedMedicineName: { contains: q, mode: 'insensitive' } },
                    ],
                  },
                },
              },
            ],
          },
        },
      ];
    }

    const totalCount = await this.prisma.timelineEvent.count({ where });

    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
    const offset = Math.max(options?.offset ?? 0, 0);

    const rows = await this.prisma.timelineEvent.findMany({
      where,
      include: {
        sourceDocument: true,
        sourcePrescription: {
          include: {
            items: true,
          },
        },
      },
      orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: offset,
    });

    const events: TimelineEventDetailRecord[] = rows.map((ev) => ({
      id: ev.id,
      patientProfileId: ev.patientProfileId,
      eventType: ev.eventType,
      eventDate: ev.eventDate.toISOString().split('T')[0] as string,
      dateIsUncertain: ev.dateIsUncertain,
      datePrecision: ev.datePrecision,
      title: ev.title,
      summary: ev.summary,
      sourceDocumentId: ev.sourceDocumentId,
      sourcePrescriptionId: ev.sourcePrescriptionId ?? undefined,
      isVerified: ev.isVerified,
      createdAt: ev.createdAt,
      updatedAt: ev.updatedAt,
      sourceDocument: ev.sourceDocument
        ? {
            id: ev.sourceDocument.id,
            originalFilename: ev.sourceDocument.originalFilename,
            mimeType: ev.sourceDocument.mimeType,
            fileSizeBytes: ev.sourceDocument.fileSizeBytes,
            pageCount: ev.sourceDocument.pageCount,
            uploadedAt: ev.sourceDocument.uploadedAt,
          }
        : undefined,
      prescription: ev.sourcePrescription
        ? {
            id: ev.sourcePrescription.id,
            prescriptionDate: ev.sourcePrescription.prescriptionDate
              ? ev.sourcePrescription.prescriptionDate.toISOString().split('T')[0]
              : undefined,
            dateIsUncertain: ev.sourcePrescription.dateIsUncertain,
            doctorName: ev.sourcePrescription.doctorName ?? undefined,
            clinicHospitalName: ev.sourcePrescription.clinicHospitalName ?? undefined,
            diagnosis: ev.sourcePrescription.diagnosis ?? undefined,
            confirmedAt: ev.sourcePrescription.confirmedAt,
            items: ev.sourcePrescription.items.map((it) => ({
              id: it.id,
              prescriptionId: it.prescriptionId,
              nameAsWritten: it.nameAsWritten,
              normalizedMedicineName: it.normalizedMedicineName ?? undefined,
              strength: it.strength ?? undefined,
              dosageForm: it.dosageForm,
              frequencyText: it.frequencyText ?? undefined,
              durationText: it.durationText ?? undefined,
              route: it.route,
              instructions: it.instructions ?? undefined,
              isActiveMedication: it.isActiveMedication,
              sourceDocumentId: it.sourceDocumentId,
              createdAt: it.createdAt,
              updatedAt: it.updatedAt,
            })),
          }
        : undefined,
    }));

    return { events, totalCount };
  }

  async getTimelineEventById(
    id: string,
    patientProfileId: string
  ): Promise<TimelineEventDetailRecord | null> {
    const ev = await this.prisma.timelineEvent.findFirst({
      where: { id, patientProfileId },
      include: {
        sourceDocument: true,
        sourcePrescription: {
          include: {
            items: true,
          },
        },
      },
    });

    if (!ev) return null;

    return {
      id: ev.id,
      patientProfileId: ev.patientProfileId,
      eventType: ev.eventType,
      eventDate: ev.eventDate.toISOString().split('T')[0] as string,
      dateIsUncertain: ev.dateIsUncertain,
      datePrecision: ev.datePrecision,
      title: ev.title,
      summary: ev.summary,
      sourceDocumentId: ev.sourceDocumentId,
      sourcePrescriptionId: ev.sourcePrescriptionId ?? undefined,
      isVerified: ev.isVerified,
      createdAt: ev.createdAt,
      updatedAt: ev.updatedAt,
      sourceDocument: ev.sourceDocument
        ? {
            id: ev.sourceDocument.id,
            originalFilename: ev.sourceDocument.originalFilename,
            mimeType: ev.sourceDocument.mimeType,
            fileSizeBytes: ev.sourceDocument.fileSizeBytes,
            pageCount: ev.sourceDocument.pageCount,
            uploadedAt: ev.sourceDocument.uploadedAt,
          }
        : undefined,
      prescription: ev.sourcePrescription
        ? {
            id: ev.sourcePrescription.id,
            prescriptionDate: ev.sourcePrescription.prescriptionDate
              ? ev.sourcePrescription.prescriptionDate.toISOString().split('T')[0]
              : undefined,
            dateIsUncertain: ev.sourcePrescription.dateIsUncertain,
            doctorName: ev.sourcePrescription.doctorName ?? undefined,
            clinicHospitalName: ev.sourcePrescription.clinicHospitalName ?? undefined,
            diagnosis: ev.sourcePrescription.diagnosis ?? undefined,
            confirmedAt: ev.sourcePrescription.confirmedAt,
            items: ev.sourcePrescription.items.map((it) => ({
              id: it.id,
              prescriptionId: it.prescriptionId,
              nameAsWritten: it.nameAsWritten,
              normalizedMedicineName: it.normalizedMedicineName ?? undefined,
              strength: it.strength ?? undefined,
              dosageForm: it.dosageForm,
              frequencyText: it.frequencyText ?? undefined,
              durationText: it.durationText ?? undefined,
              route: it.route,
              instructions: it.instructions ?? undefined,
              isActiveMedication: it.isActiveMedication,
              sourceDocumentId: it.sourceDocumentId,
              createdAt: it.createdAt,
              updatedAt: it.updatedAt,
            })),
          }
        : undefined,
    };
  }
}

export class PrismaMedicationRepository implements MedicationRepository {
  constructor(private readonly prisma: PrismaClient = getPrismaClient()) {}

  async createMedication(input: CreateMedicationInput): Promise<MedicationRecord> {
    const parseDate = (d?: string) => (d ? new Date(d) : undefined);
    const created = await this.prisma.medication.create({
      data: {
        patientProfileId: input.patientProfileId,
        nameAsWritten: input.nameAsWritten,
        normalizedMedicineName: input.normalizedMedicineName,
        strength: input.strength,
        dosageForm: input.dosageForm,
        route: input.route || 'ORAL',
        prescribedInstructions: input.prescribedInstructions,
        status: input.status || 'INACTIVE',
        startDate: parseDate(input.startDate),
        endDate: parseDate(input.endDate),
        reminderTimes: input.reminderTimes ?? undefined,
        prescriptionItemId: input.prescriptionItemId,
        prescriptionId: input.prescriptionId,
        sourceDocumentId: input.sourceDocumentId,
        notes: input.notes,
      },
    });

    return this.mapMedication(created);
  }

  async listMedications(
    patientProfileId: string,
    status?: MedicationStatusType
  ): Promise<MedicationRecord[]> {
    const meds = await this.prisma.medication.findMany({
      where: {
        patientProfileId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return meds.map((m) => this.mapMedication(m));
  }

  async getMedicationById(
    id: string,
    patientProfileId: string
  ): Promise<MedicationDetailRecord | null> {
    const med = await this.prisma.medication.findFirst({
      where: { id, patientProfileId },
      include: {
        prescription: true,
        sourceDocument: true,
        doseLogs: {
          orderBy: { scheduledTime: 'desc' },
          take: 50,
        },
      },
    });

    if (!med) return null;

    return {
      ...this.mapMedication(med),
      prescription: med.prescription
        ? {
            id: med.prescription.id,
            prescriptionDate: med.prescription.prescriptionDate
              ? med.prescription.prescriptionDate.toISOString().split('T')[0]
              : undefined,
            doctorName: med.prescription.doctorName ?? undefined,
            clinicHospitalName: med.prescription.clinicHospitalName ?? undefined,
          }
        : undefined,
      sourceDocument: med.sourceDocument
        ? {
            id: med.sourceDocument.id,
            originalFilename: med.sourceDocument.originalFilename,
            mimeType: med.sourceDocument.mimeType,
          }
        : undefined,
      doseLogs: med.doseLogs.map((dl) => ({
        id: dl.id,
        medicationId: dl.medicationId,
        patientProfileId: dl.patientProfileId,
        scheduledTime: dl.scheduledTime,
        status: dl.status as DoseStatusType,
        actionTime: dl.actionTime ?? undefined,
        snoozeMinutes: dl.snoozeMinutes ?? undefined,
        notes: dl.notes ?? undefined,
        createdAt: dl.createdAt,
        updatedAt: dl.updatedAt,
      })),
    };
  }

  async updateMedicationStatus(
    id: string,
    patientProfileId: string,
    status: MedicationStatusType,
    meta?: { discontinuedReason?: string; completedAt?: Date; discontinuedAt?: Date }
  ): Promise<MedicationRecord> {
    const existing = await this.prisma.medication.findFirst({
      where: { id, patientProfileId },
    });
    if (!existing) {
      throw new Error(`Medication not found or not owned by patient: ${id}`);
    }

    const updated = await this.prisma.medication.update({
      where: { id },
      data: {
        status,
        discontinuedReason: meta?.discontinuedReason,
        discontinuedAt: meta?.discontinuedAt,
        completedAt: meta?.completedAt,
      },
    });
    return this.mapMedication(updated);
  }

  async updateReminderSchedule(
    id: string,
    patientProfileId: string,
    reminderTimes: string[],
    startDate?: string,
    endDate?: string
  ): Promise<MedicationRecord> {
    const existing = await this.prisma.medication.findFirst({
      where: { id, patientProfileId },
    });
    if (!existing) {
      throw new Error(`Medication not found or not owned by patient: ${id}`);
    }

    const parseDate = (d?: string) => (d ? new Date(d) : undefined);
    const updated = await this.prisma.medication.update({
      where: { id },
      data: {
        reminderTimes,
        ...(startDate !== undefined ? { startDate: parseDate(startDate) } : {}),
        ...(endDate !== undefined ? { endDate: parseDate(endDate) } : {}),
      },
    });
    return this.mapMedication(updated);
  }

  async createDoseLogs(
    logs: Array<{ medicationId: string; patientProfileId: string; scheduledTime: Date }>
  ): Promise<DoseLogRecord[]> {
    if (logs.length === 0) return [];
    const first = logs[0];
    if (!first) return [];

    await this.prisma.doseLog.createMany({
      data: logs.map((l) => ({
        medicationId: l.medicationId,
        patientProfileId: l.patientProfileId,
        scheduledTime: l.scheduledTime,
        status: 'PENDING',
      })),
      skipDuplicates: true,
    });

    const created = await this.prisma.doseLog.findMany({
      where: {
        patientProfileId: first.patientProfileId,
        medicationId: { in: logs.map((l) => l.medicationId) },
        scheduledTime: { in: logs.map((l) => l.scheduledTime) },
      },
      orderBy: { scheduledTime: 'asc' },
    });

    return created.map((dl) => ({
      id: dl.id,
      medicationId: dl.medicationId,
      patientProfileId: dl.patientProfileId,
      scheduledTime: dl.scheduledTime,
      status: dl.status as DoseStatusType,
      actionTime: dl.actionTime ?? undefined,
      snoozeMinutes: dl.snoozeMinutes ?? undefined,
      notes: dl.notes ?? undefined,
      createdAt: dl.createdAt,
      updatedAt: dl.updatedAt,
    }));
  }

  async listDoseLogs(patientProfileId: string, from: Date, to: Date): Promise<DoseLogRecord[]> {
    const list = await this.prisma.doseLog.findMany({
      where: {
        patientProfileId,
        scheduledTime: { gte: from, lte: to },
      },
      orderBy: { scheduledTime: 'asc' },
    });

    return list.map((dl) => ({
      id: dl.id,
      medicationId: dl.medicationId,
      patientProfileId: dl.patientProfileId,
      scheduledTime: dl.scheduledTime,
      status: dl.status as DoseStatusType,
      actionTime: dl.actionTime ?? undefined,
      snoozeMinutes: dl.snoozeMinutes ?? undefined,
      notes: dl.notes ?? undefined,
      createdAt: dl.createdAt,
      updatedAt: dl.updatedAt,
    }));
  }

  async getDoseLogById(id: string, patientProfileId: string): Promise<DoseLogRecord | null> {
    const dl = await this.prisma.doseLog.findFirst({
      where: { id, patientProfileId },
    });
    if (!dl) return null;
    return {
      id: dl.id,
      medicationId: dl.medicationId,
      patientProfileId: dl.patientProfileId,
      scheduledTime: dl.scheduledTime,
      status: dl.status as DoseStatusType,
      actionTime: dl.actionTime ?? undefined,
      snoozeMinutes: dl.snoozeMinutes ?? undefined,
      notes: dl.notes ?? undefined,
      createdAt: dl.createdAt,
      updatedAt: dl.updatedAt,
    };
  }

  async updateDoseAction(
    id: string,
    patientProfileId: string,
    status: DoseStatusType,
    actionTime: Date,
    meta?: { snoozeMinutes?: number; notes?: string }
  ): Promise<DoseLogRecord> {
    const existing = await this.prisma.doseLog.findFirst({
      where: { id, patientProfileId },
    });
    if (!existing) {
      throw new Error(`Dose log not found or not owned by patient: ${id}`);
    }

    const updated = await this.prisma.doseLog.update({
      where: { id },
      data: {
        status,
        actionTime,
        snoozeMinutes: meta?.snoozeMinutes,
        notes: meta?.notes,
      },
    });

    return {
      id: updated.id,
      medicationId: updated.medicationId,
      patientProfileId: updated.patientProfileId,
      scheduledTime: updated.scheduledTime,
      status: updated.status as DoseStatusType,
      actionTime: updated.actionTime ?? undefined,
      snoozeMinutes: updated.snoozeMinutes ?? undefined,
      notes: updated.notes ?? undefined,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async cancelPendingDosesForMedication(
    medicationId: string,
    patientProfileId: string,
    fromDate: Date = new Date()
  ): Promise<number> {
    const res = await this.prisma.doseLog.deleteMany({
      where: {
        medicationId,
        patientProfileId,
        status: 'PENDING',
        scheduledTime: { gte: fromDate },
      },
    });
    return res.count;
  }

  private mapMedication(m: any): MedicationRecord {
    return {
      id: m.id,
      patientProfileId: m.patientProfileId,
      prescriptionItemId: m.prescriptionItemId ?? undefined,
      prescriptionId: m.prescriptionId ?? undefined,
      sourceDocumentId: m.sourceDocumentId ?? undefined,
      nameAsWritten: m.nameAsWritten,
      normalizedMedicineName: m.normalizedMedicineName ?? undefined,
      strength: m.strength ?? undefined,
      dosageForm: m.dosageForm,
      route: m.route,
      prescribedInstructions: m.prescribedInstructions ?? undefined,
      status: m.status as MedicationStatusType,
      startDate: m.startDate ? m.startDate.toISOString().split('T')[0] : undefined,
      endDate: m.endDate ? m.endDate.toISOString().split('T')[0] : undefined,
      reminderTimes: Array.isArray(m.reminderTimes) ? m.reminderTimes : undefined,
      notes: m.notes ?? undefined,
      discontinuedReason: m.discontinuedReason ?? undefined,
      discontinuedAt: m.discontinuedAt ?? undefined,
      completedAt: m.completedAt ?? undefined,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }
}

// ==========================================
// IN-MEMORY / TEST DOUBLE IMPLEMENTATIONS
// ==========================================

export class InMemoryUploadIntentRepository implements UploadIntentRepository {
  private intents = new Map<string, UploadIntentRecord>();

  async createIntent(input: CreateUploadIntentInput): Promise<UploadIntentRecord> {
    const record: UploadIntentRecord = {
      id: crypto.randomUUID(),
      patientProfileId: input.patientProfileId,
      storageKey: input.storageKey,
      originalFilename: input.originalFilename || `upload-${input.storageKey.split('/').pop()}`,
      mimeType: input.mimeType,
      declaredSizeBytes: input.declaredSizeBytes,
      expiresAt: input.expiresAt,
      consumed: false,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.intents.set(input.storageKey, record);
    return { ...record };
  }

  async getIntent(storageKey: string): Promise<UploadIntentRecord | null> {
    const record = this.intents.get(storageKey);
    return record ? { ...record } : null;
  }

  async acquireVerificationLock(
    storageKey: string,
    patientProfileId: string,
    leaseTimeoutMs = 30000
  ): Promise<AcquireLockResult> {
    const intent = this.intents.get(storageKey);
    if (!intent) {
      return { success: false, reason: 'Upload intent not found. Please initialize a new upload.', retryable: false };
    }
    if (intent.patientProfileId !== patientProfileId) {
      return { success: false, reason: 'Forbidden: Upload intent does not belong to the authenticated patient', retryable: false };
    }
    if (intent.status === 'VERIFIED') {
      return { success: false, reason: 'Upload intent has already been consumed. Duplicate confirmation rejected.', retryable: false };
    }
    if (intent.status === 'REJECTED') {
      return { success: false, reason: `Upload intent was rejected: ${intent.rejectionReason || 'Invalid upload'}`, retryable: false };
    }
    const now = new Date();
    if (now > intent.expiresAt) {
      return { success: false, reason: 'Upload ticket has expired (exceeded 15-minute window)', retryable: false };
    }
    const leaseCutoff = new Date(now.getTime() - leaseTimeoutMs);
    if (intent.status === 'VERIFYING' && intent.verifyingStartedAt && intent.verifyingStartedAt > leaseCutoff) {
      return { success: false, reason: 'Upload verification is currently in progress. Please wait.', retryable: true };
    }

    intent.status = 'VERIFYING';
    intent.verifyingStartedAt = now;
    intent.updatedAt = now;
    this.intents.set(storageKey, intent);
    return { success: true, intent: { ...intent } };
  }

  async releaseVerificationLock(storageKey: string, patientProfileId: string): Promise<void> {
    const intent = this.intents.get(storageKey);
    if (intent && intent.patientProfileId === patientProfileId && intent.status === 'VERIFYING') {
      intent.status = 'PENDING';
      intent.verifyingStartedAt = undefined;
      intent.updatedAt = new Date();
      this.intents.set(storageKey, intent);
    }
  }

  async markVerified(storageKey: string, patientProfileId: string): Promise<UploadIntentRecord> {
    const intent = this.intents.get(storageKey);
    if (!intent || intent.patientProfileId !== patientProfileId) {
      throw new Error('Upload intent not found');
    }
    intent.status = 'VERIFIED';
    intent.consumed = true;
    intent.verifyingStartedAt = undefined;
    intent.updatedAt = new Date();
    this.intents.set(storageKey, intent);
    return { ...intent };
  }

  async markRejected(storageKey: string, patientProfileId: string, reason: string): Promise<UploadIntentRecord> {
    const intent = this.intents.get(storageKey);
    if (!intent || intent.patientProfileId !== patientProfileId) {
      throw new Error('Upload intent not found');
    }
    intent.status = 'REJECTED';
    intent.consumed = false;
    intent.rejectionReason = reason;
    intent.verifyingStartedAt = undefined;
    intent.updatedAt = new Date();
    this.intents.set(storageKey, intent);
    return { ...intent };
  }

  async consumeIntent(storageKey: string, patientProfileId: string): Promise<UploadIntentRecord | null> {
    const lock = await this.acquireVerificationLock(storageKey, patientProfileId);
    if (!lock.success || !lock.intent) return null;
    return this.markVerified(storageKey, patientProfileId);
  }
}

export class InMemoryDocumentRepository implements DocumentRepository {
  private store: Map<string, DocumentRecord> = new Map();


  async create(data: Omit<DocumentRecord, 'id' | 'uploadedAt' | 'updatedAt'> & { id?: string }): Promise<DocumentRecord> {
    const id = data.id || crypto.randomUUID();
    const now = new Date();
    const record: DocumentRecord = {
      ...data,
      id,
      uploadedAt: now,
      updatedAt: now,
    };
    this.store.set(id, record);
    return { ...record };
  }

  async findById(id: string): Promise<DocumentRecord | null> {
    const item = this.store.get(id);
    return item ? { ...item } : null;
  }

  async findByStorageKey(storageKey: string): Promise<DocumentRecord | null> {
    for (const item of this.store.values()) {
      if (item.storageKey === storageKey) return { ...item };
    }
    return null;
  }

  async updateStatus(id: string, status: DocumentStatus): Promise<DocumentRecord> {
    const item = this.store.get(id);
    if (!item) throw new Error('Document not found');
    item.status = status;
    item.updatedAt = new Date();
    this.store.set(id, item);
    return { ...item };
  }

  async listByPatient(patientProfileId: string): Promise<DocumentRecord[]> {
    return Array.from(this.store.values())
      .filter((d) => d.patientProfileId === patientProfileId)
      .map((d) => ({ ...d }));
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}

export class InMemoryExtractionJobRepository implements ExtractionJobRepository {
  private store: Map<string, ExtractionJobRecord> = new Map();
  private idempotencyMap: Map<string, string> = new Map();

  async create(data: Omit<ExtractionJobRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<ExtractionJobRecord> {
    const key = `${data.patientProfileId}:${data.idempotencyKey}`;
    if (this.idempotencyMap.has(key)) {
      const existingId = this.idempotencyMap.get(key)!;
      return { ...this.store.get(existingId)! };
    }

    const id = data.id || crypto.randomUUID();
    const now = new Date();
    const record: ExtractionJobRecord = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.store.set(id, record);
    this.idempotencyMap.set(key, id);
    return { ...record };
  }

  async findById(id: string): Promise<ExtractionJobRecord | null> {
    const item = this.store.get(id);
    return item ? { ...item } : null;
  }

  async findByPatientAndIdempotencyKey(patientProfileId: string, idempotencyKey: string): Promise<ExtractionJobRecord | null> {
    const key = `${patientProfileId}:${idempotencyKey}`;
    const id = this.idempotencyMap.get(key);
    if (!id) return null;
    return this.findById(id);
  }

  async claimJobForProcessing(id: string): Promise<ExtractionJobRecord | null> {
    const job = this.store.get(id);
    if (!job || job.status !== 'QUEUED') return null;

    job.status = 'PROCESSING';
    job.startedAt = new Date();
    job.updatedAt = new Date();
    this.store.set(id, job);
    return { ...job };
  }

  async completeProcessing(
    id: string,
    extractedPayload: any,
    status: 'SUCCEEDED' | 'FAILED',
    errorMessage?: string
  ): Promise<ExtractionJobRecord | null> {
    const job = this.store.get(id);
    if (!job || job.status !== 'PROCESSING') {
      return null; // Concurrency safe: only updates if in PROCESSING
    }

    job.status = status;
    job.extractedPayload = extractedPayload;
    job.errorMessage = errorMessage;
    job.completedAt = new Date();
    job.updatedAt = new Date();
    this.store.set(id, job);
    return { ...job };
  }

  async cancelJob(id: string, patientProfileId: string): Promise<ExtractionJobRecord> {
    const job = this.store.get(id);
    if (!job || job.patientProfileId !== patientProfileId) {
      throw new Error('Extraction job not found');
    }

    if (job.status === 'SUCCEEDED' || job.confirmedAt) {
      throw new Error('Cannot cancel a completed or confirmed job');
    }

    job.status = 'CANCELLED';
    job.completedAt = new Date();
    job.updatedAt = new Date();
    this.store.set(id, job);
    return { ...job };
  }

  async recordRetry(id: string, errorMessage: string, maxRetries: number): Promise<ExtractionJobRecord> {
    const job = this.store.get(id);
    if (!job) throw new Error('Job not found');

    job.retryCount += 1;
    if (job.retryCount >= maxRetries) {
      job.status = 'FAILED';
      job.completedAt = new Date();
    } else {
      job.status = 'QUEUED';
    }
    job.errorMessage = errorMessage;
    job.updatedAt = new Date();
    this.store.set(id, job);
    return { ...job };
  }

  async setJobStartedAtForTesting(id: string, startedAt: Date): Promise<void> {
    const job = this.store.get(id);
    if (job) {
      job.startedAt = startedAt;
      this.store.set(id, job);
    }
  }

  async recoverStaleProcessingJobs(staleThresholdMs: number): Promise<ExtractionJobRecord[]> {
    const threshold = Date.now() - staleThresholdMs;
    const recovered: ExtractionJobRecord[] = [];

    for (const job of this.store.values()) {
      if (job.status === 'PROCESSING' && job.startedAt && job.startedAt.getTime() < threshold) {
        job.retryCount += 1;
        job.status = job.retryCount >= job.maxRetries ? 'FAILED' : 'QUEUED';
        job.errorMessage = 'Worker timeout or unexpected crash during processing';
        job.updatedAt = new Date();
        this.store.set(job.id, job);
        recovered.push({ ...job });
      }
    }

    return recovered;
  }
}

export class InMemoryPrescriptionRepository implements PrescriptionRepository {
  private prescriptions: Map<string, PrescriptionRecord> = new Map();
  private items: Map<string, PrescriptionItemRecord[]> = new Map();
  private timelineEvents: Map<string, TimelineEventRecord[]> = new Map();
  private confirmedJobIds: Set<string> = new Set();

  constructor(
    private readonly jobRepo: ExtractionJobRepository,
    private readonly docRepo: DocumentRepository,
    public medicationRepo?: InMemoryMedicationRepository
  ) {}

  setMedicationRepository(repo: InMemoryMedicationRepository) {
    this.medicationRepo = repo;
  }

  async confirmPrescriptionTransaction(
    input: ConfirmPrescriptionTransactionInput
  ): Promise<ConfirmedPrescriptionResult> {
    // 1. Double confirmation check (atomic in transaction)
    if (this.confirmedJobIds.has(input.jobId)) {
      throw new Error('This extraction job has already been confirmed');
    }

    const job = await this.jobRepo.findById(input.jobId);
    if (!job || job.patientProfileId !== input.patientProfileId) {
      throw new Error('Extraction job not found');
    }

    if (job.status !== 'SUCCEEDED') {
      throw new Error(`Cannot confirm an unreviewed or non-succeeded extraction job (current status: ${job.status})`);
    }

    if (job.confirmedAt) {
      throw new Error('This extraction job has already been confirmed');
    }

    const docId = input.documentId || job.documentId;
    const doc = await this.docRepo.findById(docId);
    if (!doc || doc.patientProfileId !== input.patientProfileId) {
      throw new Error('Source document not found');
    }

    const prescriptionId = crypto.randomUUID();
    const timelineEventId = crypto.randomUUID();
    const now = new Date();

    const prescription: PrescriptionRecord = {
      id: prescriptionId,
      patientProfileId: input.patientProfileId,
      documentId: docId,
      jobId: input.jobId,
      prescriptionDate: input.prescription.prescriptionDate,
      dateIsUncertain: input.prescription.dateIsUncertain,
      doctorName: input.prescription.doctorName,
      clinicHospitalName: input.prescription.clinicHospitalName,
      diagnosis: input.prescription.diagnosis,
      reviewStatus: 'CONFIRMED',
      confirmedAt: now,
      confirmedByUserId: input.prescription.confirmedByUserId,
      createdAt: now,
      updatedAt: now,
    };

    const itemRecords: PrescriptionItemRecord[] = input.items.map((it) => ({
      id: it.id || crypto.randomUUID(),
      prescriptionId,
      nameAsWritten: it.nameAsWritten,
      normalizedMedicineName: it.normalizedMedicineName,
      strength: it.strength,
      dosageForm: it.dosageForm,
      frequencyText: it.frequencyText,
      durationText: it.durationText,
      route: it.route,
      instructions: it.instructions,
      isActiveMedication: Boolean(it.isActiveMedication),
      sourceDocumentId: docId,
      createdAt: now,
      updatedAt: now,
    }));

    const timelineEvent: TimelineEventRecord = {
      id: timelineEventId,
      patientProfileId: input.patientProfileId,
      eventType: 'PRESCRIPTION_RECORDED',
      eventDate: input.timelineEvent.eventDate,
      dateIsUncertain: input.prescription.dateIsUncertain,
      datePrecision: input.prescription.dateIsUncertain ? 'UNCERTAIN' : 'EXACT',
      title: input.timelineEvent.title,
      summary: input.timelineEvent.summary,
      sourceDocumentId: docId,
      sourcePrescriptionId: prescriptionId,
      isVerified: true,
      createdAt: now,
      updatedAt: now,
    };

    // Commit changes
    this.prescriptions.set(prescriptionId, prescription);
    this.items.set(prescriptionId, itemRecords);

    const patientEvents = this.timelineEvents.get(input.patientProfileId) || [];
    patientEvents.unshift(timelineEvent);
    this.timelineEvents.set(input.patientProfileId, patientEvents);

    if (this.medicationRepo) {
      for (const it of itemRecords) {
        await this.medicationRepo.createMedication({
          patientProfileId: input.patientProfileId,
          nameAsWritten: it.nameAsWritten,
          normalizedMedicineName: it.normalizedMedicineName,
          strength: it.strength,
          dosageForm: it.dosageForm,
          route: it.route,
          prescribedInstructions: it.instructions || it.frequencyText,
          status: it.isActiveMedication ? 'ACTIVE' : 'INACTIVE',
          startDate: input.prescription.prescriptionDate,
          prescriptionItemId: it.id,
          prescriptionId,
          sourceDocumentId: docId,
        });
      }
    }

    this.confirmedJobIds.add(input.jobId);
    job.confirmedAt = now;

    await this.docRepo.updateStatus(docId, 'CONFIRMED');

    return {
      prescription,
      items: itemRecords,
      timelineEvent,
    };
  }

  async findById(
    id: string,
    patientProfileId: string
  ): Promise<{ prescription: PrescriptionRecord; items: PrescriptionItemRecord[] } | null> {
    const rx = this.prescriptions.get(id);
    if (!rx || rx.patientProfileId !== patientProfileId) return null;
    const its = this.items.get(id) || [];
    return { prescription: { ...rx }, items: its.map((i) => ({ ...i })) };
  }

  async listTimelineEvents(patientProfileId: string): Promise<TimelineEventRecord[]> {
    const list = this.timelineEvents.get(patientProfileId) || [];
    return list.map((e) => ({ ...e }));
  }
}

export class InMemoryTimelineRepository implements TimelineRepository {
  constructor(
    private readonly prescriptionRepo: InMemoryPrescriptionRepository,
    private readonly docRepo: InMemoryDocumentRepository
  ) {}

  async listTimelineEvents(
    patientProfileId: string,
    options?: TimelineFilterOptions
  ): Promise<{ events: TimelineEventDetailRecord[]; totalCount: number }> {
    const rawEvents = await this.prescriptionRepo.listTimelineEvents(patientProfileId);

    let filtered = rawEvents.filter((ev) => ev.isVerified);

    if (options?.category && options.category !== 'ALL') {
      if (options.category === 'PRESCRIPTION') {
        filtered = filtered.filter(
          (e) => e.eventType === 'PRESCRIPTION' || e.eventType === 'PRESCRIPTION_RECORDED'
        );
      } else {
        filtered = filtered.filter((e) => e.eventType === options.category);
      }
    }

    if (options?.year) {
      filtered = filtered.filter((e) => {
        const yr = parseInt(e.eventDate.substring(0, 4), 10);
        return yr === options.year;
      });
    }

    if (options?.search && options.search.trim()) {
      const q = options.search.trim().toLowerCase();
      const matched: TimelineEventRecord[] = [];

      for (const ev of filtered) {
        if (ev.title.toLowerCase().includes(q) || ev.summary.toLowerCase().includes(q)) {
          matched.push(ev);
          continue;
        }

        if (ev.sourcePrescriptionId) {
          const rxData = await this.prescriptionRepo.findById(
            ev.sourcePrescriptionId,
            patientProfileId
          );
          if (rxData) {
            const docName = rxData.prescription.doctorName?.toLowerCase() || '';
            const clinic = rxData.prescription.clinicHospitalName?.toLowerCase() || '';
            const diag = rxData.prescription.diagnosis?.toLowerCase() || '';
            const medMatch = rxData.items.some(
              (i) =>
                i.nameAsWritten.toLowerCase().includes(q) ||
                (i.normalizedMedicineName && i.normalizedMedicineName.toLowerCase().includes(q))
            );

            if (docName.includes(q) || clinic.includes(q) || diag.includes(q) || medMatch) {
              matched.push(ev);
            }
          }
        }
      }

      filtered = matched;
    }

    // Stable sort: newest eventDate first, then newest createdAt
    filtered.sort((a, b) => {
      const dateCmp = b.eventDate.localeCompare(a.eventDate);
      if (dateCmp !== 0) return dateCmp;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    const totalCount = filtered.length;
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 50);
    const offset = Math.max(options?.offset ?? 0, 0);
    const pageSlice = filtered.slice(offset, offset + limit);

    const detailedEvents: TimelineEventDetailRecord[] = [];

    for (const ev of pageSlice) {
      const hydrated = await this.hydrateEvent(ev, patientProfileId);
      detailedEvents.push(hydrated);
    }

    return { events: detailedEvents, totalCount };
  }

  async getTimelineEventById(
    id: string,
    patientProfileId: string
  ): Promise<TimelineEventDetailRecord | null> {
    const rawEvents = await this.prescriptionRepo.listTimelineEvents(patientProfileId);
    const ev = rawEvents.find((e) => e.id === id && e.patientProfileId === patientProfileId);
    if (!ev) return null;

    return this.hydrateEvent(ev, patientProfileId);
  }

  private async hydrateEvent(
    ev: TimelineEventRecord,
    patientProfileId: string
  ): Promise<TimelineEventDetailRecord> {
    let sourceDoc: TimelineEventDetailRecord['sourceDocument'];
    let sourceRx: TimelineEventDetailRecord['prescription'];

    const doc = await this.docRepo.findById(ev.sourceDocumentId);
    if (doc && doc.patientProfileId === patientProfileId) {
      sourceDoc = {
        id: doc.id,
        originalFilename: doc.originalFilename,
        mimeType: doc.mimeType,
        fileSizeBytes: doc.fileSizeBytes,
        pageCount: doc.pageCount,
        uploadedAt: doc.uploadedAt,
      };
    }

    if (ev.sourcePrescriptionId) {
      const rxResult = await this.prescriptionRepo.findById(
        ev.sourcePrescriptionId,
        patientProfileId
      );
      if (rxResult) {
        sourceRx = {
          id: rxResult.prescription.id,
          prescriptionDate: rxResult.prescription.prescriptionDate,
          dateIsUncertain: rxResult.prescription.dateIsUncertain,
          doctorName: rxResult.prescription.doctorName,
          clinicHospitalName: rxResult.prescription.clinicHospitalName,
          diagnosis: rxResult.prescription.diagnosis,
          confirmedAt: rxResult.prescription.confirmedAt,
          items: rxResult.items,
        };
      }
    }

    return {
      ...ev,
      dateIsUncertain: ev.dateIsUncertain ?? false,
      datePrecision: ev.datePrecision ?? 'EXACT',
      sourceDocument: sourceDoc,
      prescription: sourceRx,
    };
  }
}

export class InMemoryMedicationRepository implements MedicationRepository {
  private medications: Map<string, MedicationRecord> = new Map();
  private doseLogs: Map<string, DoseLogRecord> = new Map();

  constructor(
    private prescriptionRepo?: InMemoryPrescriptionRepository,
    private docRepo?: DocumentRepository
  ) {}

  setPrescriptionRepo(rxRepo: InMemoryPrescriptionRepository) {
    this.prescriptionRepo = rxRepo;
  }

  setDocRepo(docRepo: DocumentRepository) {
    this.docRepo = docRepo;
  }

  async createMedication(input: CreateMedicationInput): Promise<MedicationRecord> {
    const id = crypto.randomUUID();
    const now = new Date();
    const record: MedicationRecord = {
      id,
      patientProfileId: input.patientProfileId,
      prescriptionItemId: input.prescriptionItemId,
      prescriptionId: input.prescriptionId,
      sourceDocumentId: input.sourceDocumentId,
      nameAsWritten: input.nameAsWritten,
      normalizedMedicineName: input.normalizedMedicineName,
      strength: input.strength,
      dosageForm: input.dosageForm,
      route: input.route || 'ORAL',
      prescribedInstructions: input.prescribedInstructions,
      status: input.status || 'INACTIVE',
      startDate: input.startDate,
      endDate: input.endDate,
      reminderTimes: input.reminderTimes,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    };
    this.medications.set(id, record);
    return { ...record };
  }

  async listMedications(
    patientProfileId: string,
    status?: MedicationStatusType
  ): Promise<MedicationRecord[]> {
    const list: MedicationRecord[] = [];
    for (const med of this.medications.values()) {
      if (med.patientProfileId === patientProfileId) {
        if (!status || med.status === status) {
          list.push({ ...med });
        }
      }
    }
    return list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async getMedicationById(
    id: string,
    patientProfileId: string
  ): Promise<MedicationDetailRecord | null> {
    const med = this.medications.get(id);
    if (!med || med.patientProfileId !== patientProfileId) return null;

    let prescriptionData: MedicationDetailRecord['prescription'];
    if (med.prescriptionId && this.prescriptionRepo) {
      const rx = await this.prescriptionRepo.findById(med.prescriptionId, patientProfileId);
      if (rx) {
        prescriptionData = {
          id: rx.prescription.id,
          prescriptionDate: rx.prescription.prescriptionDate,
          doctorName: rx.prescription.doctorName,
          clinicHospitalName: rx.prescription.clinicHospitalName,
        };
      }
    }

    let sourceDocData: MedicationDetailRecord['sourceDocument'];
    if (med.sourceDocumentId && this.docRepo) {
      const doc = await this.docRepo.findById(med.sourceDocumentId);
      if (doc) {
        sourceDocData = {
          id: doc.id,
          originalFilename: doc.originalFilename,
          mimeType: doc.mimeType,
        };
      }
    }

    const doses: DoseLogRecord[] = [];
    for (const dl of this.doseLogs.values()) {
      if (dl.medicationId === id && dl.patientProfileId === patientProfileId) {
        doses.push({ ...dl });
      }
    }
    doses.sort((a, b) => b.scheduledTime.getTime() - a.scheduledTime.getTime());

    return {
      ...med,
      prescription: prescriptionData,
      sourceDocument: sourceDocData,
      doseLogs: doses,
    };
  }

  async updateMedicationStatus(
    id: string,
    patientProfileId: string,
    status: MedicationStatusType,
    meta?: { discontinuedReason?: string; completedAt?: Date; discontinuedAt?: Date }
  ): Promise<MedicationRecord> {
    const med = this.medications.get(id);
    if (!med || med.patientProfileId !== patientProfileId) {
      throw new Error('Medication not found');
    }

    const updated: MedicationRecord = {
      ...med,
      status,
      discontinuedReason: meta?.discontinuedReason,
      discontinuedAt: meta?.discontinuedAt,
      completedAt: meta?.completedAt,
      updatedAt: new Date(),
    };
    this.medications.set(id, updated);
    return { ...updated };
  }

  async updateReminderSchedule(
    id: string,
    patientProfileId: string,
    reminderTimes: string[],
    startDate?: string,
    endDate?: string
  ): Promise<MedicationRecord> {
    const med = this.medications.get(id);
    if (!med || med.patientProfileId !== patientProfileId) {
      throw new Error('Medication not found');
    }

    const updated: MedicationRecord = {
      ...med,
      reminderTimes,
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      updatedAt: new Date(),
    };
    this.medications.set(id, updated);
    return { ...updated };
  }

  async createDoseLogs(
    logs: Array<{ medicationId: string; patientProfileId: string; scheduledTime: Date }>
  ): Promise<DoseLogRecord[]> {
    const created: DoseLogRecord[] = [];
    const now = new Date();

    for (const l of logs) {
      // Check idempotency: unique per medicationId + scheduledTime
      const existingKey = Array.from(this.doseLogs.values()).find(
        (existing) =>
          existing.medicationId === l.medicationId &&
          existing.scheduledTime.getTime() === l.scheduledTime.getTime()
      );

      if (existingKey) {
        created.push({ ...existingKey });
        continue;
      }

      const id = crypto.randomUUID();
      const record: DoseLogRecord = {
        id,
        medicationId: l.medicationId,
        patientProfileId: l.patientProfileId,
        scheduledTime: l.scheduledTime,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
      };
      this.doseLogs.set(id, record);
      created.push({ ...record });
    }

    return created;
  }

  async listDoseLogs(patientProfileId: string, from: Date, to: Date): Promise<DoseLogRecord[]> {
    const list: DoseLogRecord[] = [];
    for (const dl of this.doseLogs.values()) {
      if (
        dl.patientProfileId === patientProfileId &&
        dl.scheduledTime.getTime() >= from.getTime() &&
        dl.scheduledTime.getTime() <= to.getTime()
      ) {
        list.push({ ...dl });
      }
    }
    return list.sort((a, b) => a.scheduledTime.getTime() - b.scheduledTime.getTime());
  }

  async getDoseLogById(id: string, patientProfileId: string): Promise<DoseLogRecord | null> {
    const dl = this.doseLogs.get(id);
    if (!dl || dl.patientProfileId !== patientProfileId) return null;
    return { ...dl };
  }

  async updateDoseAction(
    id: string,
    patientProfileId: string,
    status: DoseStatusType,
    actionTime: Date,
    meta?: { snoozeMinutes?: number; notes?: string }
  ): Promise<DoseLogRecord> {
    const dl = this.doseLogs.get(id);
    if (!dl || dl.patientProfileId !== patientProfileId) {
      throw new Error('Dose log not found');
    }

    const updated: DoseLogRecord = {
      ...dl,
      status,
      actionTime,
      snoozeMinutes: meta?.snoozeMinutes,
      notes: meta?.notes,
      updatedAt: new Date(),
    };
    this.doseLogs.set(id, updated);
    return { ...updated };
  }

  async cancelPendingDosesForMedication(
    medicationId: string,
    patientProfileId: string,
    fromDate: Date = new Date()
  ): Promise<number> {
    let count = 0;
    for (const [id, dl] of this.doseLogs.entries()) {
      if (
        dl.medicationId === medicationId &&
        dl.patientProfileId === patientProfileId &&
        dl.status === 'PENDING' &&
        dl.scheduledTime.getTime() >= fromDate.getTime()
      ) {
        this.doseLogs.delete(id);
        count++;
      }
    }
    return count;
  }
}
