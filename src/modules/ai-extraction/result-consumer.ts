import { MessageQueue } from './message-queue.js';
import { ExtractionResultMessageSchema } from './messages.js';
import { ExtractionJobQueue } from './job-queue.js';

/**
 * API side of the worker split. Reads the worker's results and records them on the job, and
 * periodically re-queues jobs whose worker never answered.
 */
export class ExtractionResultConsumer {
  constructor(
    private readonly results: MessageQueue,
    private readonly jobQueue: ExtractionJobQueue,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Polls once. Returns how many results were recorded. */
  async pollOnce(waitSeconds: number = 20): Promise<number> {
    const received = await this.results.receive({ maxMessages: 10, waitSeconds });
    let handled = 0;
    for (const message of received) {
      let parsed;
      try {
        parsed = ExtractionResultMessageSchema.parse(JSON.parse(message.body));
      } catch {
        // Left in the queue so it is dead-lettered for inspection rather than silently lost.
        this.log('api skipped an unreadable result message');
        continue;
      }
      try {
        await this.jobQueue.applyResult(parsed);
        await this.results.delete(message.receipt);
        handled += 1;
      } catch {
        // Likely a transient database error: leave the message to be delivered again.
        this.log(`api could not record result for job ${parsed.jobId}; will retry`);
      }
    }
    return handled;
  }

  /**
   * Starts the polling loop and the stale-job sweep. Returns a function that stops both.
   */
  start(options: { staleThresholdMs?: number; sweepIntervalMs?: number } = {}): () => void {
    const staleThresholdMs = options.staleThresholdMs ?? 10 * 60_000;
    const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    let stopped = false;

    const loop = async () => {
      while (!stopped) {
        try {
          await this.pollOnce();
        } catch {
          this.log('api result poll failed; retrying');
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    };
    void loop();

    const sweep = setInterval(() => {
      this.jobQueue.recoverAndRedispatch(staleThresholdMs).catch(() => {
        this.log('api stale job sweep failed');
      });
    }, sweepIntervalMs);
    sweep.unref();

    return () => {
      stopped = true;
      clearInterval(sweep);
    };
  }
}
