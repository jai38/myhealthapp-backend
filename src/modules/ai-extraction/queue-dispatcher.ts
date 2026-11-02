import { ExtractionDispatcher, ExtractionWorkMessage } from './messages.js';
import { MessageQueue } from './message-queue.js';

/** Sends extraction work to the worker's queue. */
export class QueueExtractionDispatcher implements ExtractionDispatcher {
  constructor(private readonly queue: MessageQueue) {}

  async dispatch(message: ExtractionWorkMessage): Promise<void> {
    await this.queue.send(JSON.stringify(message));
  }
}
