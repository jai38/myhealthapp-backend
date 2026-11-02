import { createApp } from './app.js';
import { env } from './config/env.js';
import { ExtractionJobQueue } from './modules/ai-extraction/job-queue.js';
import { SqsMessageQueue } from './modules/ai-extraction/message-queue.js';
import { ExtractionResultConsumer } from './modules/ai-extraction/result-consumer.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  // Safe logging: port and mode only, no tokens or PII
  console.log(`My Health App backend listening on port ${env.PORT} in ${env.NODE_ENV} mode`);
});

// Queue mode: record the worker's results and re-queue jobs whose worker never answered.
let stopConsumer: (() => void) | undefined;
if (env.EXTRACTION_MODE === 'sqs' && env.EXTRACTION_RESULTS_QUEUE_URL) {
  const jobQueue = app.locals.extractionJobQueue as ExtractionJobQueue;
  const consumer = new ExtractionResultConsumer(
    new SqsMessageQueue(env.EXTRACTION_RESULTS_QUEUE_URL),
    jobQueue,
    (line) => console.log(line),
  );
  stopConsumer = consumer.start();
  console.log('Extraction result consumer started');
}

// ECS sends SIGTERM on deploy; stop taking new requests and let in-flight ones finish.
process.on('SIGTERM', () => {
  stopConsumer?.();
  server.close(() => process.exit(0));
});
