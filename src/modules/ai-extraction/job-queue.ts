import crypto from 'crypto';
import {
  PrescriptionExtractionProvider,
  PrescriptionExtractionInput,
} from './provider.js';
import { ExtractedPrescriptionPayloadSchema } from '../prescriptions/schemas.js';
import { DocumentService } from '../documents/document-service.js';
import {
  ExtractionJobRepository,
  ExtractionJobRecord,
  JobStatus,
} from '../persistence/repositories.js';

export { ExtractionJobRecord, JobStatus };

export interface CreateJobInput {
  patientProfileId: string;
  documentId: string;
  idempotencyKey?: string;
}

export class ExtractionJobQueue {
  private processingTimeoutMs: number = 30000; // 30s timeout

  constructor(
    private readonly provider: PrescriptionExtractionProvider,
    private readonly documentService: DocumentService,
    private readonly jobRepository: ExtractionJobRepository,
    options?: { processingTimeoutMs?: number }
  ) {
    if (options?.processingTimeoutMs) {
      this.processingTimeoutMs = options.processingTimeoutMs;
    }
  }

  /**
   * Submits an extraction job with durable, patient-scoped idempotency.
   * If a job with the same idempotencyKey exists for this patient, returns existing job.
   */
  async submitJob(input: CreateJobInput): Promise<ExtractionJobRecord> {
    const idempotencyKey =
      input.idempotencyKey || `doc-${input.documentId}-${input.patientProfileId}`;

    // 1. Check for existing idempotent job in durable store
    const existing = await this.jobRepository.findByPatientAndIdempotencyKey(
      input.patientProfileId,
      idempotencyKey
    );
    if (existing) {
      return existing;
    }

    // 2. Verify source document exists and belongs to patient
    await this.documentService.getDocument(
      input.patientProfileId,
      input.documentId
    );

    const jobId = crypto.randomUUID();

    // 3. Persist queued job
    const record = await this.jobRepository.create({
      id: jobId,
      patientProfileId: input.patientProfileId,
      documentId: input.documentId,
      idempotencyKey,
      status: 'QUEUED',
      retryCount: 0,
      maxRetries: 3,
      providerName: this.provider.providerName,
    });

    // 4. Update document status to EXTRACTING
    await this.documentService.updateStatus(
      input.patientProfileId,
      input.documentId,
      'EXTRACTING'
    );

    return record;
  }

  /**
   * Retrieves job with strict patient ownership check.
   */
  async getJob(patientProfileId: string, jobId: string): Promise<ExtractionJobRecord> {
    const job = await this.jobRepository.findById(jobId);
    if (!job || job.patientProfileId !== patientProfileId) {
      throw new Error('Extraction job not found');
    }
    return job;
  }

  /**
   * Processes a queued job with atomic claim, concurrency safety, timeout enforcement,
   * and terminal state overwrite protection.
   */
  async processJob(jobId: string): Promise<ExtractionJobRecord> {
    // 1. Concurrency-safe atomic claim
    const claimedJob = await this.jobRepository.claimJobForProcessing(jobId);
    if (!claimedJob) {
      // Either already claimed, or already in terminal state
      const current = await this.jobRepository.findById(jobId);
      if (!current) throw new Error('Job not found');
      return current;
    }

    try {
      // 2. Retrieve source document securely
      const { buffer, doc } = await this.documentService.getDocumentBuffer(
        claimedJob.patientProfileId,
        claimedJob.documentId
      );

      const extractionInput: PrescriptionExtractionInput = {
        documentBuffer: buffer,
        mimeType: doc.mimeType,
        regionHint: 'IN',
      };

      // 3. Enforce processing timeout
      const extractionPromise = this.provider.extractPrescription(extractionInput);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Processing timed out after ${this.processingTimeoutMs}ms`)),
          this.processingTimeoutMs
        )
      );

      const rawResult = await Promise.race([extractionPromise, timeoutPromise]);

      // 4. Strict domain schema validation
      const validatedPayload = ExtractedPrescriptionPayloadSchema.parse(rawResult);

      // 5. Atomic completion (fails if job was cancelled during processing!)
      const completedJob = await this.jobRepository.completeProcessing(
        jobId,
        validatedPayload,
        'SUCCEEDED'
      );

      if (!completedJob) {
        // Job was cancelled by user while provider was processing; keep CANCELLED state!
        const current = await this.jobRepository.findById(jobId);
        return current!;
      }

      // 6. Update document status to READY_FOR_REVIEW
      await this.documentService.updateStatus(
        claimedJob.patientProfileId,
        claimedJob.documentId,
        'READY_FOR_REVIEW'
      );

      return completedJob;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown extraction failure';

      // 7. Record bounded retry or terminal failure
      const updatedJob = await this.jobRepository.recordRetry(
        jobId,
        errorMessage,
        claimedJob.maxRetries
      );

      if (updatedJob.status === 'FAILED') {
        // Update document status to FAILED while keeping source document intact
        await this.documentService.updateStatus(
          claimedJob.patientProfileId,
          claimedJob.documentId,
          'FAILED'
        );
      }

      return updatedJob;
    }
  }

  /**
   * Concurrency-safe job cancellation.
   */
  async cancelJob(patientProfileId: string, jobId: string): Promise<ExtractionJobRecord> {
    return this.jobRepository.cancelJob(jobId, patientProfileId);
  }

  /**
   * Recovers jobs left in PROCESSING state after worker crashes or interruptions.
   */
  async recoverStaleJobs(staleThresholdMs: number = 60000): Promise<ExtractionJobRecord[]> {
    return this.jobRepository.recoverStaleProcessingJobs(staleThresholdMs);
  }
}
