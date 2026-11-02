import { ZodError } from 'zod';
import { PrescriptionExtractionProvider } from './provider.js';
import { ExtractedPrescriptionPayloadSchema } from '../prescriptions/schemas.js';
import { MessageQueue } from './message-queue.js';
import {
  ExtractionResultMessage,
  ExtractionWorkMessage,
  ExtractionWorkMessageSchema,
} from './messages.js';
import { DocumentReader } from '../storage/object-reader.js';

export interface ExtractionWorkerDeps {
  jobs: MessageQueue;
  results: MessageQueue;
  reader: DocumentReader;
  provider: PrescriptionExtractionProvider;
  processingTimeoutMs?: number;
  /** Receives short, PHI-free lines (identifiers and counts only). */
  log?: (line: string) => void;
}

/**
 * Turns an error into a short, fixed description. Provider and storage errors can quote document
 * text or response bodies, so their messages never leave the worker.
 */
export function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (err instanceof ZodError) return 'Provider returned an invalid extraction';
  if (/timed out|timeout/i.test(message)) return 'Extraction timed out';
  if (/429|rate limit/i.test(message)) return 'Provider rate limit';
  if (/not found in storage|Forbidden: Storage key|exceeded maximum size/i.test(message)) {
    return 'Document could not be read';
  }
  return 'Provider error';
}

/**
 * Reads one extraction job at a time from the jobs queue, runs the provider, and answers on the
 * results queue. It holds no database access: the API records the outcome.
 *
 * A job message is deleted only after its result has been sent. If the result cannot be sent, or the
 * process dies first, the message becomes visible again and is retried, then dead-lettered.
 */
export class ExtractionWorker {
  private readonly processingTimeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: ExtractionWorkerDeps) {
    this.processingTimeoutMs = deps.processingTimeoutMs ?? 60_000;
    this.log = deps.log ?? (() => {});
  }

  /** Polls once. Returns how many messages were taken off the queue. */
  async pollOnce(waitSeconds: number = 20): Promise<number> {
    const received = await this.deps.jobs.receive({ maxMessages: 1, waitSeconds });
    let handled = 0;
    for (const message of received) {
      const done = await this.handle(message.body);
      if (done) {
        await this.deps.jobs.delete(message.receipt);
        handled += 1;
      }
    }
    return handled;
  }

  /** Runs until `shouldStop` returns true. Errors from the queue back off briefly and continue. */
  async run(shouldStop: () => boolean, waitSeconds: number = 20): Promise<void> {
    while (!shouldStop()) {
      try {
        await this.pollOnce(waitSeconds);
      } catch {
        this.log('worker poll failed; retrying');
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  /** Returns true when the message is finished and can be deleted. */
  private async handle(body: string): Promise<boolean> {
    let work: ExtractionWorkMessage;
    try {
      work = ExtractionWorkMessageSchema.parse(JSON.parse(body));
    } catch {
      // Never delete a message we cannot read: it ends up in the dead-letter queue for a person to inspect.
      this.log('worker skipped an unreadable job message');
      return false;
    }

    let result: ExtractionResultMessage;
    try {
      const buffer = await this.deps.reader.getObjectBuffer(work.storageKey, work.patientProfileId);
      const payload = await this.extractWithTimeout(buffer, work.mimeType);
      result = {
        version: 1,
        jobId: work.jobId,
        patientProfileId: work.patientProfileId,
        outcome: 'SUCCEEDED',
        payload,
      };
    } catch (err: unknown) {
      result = {
        version: 1,
        jobId: work.jobId,
        patientProfileId: work.patientProfileId,
        outcome: 'FAILED',
        error: describeFailure(err),
      };
    }

    // If this throws, the job message is not deleted and will be retried.
    await this.deps.results.send(JSON.stringify(result));
    this.log(`worker finished job ${work.jobId}: ${result.outcome}`);
    return true;
  }

  private async extractWithTimeout(buffer: Buffer, mimeType: string) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Processing timed out after ${this.processingTimeoutMs}ms`)),
        this.processingTimeoutMs,
      );
    });
    try {
      const raw = await Promise.race([
        this.deps.provider.extractPrescription({ documentBuffer: buffer, mimeType, regionHint: 'IN' }),
        timeout,
      ]);
      return ExtractedPrescriptionPayloadSchema.parse(raw);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
