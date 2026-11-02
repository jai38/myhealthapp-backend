import crypto from 'crypto';
import {
  PrescriptionExtractionProvider,
  PrescriptionExtractionInput,
} from './provider.js';
import { ExtractedPrescriptionPayloadSchema } from '../prescriptions/schemas.js';
import { DocumentService } from '../documents/document-service.js';
import { ExtractionDispatcher, ExtractionResultMessage } from './messages.js';
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
    options?: { processingTimeoutMs?: number; dispatcher?: ExtractionDispatcher }
  ) {
    if (options?.processingTimeoutMs) {
      this.processingTimeoutMs = options.processingTimeoutMs;
    }
    this.dispatcher = options?.dispatcher;
  }

  /** When set, extraction runs in the separate worker and results come back through applyResult. */
  private readonly dispatcher?: ExtractionDispatcher;

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

    if (this.dispatcher) {
      return this.dispatchClaimedJob(claimedJob);
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
      return this.recordFailure(claimedJob, errorMessage);
    }
  }

  /**
   * Queue mode: hands a claimed job to the worker. The job stays PROCESSING until the worker's result
   * is applied, or until stale-job recovery re-queues it.
   */
  private async dispatchClaimedJob(claimedJob: ExtractionJobRecord): Promise<ExtractionJobRecord> {
    try {
      const doc = await this.documentService.getDocument(
        claimedJob.patientProfileId,
        claimedJob.documentId
      );
      await this.dispatcher!.dispatch({
        version: 1,
        jobId: claimedJob.id,
        patientProfileId: claimedJob.patientProfileId,
        documentId: claimedJob.documentId,
        storageKey: doc.storageKey,
        mimeType: doc.mimeType as 'image/jpeg' | 'image/png' | 'application/pdf',
      });
      return claimedJob;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to hand job to the extraction worker';
      return this.recordFailure(claimedJob, errorMessage, false);
    }
  }

  /**
   * Counts a failed attempt: back to QUEUED while retries remain, FAILED (and the document marked FAILED)
   * once they are exhausted. In queue mode a retry is dispatched again straight away unless told not to.
   */
  private async recordFailure(
    claimedJob: ExtractionJobRecord,
    errorMessage: string,
    redispatch: boolean = true
  ): Promise<ExtractionJobRecord> {
    const updatedJob = await this.jobRepository.recordRetry(
      claimedJob.id,
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
      return updatedJob;
    }

    if (this.dispatcher && redispatch && updatedJob.status === 'QUEUED') {
      return this.processJob(updatedJob.id);
    }

    return updatedJob;
  }

  /**
   * Queue mode: records the worker's outcome. Safe to call more than once for the same job and
   * ignores results for jobs that are cancelled, finished, unknown or owned by another patient.
   * The payload is validated here again; the worker is not trusted to produce a valid draft.
   */
  async applyResult(message: ExtractionResultMessage): Promise<ExtractionJobRecord | null> {
    const job = await this.jobRepository.findById(message.jobId);
    if (!job || job.patientProfileId !== message.patientProfileId) {
      return null;
    }
    if (job.status !== 'PROCESSING') {
      return job;
    }

    if (message.outcome === 'FAILED') {
      return this.recordFailure(job, message.error.slice(0, 200));
    }

    const parsed = ExtractedPrescriptionPayloadSchema.safeParse(message.payload);
    if (!parsed.success) {
      return this.recordFailure(job, 'Worker returned an extraction that failed validation');
    }

    const completedJob = await this.jobRepository.completeProcessing(job.id, parsed.data, 'SUCCEEDED');
    if (!completedJob) {
      // Cancelled while the worker was running: keep the cancelled state.
      return this.jobRepository.findById(job.id);
    }

    await this.documentService.updateStatus(job.patientProfileId, job.documentId, 'READY_FOR_REVIEW');
    return completedJob;
  }

  /**
   * Queue mode: re-queues jobs whose worker never answered (crash, dead-lettered message) and dispatches
   * them again. Jobs that run out of retries are marked FAILED with their document.
   */
  async recoverAndRedispatch(staleThresholdMs: number): Promise<ExtractionJobRecord[]> {
    const recovered = await this.jobRepository.recoverStaleProcessingJobs(staleThresholdMs);
    const results: ExtractionJobRecord[] = [];
    for (const job of recovered) {
      if (job.status === 'FAILED') {
        await this.documentService.updateStatus(job.patientProfileId, job.documentId, 'FAILED');
        results.push(job);
      } else if (this.dispatcher && job.status === 'QUEUED') {
        results.push(await this.processJob(job.id));
      } else {
        results.push(job);
      }
    }
    return results;
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
