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
  title: string;
  summary: string;
  sourceDocumentId: string;
  sourcePrescriptionId?: string;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
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

export interface UploadIntentRecord {
  id: string;
  patientProfileId: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  declaredSizeBytes: number;
  expiresAt: Date;
  consumed: boolean;
  createdAt: Date;
}

export interface CreateUploadIntentInput {
  patientProfileId: string;
  storageKey: string;
  originalFilename?: string;
  mimeType: string;
  declaredSizeBytes: number;
  expiresAt: Date;
}

export interface UploadIntentRepository {
  createIntent(input: CreateUploadIntentInput): Promise<UploadIntentRecord>;
  getIntent(storageKey: string): Promise<UploadIntentRecord | null>;
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
      createdAt: record.createdAt,
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
      createdAt: record.createdAt,
    };
  }

  async consumeIntent(storageKey: string, patientProfileId: string): Promise<UploadIntentRecord | null> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.uploadIntent.findFirst({
        where: {
          storageKey,
          patientProfileId,
          consumed: false,
          expiresAt: { gt: now },
        },
      });

      if (!existing) {
        return null;
      }

      const updateResult = await tx.uploadIntent.updateMany({
        where: {
          id: existing.id,
          consumed: false,
        },
        data: {
          consumed: true,
        },
      });

      if (updateResult.count === 0) {
        return null;
      }

      return {
        id: existing.id,
        patientProfileId: existing.patientProfileId,
        storageKey: existing.storageKey,
        originalFilename: existing.originalFilename,
        mimeType: existing.mimeType,
        declaredSizeBytes: existing.expectedSizeBytes,
        expiresAt: existing.expiresAt,
        consumed: true,
        createdAt: existing.createdAt,
      };
    });
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
        sourceDocumentId: input.documentId,
      }));

      await tx.prescriptionItem.createMany({
        data: itemRows,
      });

      // 5. Ingest into Verified Clinical Timeline
      const createdTimeline = await tx.timelineEvent.create({
        data: {
          id: timelineEventId,
          patientProfileId: input.patientProfileId,
          eventType: 'PRESCRIPTION_RECORDED',
          eventDate: parseDate(input.timelineEvent.eventDate) || now,
          title: input.timelineEvent.title,
          summary: input.timelineEvent.summary,
          sourceDocumentId: input.documentId,
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
        where: { id: input.documentId },
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
      createdAt: new Date(),
    };
    this.intents.set(input.storageKey, record);
    return { ...record };
  }

  async getIntent(storageKey: string): Promise<UploadIntentRecord | null> {
    const record = this.intents.get(storageKey);
    return record ? { ...record } : null;
  }

  async consumeIntent(storageKey: string, patientProfileId: string): Promise<UploadIntentRecord | null> {
    const intent = this.intents.get(storageKey);
    if (!intent) return null;
    if (intent.patientProfileId !== patientProfileId) return null;
    if (intent.consumed) return null;
    if (new Date() > intent.expiresAt) return null;

    intent.consumed = true;
    return { ...intent };
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
    private readonly docRepo: DocumentRepository
  ) {}

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
      sourceDocumentId: input.documentId,
      createdAt: now,
      updatedAt: now,
    }));

    const timelineEvent: TimelineEventRecord = {
      id: timelineEventId,
      patientProfileId: input.patientProfileId,
      eventType: 'PRESCRIPTION_RECORDED',
      eventDate: input.timelineEvent.eventDate,
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
