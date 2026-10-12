import crypto from 'crypto';
import {
  PrescriptionExtractionProvider,
  PrescriptionExtractionInput,
} from './provider.js';
import {
  ExtractedPrescriptionPayload,
  ExtractedPrescriptionPayloadSchema,
} from '../prescriptions/schemas.js';
import { DocumentService } from '../documents/document-service.js';

export type JobStatus = 'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface ExtractionJobRecord {
  id: string;
  patientProfileId: string;
  documentId: string;
  idempotencyKey: string;
  status: JobStatus;
  retryCount: number;
  maxRetries: number;
  providerName: string;
  extractedPayload?: ExtractedPrescriptionPayload;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface CreateJobInput {
  patientProfileId: string;
  documentId: string;
  idempotencyKey?: string;
}

export class ExtractionJobQueue {
  private jobs: Map<string, ExtractionJobRecord> = new Map();
  private idempotencyIndex: Map<string, string> = new Map(); // idempotencyKey -> jobId
  private processingTimeoutMs: number = 30000; // 30s timeout

  constructor(
    private readonly provider: PrescriptionExtractionProvider,
    private readonly documentService: DocumentService,
    options?: { processingTimeoutMs?: number }
  ) {
    if (options?.processingTimeoutMs) {
      this.processingTimeoutMs = options.processingTimeoutMs;
    }
  }

  /**
   * Submits an extraction job idempotently.
   * If a job with the same idempotencyKey already exists for this patient, returns existing job.
   */
  async submitJob(input: CreateJobInput): Promise<ExtractionJobRecord> {
    const idempotencyKey =
      input.idempotencyKey || `doc-${input.documentId}-${input.patientProfileId}`;

    const existingJobId = this.idempotencyIndex.get(idempotencyKey);
    if (existingJobId) {
      const existingJob = this.jobs.get(existingJobId);
      if (existingJob && existingJob.patientProfileId === input.patientProfileId) {
        return existingJob;
      }
    }

    // Verify document exists and belongs to the patient
    await this.documentService.getDocument(
      input.patientProfileId,
      input.documentId
    );

    const jobId = crypto.randomUUID();
    const now = new Date();

    const record: ExtractionJobRecord = {
      id: jobId,
      patientProfileId: input.patientProfileId,
      documentId: input.documentId,
      idempotencyKey,
      status: 'QUEUED',
      retryCount: 0,
      maxRetries: 3,
      providerName: this.provider.providerName,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(jobId, record);
    this.idempotencyIndex.set(idempotencyKey, jobId);

    // Update document status to EXTRACTING
    await this.documentService.updateStatus(
      input.patientProfileId,
      input.documentId,
      'EXTRACTING'
    );

    return record;
  }

  /**
   * Retrieves job with patient ownership check.
   */
  async getJob(patientProfileId: string, jobId: string): Promise<ExtractionJobRecord> {
    const job = this.jobs.get(jobId);
    if (!job || job.patientProfileId !== patientProfileId) {
      throw new Error('Extraction job not found');
    }
    return job;
  }

  /**
   * Processes a queued job. Executes provider with timeout and retry logic.
   */
  async processJob(jobId: string): Promise<ExtractionJobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error('Job not found');
    }

    if (job.status === 'SUCCEEDED' || job.status === 'CANCELLED') {
      return job;
    }

    job.status = 'PROCESSING';
    job.startedAt = new Date();
    job.updatedAt = new Date();

    try {
      // Retrieve document buffer securely
      const { buffer, doc } = await this.documentService.getDocumentBuffer(
        job.patientProfileId,
        job.documentId
      );

      const extractionInput: PrescriptionExtractionInput = {
        documentBuffer: buffer,
        mimeType: doc.mimeType,
        regionHint: 'IN',
      };

      // Wrap provider call with timeout
      const extractionPromise = this.provider.extractPrescription(extractionInput);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Processing timed out after ${this.processingTimeoutMs}ms`)),
          this.processingTimeoutMs
        )
      );

      const rawResult = await Promise.race([extractionPromise, timeoutPromise]);

      // Strict domain schema validation
      const validatedPayload = ExtractedPrescriptionPayloadSchema.parse(rawResult);

      job.status = 'SUCCEEDED';
      job.extractedPayload = validatedPayload;
      job.completedAt = new Date();
      job.updatedAt = new Date();
      job.errorMessage = undefined;

      // Update document status to READY_FOR_REVIEW
      await this.documentService.updateStatus(
        job.patientProfileId,
        job.documentId,
        'READY_FOR_REVIEW'
      );

      return job;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown extraction failure';
      job.retryCount += 1;
      job.updatedAt = new Date();
      job.errorMessage = errorMessage;

      if (job.retryCount >= job.maxRetries) {
        job.status = 'FAILED';
        job.completedAt = new Date();

        // Update document status to FAILED (without deleting source document)
        await this.documentService.updateStatus(
          job.patientProfileId,
          job.documentId,
          'FAILED'
        );
      } else {
        // Return to QUEUED status for bounded retry
        job.status = 'QUEUED';
      }

      return job;
    }
  }

  /**
   * Cancels a job if it is still queued or processing.
   */
  async cancelJob(patientProfileId: string, jobId: string): Promise<ExtractionJobRecord> {
    const job = await this.getJob(patientProfileId, jobId);
    if (job.status === 'SUCCEEDED') {
      throw new Error('Cannot cancel an already succeeded job');
    }

    job.status = 'CANCELLED';
    job.updatedAt = new Date();
    job.completedAt = new Date();

    return job;
  }
}
