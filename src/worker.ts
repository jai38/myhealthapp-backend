import { validateWorkerConfig } from './config/worker-env.js';
import { SqsMessageQueue } from './modules/ai-extraction/message-queue.js';
import { ExtractionWorker } from './modules/ai-extraction/extraction-worker.js';
import { GeminiPrescriptionExtractionProvider } from './modules/ai-extraction/gemini-provider.js';
import { MockPrescriptionExtractionProvider } from './modules/ai-extraction/provider.js';
import { S3DocumentReader } from './modules/storage/object-reader.js';

/**
 * Extraction worker entry point. Run as: node dist/worker.js
 *
 * It imports no database code and reads no database settings. It takes jobs from one queue, reads the
 * document from S3, calls the provider, and returns the result on a second queue.
 */
const config = validateWorkerConfig();

const provider = config.geminiApiKey
  ? new GeminiPrescriptionExtractionProvider(config.geminiApiKey, config.geminiModel)
  : new MockPrescriptionExtractionProvider();

const worker = new ExtractionWorker({
  jobs: new SqsMessageQueue(config.jobsQueueUrl),
  results: new SqsMessageQueue(config.resultsQueueUrl),
  reader: new S3DocumentReader(),
  provider,
  processingTimeoutMs: config.processingTimeoutMs,
  // Identifiers and counts only; no document content or extracted values.
  log: (line) => console.log(line),
});

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

console.log(`Extraction worker started in ${config.nodeEnv} mode using ${provider.providerName}`);
worker
  .run(() => stopping)
  .then(() => {
    console.log('Extraction worker stopped');
    process.exit(0);
  })
  .catch(() => {
    console.error('Extraction worker crashed');
    process.exit(1);
  });
