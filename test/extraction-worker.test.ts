import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { MemoryStorageProvider } from '../src/modules/storage/storage-provider.js';
import {
  MockPrescriptionExtractionProvider,
  PrescriptionExtractionProvider,
} from '../src/modules/ai-extraction/provider.js';
import { InMemoryMessageQueue } from '../src/modules/ai-extraction/message-queue.js';
import { QueueExtractionDispatcher } from '../src/modules/ai-extraction/queue-dispatcher.js';
import { ExtractionWorker } from '../src/modules/ai-extraction/extraction-worker.js';
import { ExtractionResultConsumer } from '../src/modules/ai-extraction/result-consumer.js';
import { ExtractionJobQueue } from '../src/modules/ai-extraction/job-queue.js';
import { validateWorkerConfig } from '../src/config/worker-env.js';
import {
  InMemoryDocumentRepository,
  InMemoryExtractionJobRepository,
  InMemoryPrescriptionRepository,
  InMemoryUploadIntentRepository,
} from '../src/modules/persistence/repositories.js';

const TOKEN_A = 'Bearer mock-access-jwt-userA'; // pat_userA
const PLANTED = 'Plantedmedicine-Zorblax-9000';

describe('extraction worker split (queue mode)', () => {
  let storage: MemoryStorageProvider;
  let docRepo: InMemoryDocumentRepository;
  let jobRepo: InMemoryExtractionJobRepository;
  let prescriptionRepo: InMemoryPrescriptionRepository;
  let jobsQueue: InMemoryMessageQueue;
  let resultsQueue: InMemoryMessageQueue;
  let app: ReturnType<typeof createApp>;
  let jobQueue: ExtractionJobQueue;

  async function uploadDocument(): Promise<string> {
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 600]).drawText('Clinical document');
    const bytes = Buffer.from(await pdf.save());
    const intent = await request(app)
      .post('/api/v1/documents/upload-intent')
      .set('Authorization', TOKEN_A)
      .send({ filename: 'rx.pdf', mimeType: 'application/pdf', fileSizeBytes: bytes.length });
    const storageKey = intent.body.data.storageKey as string;
    await storage.putObjectDirect(storageKey, bytes);
    const confirm = await request(app)
      .post('/api/v1/documents/confirm-upload')
      .set('Authorization', TOKEN_A)
      .send({ storageKey, mimeType: 'application/pdf' });
    return confirm.body.data.id as string;
  }

  function makeWorker(provider: PrescriptionExtractionProvider, results = resultsQueue) {
    return new ExtractionWorker({ jobs: jobsQueue, results, reader: storage, provider });
  }

  function makeConsumer() {
    return new ExtractionResultConsumer(resultsQueue, jobQueue);
  }

  async function submit(documentId: string) {
    return request(app)
      .post('/api/v1/prescriptions/extract-job')
      .set('Authorization', TOKEN_A)
      .send({ documentId });
  }

  beforeEach(() => {
    const uploadIntentRepo = new InMemoryUploadIntentRepository();
    storage = new MemoryStorageProvider(uploadIntentRepo);
    docRepo = new InMemoryDocumentRepository();
    jobRepo = new InMemoryExtractionJobRepository();
    prescriptionRepo = new InMemoryPrescriptionRepository(jobRepo, docRepo);
    jobsQueue = new InMemoryMessageQueue();
    resultsQueue = new InMemoryMessageQueue();
    app = createApp({
      storageProvider: storage,
      docRepo,
      jobRepo,
      prescriptionRepo,
      uploadIntentRepo,
      extractionDispatcher: new QueueExtractionDispatcher(jobsQueue),
    });
    jobQueue = app.locals.extractionJobQueue as ExtractionJobQueue;
  });

  it('hands the job to the queue instead of running the provider in the request', async () => {
    const documentId = await uploadDocument();
    const res = await submit(documentId);

    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('PROCESSING');
    expect(res.body.data.extractedPayload).toBeUndefined();
    expect(jobsQueue.visibleCount).toBe(1);

    const message = JSON.parse(jobsQueue.peekBodies()[0]);
    expect(message.jobId).toBe(res.body.data.id);
    expect(message.patientProfileId).toBe('pat_userA');
    expect(message.storageKey).toMatch(/^documents\/pat_userA\/[0-9a-f-]{36}$/);
    // The message carries identifiers only, never document bytes.
    expect(Object.keys(message).sort()).toEqual(
      ['documentId', 'jobId', 'mimeType', 'patientProfileId', 'storageKey', 'version'],
    );
  });

  it('runs end to end: API queues, worker extracts, API records the draft', async () => {
    const documentId = await uploadDocument();
    const submitted = await submit(documentId);
    const jobId = submitted.body.data.id as string;

    expect(await makeWorker(new MockPrescriptionExtractionProvider({ mode: 'CLEAN' })).pollOnce(0)).toBe(1);
    expect(jobsQueue.inFlightCount).toBe(0);
    expect(resultsQueue.visibleCount).toBe(1);

    expect(await makeConsumer().pollOnce(0)).toBe(1);

    const polled = await request(app)
      .get(`/api/v1/prescriptions/extract-job/${jobId}`)
      .set('Authorization', TOKEN_A);
    expect(polled.body.data.status).toBe('SUCCEEDED');
    expect(polled.body.data.extractedPayload.medicines[0].name_as_written).toBe('Glycomet 500 SR');
    expect((await docRepo.findById(documentId))?.status).toBe('READY_FOR_REVIEW');
  });

  it('keeps AI output a draft: nothing reaches the timeline until the patient confirms', async () => {
    const documentId = await uploadDocument();
    await submit(documentId);
    await makeWorker(new MockPrescriptionExtractionProvider({ mode: 'CLEAN' })).pollOnce(0);
    await makeConsumer().pollOnce(0);

    const timeline = await request(app).get('/api/v1/timeline').set('Authorization', TOKEN_A);
    expect(timeline.status).toBe(200);
    expect(JSON.stringify(timeline.body)).not.toContain('Glycomet');
  });

  it('retries a failed attempt through the queue and ends FAILED when retries run out', async () => {
    const documentId = await uploadDocument();
    const submitted = await submit(documentId);
    const jobId = submitted.body.data.id as string;
    const worker = makeWorker(new MockPrescriptionExtractionProvider({ mode: 'PROVIDER_ERROR' }));
    const consumer = makeConsumer();

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await worker.pollOnce(0)).toBe(1);
      expect(await consumer.pollOnce(0)).toBe(1);
    }

    const job = await jobRepo.findById(jobId);
    expect(job?.status).toBe('FAILED');
    expect(job?.retryCount).toBe(3);
    expect(jobsQueue.visibleCount).toBe(0);
    expect((await docRepo.findById(documentId))?.status).toBe('FAILED');
  });

  it('never sends provider error text back, since it could quote document content', async () => {
    const documentId = await uploadDocument();
    await submit(documentId);
    const leaky: PrescriptionExtractionProvider = {
      providerName: 'leaky',
      extractPrescription: async () => {
        throw new Error(`upstream said: patient takes ${PLANTED}`);
      },
    };
    await makeWorker(leaky).pollOnce(0);

    const body = resultsQueue.peekBodies()[0];
    expect(JSON.parse(body).outcome).toBe('FAILED');
    expect(body).not.toContain(PLANTED);
  });

  it('reports a failed attempt when the provider output does not match the schema', async () => {
    const documentId = await uploadDocument();
    await submit(documentId);
    const bad: PrescriptionExtractionProvider = {
      providerName: 'bad',
      extractPrescription: async () => ({ medicines: 'not-a-list' }) as never,
    };
    await makeWorker(bad).pollOnce(0);
    expect(JSON.parse(resultsQueue.peekBodies()[0]).outcome).toBe('FAILED');
  });

  it('re-validates the payload on the API side and does not trust a bad result', async () => {
    const documentId = await uploadDocument();
    const submitted = await submit(documentId);
    const jobId = submitted.body.data.id as string;

    await resultsQueue.send(
      JSON.stringify({
        version: 1,
        jobId,
        patientProfileId: 'pat_userA',
        outcome: 'SUCCEEDED',
        payload: { medicines: 'garbage' },
      }),
    );
    await makeConsumer().pollOnce(0);

    const job = await jobRepo.findById(jobId);
    expect(job?.status).not.toBe('SUCCEEDED');
    expect(job?.extractedPayload).toBeUndefined();
  });

  it('ignores a result that names a different patient than the job owner', async () => {
    const documentId = await uploadDocument();
    const submitted = await submit(documentId);
    const jobId = submitted.body.data.id as string;
    const good = new MockPrescriptionExtractionProvider({ mode: 'CLEAN' });
    const payload = await good.extractPrescription({ documentBuffer: Buffer.from('x'), mimeType: 'application/pdf' });

    await resultsQueue.send(
      JSON.stringify({ version: 1, jobId, patientProfileId: 'pat_userB', outcome: 'SUCCEEDED', payload }),
    );
    await makeConsumer().pollOnce(0);

    expect((await jobRepo.findById(jobId))?.status).toBe('PROCESSING');
  });

  it('keeps a cancelled job cancelled when the worker answers late', async () => {
    const documentId = await uploadDocument();
    const submitted = await submit(documentId);
    const jobId = submitted.body.data.id as string;

    await request(app)
      .post(`/api/v1/prescriptions/extract-job/${jobId}/cancel`)
      .set('Authorization', TOKEN_A);

    await makeWorker(new MockPrescriptionExtractionProvider({ mode: 'CLEAN' })).pollOnce(0);
    await makeConsumer().pollOnce(0);

    expect((await jobRepo.findById(jobId))?.status).toBe('CANCELLED');
  });

  it('treats a duplicate result as already handled', async () => {
    const documentId = await uploadDocument();
    const submitted = await submit(documentId);
    const jobId = submitted.body.data.id as string;
    await makeWorker(new MockPrescriptionExtractionProvider({ mode: 'CLEAN' })).pollOnce(0);
    const duplicate = resultsQueue.peekBodies()[0];
    await resultsQueue.send(duplicate);

    const consumer = makeConsumer();
    expect(await consumer.pollOnce(0)).toBe(2);
    expect((await jobRepo.findById(jobId))?.status).toBe('SUCCEEDED');
    expect((await jobRepo.findById(jobId))?.retryCount).toBe(0);
  });

  it('leaves an unreadable job message in the queue so it can be dead-lettered', async () => {
    await jobsQueue.send('{ not json');
    const worker = makeWorker(new MockPrescriptionExtractionProvider());
    expect(await worker.pollOnce(0)).toBe(0);
    expect(jobsQueue.inFlightCount).toBe(1);
    expect(resultsQueue.visibleCount).toBe(0);
  });

  it('does not delete a job when the result cannot be sent, so it is delivered again', async () => {
    const documentId = await uploadDocument();
    await submit(documentId);
    const brokenResults = new InMemoryMessageQueue();
    brokenResults.send = async () => {
      throw new Error('queue unavailable');
    };
    const worker = makeWorker(new MockPrescriptionExtractionProvider({ mode: 'CLEAN' }), brokenResults);

    await expect(worker.pollOnce(0)).rejects.toThrow();
    expect(jobsQueue.inFlightCount).toBe(1);

    jobsQueue.releaseInFlight();
    expect(jobsQueue.visibleCount).toBe(1);
  });

  it('refuses a storage key that belongs to another patient', async () => {
    await jobsQueue.send(
      JSON.stringify({
        version: 1,
        jobId: 'job_1',
        patientProfileId: 'pat_userA',
        documentId: 'doc_1',
        storageKey: 'documents/pat_userB/6f1c1b7e-3b0e-4f4c-9d8e-0a1b2c3d4e5f',
        mimeType: 'application/pdf',
      }),
    );
    await makeWorker(new MockPrescriptionExtractionProvider()).pollOnce(0);

    const result = JSON.parse(resultsQueue.peekBodies()[0]);
    expect(result.outcome).toBe('FAILED');
    expect(result.error).toBe('Document could not be read');
  });

  it('re-queues and re-dispatches a job whose worker never answered', async () => {
    const documentId = await uploadDocument();
    const submitted = await submit(documentId);
    const jobId = submitted.body.data.id as string;
    jobsQueue.releaseInFlight();
    await jobsQueue.receive({ maxMessages: 10 }); // the lost message is gone for good

    const recovered = await jobQueue.recoverAndRedispatch(-1);

    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).toBe(jobId);
    expect(recovered[0].status).toBe('PROCESSING');
    expect(recovered[0].retryCount).toBe(1);
    expect(jobsQueue.visibleCount).toBe(1);
  });

  it('records a failed attempt when the queue rejects the dispatch', async () => {
    const failing = new InMemoryMessageQueue();
    failing.send = async () => {
      throw new Error('queue unavailable');
    };
    const failingApp = createApp({
      storageProvider: storage,
      docRepo,
      jobRepo,
      prescriptionRepo,
      extractionDispatcher: new QueueExtractionDispatcher(failing),
    });
    const prev = app;
    app = failingApp;
    const documentId = await uploadDocument();
    const res = await submit(documentId);
    app = prev;

    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('QUEUED');
    expect(res.body.data.retryCount).toBe(1);
  });

  it('keeps in-process extraction as the default when no dispatcher is configured', async () => {
    const inlineApp = createApp({
      storageProvider: storage,
      docRepo,
      jobRepo,
      prescriptionRepo,
      extractionProvider: new MockPrescriptionExtractionProvider({ mode: 'CLEAN' }),
    });
    const prev = app;
    app = inlineApp;
    const documentId = await uploadDocument();
    const res = await submit(documentId);
    app = prev;

    expect(res.body.data.status).toBe('SUCCEEDED');
  });
});

describe('worker configuration guard', () => {
  const valid = {
    NODE_ENV: 'production',
    EXTRACTION_JOBS_QUEUE_URL: 'https://sqs.ap-south-1.amazonaws.com/123456789012/jobs',
    EXTRACTION_RESULTS_QUEUE_URL: 'https://sqs.ap-south-1.amazonaws.com/123456789012/results',
    STORAGE_BUCKET: 'bucket-name',
    GEMINI_API_KEY: 'placeholder-key-value',
    AI_PROVIDER_APPROVED: 'true',
  };

  it('accepts a correct production worker environment', () => {
    expect(validateWorkerConfig(valid).jobsQueueUrl).toBe(valid.EXTRACTION_JOBS_QUEUE_URL);
  });

  it.each(['DATABASE_URL', 'JWT_SECRET', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'])(
    'refuses to start in production when %s is set',
    (name) => {
      expect(() => validateWorkerConfig({ ...valid, [name]: 'anything' })).toThrow(
        new RegExp(`${name} must not be set on the extraction worker`),
      );
    },
  );

  it('does not print the value of a forbidden variable', () => {
    try {
      validateWorkerConfig({ ...valid, DATABASE_URL: 'postgresql://u:supersecretvalue@host/db' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('supersecretvalue');
    }
  });

  it('requires the AI approval flag and a provider key in production', () => {
    expect(() => validateWorkerConfig({ ...valid, AI_PROVIDER_APPROVED: 'false' })).toThrow(/AI_PROVIDER_APPROVED/);
    expect(() => validateWorkerConfig({ ...valid, GEMINI_API_KEY: '' })).toThrow(/GEMINI_API_KEY/);
  });

  it('requires real SQS queue URLs and a remote storage endpoint in production', () => {
    expect(() => validateWorkerConfig({ ...valid, EXTRACTION_JOBS_QUEUE_URL: 'http://localhost:9324/q' })).toThrow(
      /EXTRACTION_JOBS_QUEUE_URL/,
    );
    expect(() => validateWorkerConfig({ ...valid, STORAGE_ENDPOINT: 'http://localhost:9000' })).toThrow(
      /STORAGE_ENDPOINT/,
    );
  });

  it('does not require production-only settings outside production', () => {
    const cfg = validateWorkerConfig({
      NODE_ENV: 'development',
      EXTRACTION_JOBS_QUEUE_URL: 'http://localhost:9324/jobs',
      EXTRACTION_RESULTS_QUEUE_URL: 'http://localhost:9324/results',
    });
    expect(cfg.geminiApiKey).toBeUndefined();
  });
});

describe('worker has no path to the database', () => {
  const srcRoot = path.resolve(__dirname, '..', 'src');
  const forbidden = [
    /@prisma\/client/,
    /persistence\/database/,
    /persistence\/repositories/,
    /config\/env\.js/,
    /auth\/auth-adapter/,
    /dotenv/,
  ];

  function collectImports(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const source = fs.readFileSync(entry, 'utf-8');
    const specifiers = [...source.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(entry), spec.replace(/\.js$/, '.ts'));
        if (fs.existsSync(resolved)) collectImports(resolved, seen);
      } else {
        seen.add(`pkg:${spec}`);
      }
    }
    return seen;
  }

  it('imports no database, environment or auth module, directly or indirectly', () => {
    const graph = [...collectImports(path.join(srcRoot, 'worker.ts'))];
    const offenders = graph.filter((entry) => forbidden.some((re) => re.test(entry.replace(/\\/g, '/'))));
    expect(offenders).toEqual([]);
    // The check itself must be looking at the real graph.
    expect(graph.some((entry) => entry.endsWith('extraction-worker.ts'))).toBe(true);
  });
});
