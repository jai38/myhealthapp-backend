import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

export interface ReceivedMessage {
  body: string;
  /** Opaque handle used to delete the message after it has been handled. */
  receipt: string;
}

/** The small queue surface the API and worker need. */
export interface MessageQueue {
  send(body: string): Promise<void>;
  receive(options: { maxMessages: number; waitSeconds: number; visibilityTimeoutSeconds?: number }): Promise<ReceivedMessage[]>;
  delete(receipt: string): Promise<void>;
}

/**
 * Amazon SQS queue. Credentials and region come from the task role and environment.
 */
export class SqsMessageQueue implements MessageQueue {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    client?: SQSClient,
  ) {
    if (!queueUrl) {
      throw new Error('A queue URL is required');
    }
    this.client = client ?? new SQSClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  }

  async send(body: string): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: body }));
  }

  async receive(options: {
    maxMessages: number;
    waitSeconds: number;
    visibilityTimeoutSeconds?: number;
  }): Promise<ReceivedMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.min(Math.max(options.maxMessages, 1), 10),
        WaitTimeSeconds: Math.min(Math.max(options.waitSeconds, 0), 20),
        VisibilityTimeout: options.visibilityTimeoutSeconds,
      }),
    );
    return (response.Messages ?? [])
      .filter((m) => m.Body !== undefined && m.ReceiptHandle !== undefined)
      .map((m) => ({ body: m.Body as string, receipt: m.ReceiptHandle as string }));
  }

  async delete(receipt: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receipt }));
  }
}

/**
 * In-memory queue for tests. Delivered messages stay invisible until deleted or released,
 * which mirrors SQS closely enough to test redelivery.
 */
export class InMemoryMessageQueue implements MessageQueue {
  private ready: Array<{ body: string; receipt: string }> = [];
  private inFlight = new Map<string, { body: string; receipt: string }>();
  private counter = 0;

  async send(body: string): Promise<void> {
    this.counter += 1;
    this.ready.push({ body, receipt: `r-${this.counter}` });
  }

  async receive(options: { maxMessages: number }): Promise<ReceivedMessage[]> {
    const batch = this.ready.splice(0, options.maxMessages);
    for (const m of batch) this.inFlight.set(m.receipt, m);
    return batch.map((m) => ({ body: m.body, receipt: m.receipt }));
  }

  async delete(receipt: string): Promise<void> {
    this.inFlight.delete(receipt);
  }

  /** Test helper: make undeleted messages visible again, like a visibility timeout expiring. */
  releaseInFlight(): void {
    this.ready.push(...this.inFlight.values());
    this.inFlight.clear();
  }

  get visibleCount(): number {
    return this.ready.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Test helper: bodies currently waiting, without consuming them. */
  peekBodies(): string[] {
    return this.ready.map((m) => m.body);
  }
}
