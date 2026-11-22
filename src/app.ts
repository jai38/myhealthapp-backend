import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { createAuthMiddleware, requireCompletedAccount, requireOwnership } from './middleware/auth.js';
import { PhoneAuthService } from './modules/phone-auth/phone-auth-service.js';
import { InMemoryPhoneAuthStore, type PhoneAuthStore } from './modules/phone-auth/store.js';
import { PrismaPhoneAuthStore } from './modules/phone-auth/prisma-store.js';
import {
  DisabledWhatsAppSender,
  MemoryWhatsAppSender,
  MetaCloudWhatsAppSender,
  type WhatsAppSender,
} from './modules/phone-auth/whatsapp-sender.js';
import {
  createPhoneAccountRouter,
  createPhoneAuthRouter,
  createWhatsAppWebhookRouter,
} from './modules/phone-auth/routes.js';
import { createAppStatusHandler, AppStatusConfig, appStatusFromEnv } from './modules/app-status/app-status.js';
import { errorHandler } from './middleware/errorHandler.js';
import {
  StorageProvider,
  S3StorageProvider,
  MemoryStorageProvider,
} from './modules/storage/storage-provider.js';
import {
  PrescriptionExtractionProvider,
  MockPrescriptionExtractionProvider,
  QueuedExtractionProvider,
} from './modules/ai-extraction/provider.js';
import { ExtractionDispatcher } from './modules/ai-extraction/messages.js';
import { SqsMessageQueue } from './modules/ai-extraction/message-queue.js';
import { QueueExtractionDispatcher } from './modules/ai-extraction/queue-dispatcher.js';
import { GeminiPrescriptionExtractionProvider, DEFAULT_GEMINI_MODEL } from './modules/ai-extraction/gemini-provider.js';
import { DocumentService } from './modules/documents/document-service.js';
import { ExtractionJobQueue } from './modules/ai-extraction/job-queue.js';
import { PrescriptionService } from './modules/prescriptions/prescription-service.js';
import {
  DocumentRepository,
  ExtractionJobRepository,
  PrescriptionRepository,
  UploadIntentRepository,
  PrismaDocumentRepository,
  PrismaExtractionJobRepository,
  PrismaPrescriptionRepository,
  PrismaUploadIntentRepository,
  InMemoryDocumentRepository,
  InMemoryExtractionJobRepository,
  InMemoryPrescriptionRepository,
  InMemoryUploadIntentRepository,
  TimelineRepository,
  PrismaTimelineRepository,
  InMemoryTimelineRepository,
  MedicationRepository,
  PrismaMedicationRepository,
  InMemoryMedicationRepository,
  PatientProfileRepository,
  PrismaPatientProfileRepository,
  InMemoryPatientProfileRepository,
} from './modules/persistence/repositories.js';
import { createDocumentRouter } from './modules/documents/routes.js';
import { createPrescriptionRouter } from './modules/prescriptions/routes.js';
import { TimelineService } from './modules/timeline/timeline-service.js';
import { createTimelineRouter } from './modules/timeline/routes.js';
import { MedicationService } from './modules/medications/medication-service.js';
import { createMedicationRouter } from './modules/medications/routes.js';
import { ReportService } from './modules/reports/report-service.js';
import { createReportRouter } from './modules/reports/routes.js';
import {
  AuthProviderAdapter,
  MockAuthProviderAdapter,
  DatabaseAuthProviderAdapter,
} from './modules/auth/auth-adapter.js';
import { createAuthRouter } from './modules/auth/routes.js';
import { getPrismaClient } from './modules/persistence/database.js';

export interface AppOptions {
  /** Overrides the env-derived app-status values (tests). */
  appStatus?: AppStatusConfig;
  authAdapter?: AuthProviderAdapter;
  storageProvider?: StorageProvider;
  extractionProvider?: PrescriptionExtractionProvider;
  /** When set (or EXTRACTION_MODE=sqs), extraction runs in the worker instead of inside a request. */
  extractionDispatcher?: ExtractionDispatcher;
  documentService?: DocumentService;
  jobQueue?: ExtractionJobQueue;
  prescriptionService?: PrescriptionService;
  timelineService?: TimelineService;
  medicationService?: MedicationService;
  reportService?: ReportService;
  docRepo?: DocumentRepository;
  jobRepo?: ExtractionJobRepository;
  prescriptionRepo?: PrescriptionRepository;
  uploadIntentRepo?: UploadIntentRepository;
  timelineRepo?: TimelineRepository;
  medicationRepo?: MedicationRepository;
  patientProfileRepo?: PatientProfileRepository;
  /** Phone sign-in (Phase 5). Tests pass a memory store and sender, or a whole service. */
  phoneAuthService?: PhoneAuthService;
  phoneAuthStore?: PhoneAuthStore;
  whatsappSender?: WhatsAppSender;
}

function whatsappSenderFromEnv(): WhatsAppSender {
  if (env.WHATSAPP_SENDER === 'meta') {
    return new MetaCloudWhatsAppSender({
      token: env.META_WHATSAPP_TOKEN ?? '',
      phoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID ?? '',
      templateName: env.META_WHATSAPP_TEMPLATE_NAME ?? '',
      templateLanguage: env.META_WHATSAPP_TEMPLATE_LANGUAGE,
      graphApiVersion: env.META_GRAPH_API_VERSION,
    });
  }
  return env.WHATSAPP_SENDER === 'memory' ? new MemoryWhatsAppSender() : new DisabledWhatsAppSender();
}

/**
 * CloudWatch embedded-metric line: a count and a metric name, nothing else (no number, code or name).
 * Written only in production, where the API's log group turns it into the metric the alarm watches.
 */
function emitOtpMetric(name: string, value: number): void {
  if (process.env.NODE_ENV !== 'production') return;
  process.stdout.write(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: 'Ayoreni/PhoneSignIn', Dimensions: [['Deployment']], Metrics: [{ Name: name, Unit: 'Count' }] }],
      },
      Deployment: env.DEPLOYMENT_ENV ?? 'prod',
      [name]: value,
    }) + '\n',
  );
}

export const createApp = (options?: AppOptions): Express => {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_URL === '*' ? true : env.CLIENT_URL,
      credentials: true,
    })
  );

  const inMemoryStores = process.env.NODE_ENV === 'test' && !process.env.TEST_USE_POSTGRES;
  const phoneAuth =
    options?.phoneAuthService ??
    new PhoneAuthService({
      store: options?.phoneAuthStore ?? (inMemoryStores ? new InMemoryPhoneAuthStore() : new PrismaPhoneAuthStore(getPrismaClient())),
      sender: options?.whatsappSender ?? whatsappSenderFromEnv(),
      hmacSecret: env.OTP_HMAC_SECRET,
      jwtSecret: env.JWT_SECRET,
      dailyCap: env.OTP_DAILY_CAP,
      fixedCode: env.OTP_FIXED_CODE,
      testNumbers: (env.OTP_TEST_NUMBERS ?? '').split(',').map((n) => n.trim()).filter(Boolean),
      metric: emitOtpMetric,
    });

  // Meta's delivery webhook reads the raw body (its signature covers the bytes), so it sits before the JSON parser.
  app.use(
    `${env.API_PREFIX}/webhooks/whatsapp`,
    createWhatsAppWebhookRouter(phoneAuth, { appSecret: env.META_APP_SECRET, verifyToken: env.META_WEBHOOK_VERIFY_TOKEN }),
  );

  // Security Rule: Production JSON requests only carry lightweight metadata (intents, review forms).
  // Heavy binary uploads use direct pre-signed storage URLs, eliminating 15MB+ JSON base64 payloads.
  app.use(express.json({ limit: '1mb' }));

  // Liveness & Readiness probe
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'myhealthapp-backend',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
      deployment: env.DEPLOYMENT_ENV,
    });
  });

  // Public and unauthenticated: no user data, only release/maintenance metadata.
  app.get(`${env.API_PREFIX}/app-status`, createAppStatusHandler(options?.appStatus ?? appStatusFromEnv(env)));

  const authAdapter =
    options?.authAdapter ??
    // Tests always default to the mock adapter so a developer's local AUTH_PROVIDER can never
    // route a test run into a real database.
    (env.AUTH_PROVIDER === 'node-internal' && process.env.NODE_ENV !== 'test'
      ? new DatabaseAuthProviderAdapter(getPrismaClient())
      : new MockAuthProviderAdapter());

  const authMiddleware = createAuthMiddleware(authAdapter, (token) => phoneAuth.verifyAccessToken(token));

  // Foundation endpoint: Authenticated Patient Profile (derived server-side)
  app.get(
    `${env.API_PREFIX}/patient/profile`,
    authMiddleware,
    (req: Request, res: Response) => {
      res.status(200).json({
        data: {
          patientProfileId: req.authContext!.patientProfileId,
          userId: req.authContext!.userId,
          email: req.authContext!.email,
          fullName: 'Test Patient',
          createdAt: new Date().toISOString(),
        },
      });
    }
  );

  // Cross-tenant verification endpoint for security tests
  app.get(
    `${env.API_PREFIX}/patient/:patientProfileId/records`,
    authMiddleware,
    requireOwnership('patientProfileId'),
    (req: Request, res: Response) => {
      res.status(200).json({
        data: {
          patientProfileId: req.authContext!.patientProfileId,
          records: [],
        },
      });
    }
  );

  // Repositories initialization (PostgreSQL Prisma default in prod/dev, In-Memory test double in unit test mode)
  const useInMemoryDb = process.env.NODE_ENV === 'test' && !process.env.TEST_USE_POSTGRES;
  const patientProfileRepo: PatientProfileRepository =
    options?.patientProfileRepo ??
    (useInMemoryDb ? new InMemoryPatientProfileRepository() : new PrismaPatientProfileRepository());
  const docRepo =
    options?.docRepo ??
    (useInMemoryDb ? new InMemoryDocumentRepository() : new PrismaDocumentRepository());

  const jobRepo =
    options?.jobRepo ??
    (useInMemoryDb ? new InMemoryExtractionJobRepository() : new PrismaExtractionJobRepository());

  const prescriptionRepo =
    options?.prescriptionRepo ??
    (useInMemoryDb
      ? new InMemoryPrescriptionRepository(jobRepo, docRepo)
      : new PrismaPrescriptionRepository());

  const uploadIntentRepo =
    options?.uploadIntentRepo ??
    (useInMemoryDb
      ? new InMemoryUploadIntentRepository()
      : new PrismaUploadIntentRepository());

  // Storage initialization: S3StorageProvider by default; MemoryStorageProvider only when explicitly configured
  const useMemoryStorage =
    options?.storageProvider ||
    (process.env.STORAGE_PROVIDER === 'memory' || (process.env.NODE_ENV === 'test' && !process.env.TEST_USE_MINIO));
  const storageProvider =
    options?.storageProvider ??
    (useMemoryStorage
      ? new MemoryStorageProvider(uploadIntentRepo)
      : new S3StorageProvider(uploadIntentRepo));


  const isTest = process.env.NODE_ENV === 'test';

  // Queue mode: the worker calls the provider, so the API holds no provider key and no model client.
  const extractionDispatcher =
    options?.extractionDispatcher ??
    (env.EXTRACTION_MODE === 'sqs' && env.EXTRACTION_JOBS_QUEUE_URL
      ? new QueueExtractionDispatcher(new SqsMessageQueue(env.EXTRACTION_JOBS_QUEUE_URL))
      : undefined);

  const geminiApiKey = process.env.GEMINI_API_KEY || (env as any).GEMINI_API_KEY;
  const extractionProvider =
    options?.extractionProvider ??
    (extractionDispatcher
      ? new QueuedExtractionProvider(`gemini-${process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL}`)
      : geminiApiKey && (!isTest || process.env.AI_EXTRACTION_PROVIDER === 'gemini') && (process.env.AI_EXTRACTION_PROVIDER === 'gemini' || process.env.AI_EXTRACTION_PROVIDER === 'auto' || !process.env.AI_EXTRACTION_PROVIDER)
        ? new GeminiPrescriptionExtractionProvider(geminiApiKey)
        : new MockPrescriptionExtractionProvider());

  const documentService =
    options?.documentService ?? new DocumentService(storageProvider, docRepo);

  const jobQueue =
    options?.jobQueue ??
    new ExtractionJobQueue(extractionProvider, documentService, jobRepo, {
      dispatcher: extractionDispatcher,
    });

  // Exposed so index.ts can attach the worker-result consumer without a second wiring path.
  app.locals.extractionJobQueue = jobQueue;

  const prescriptionService =
    options?.prescriptionService ?? new PrescriptionService(prescriptionRepo);

  const timelineRepo =
    options?.timelineRepo ??
    (useInMemoryDb
      ? new InMemoryTimelineRepository(
          prescriptionRepo as InMemoryPrescriptionRepository,
          docRepo as InMemoryDocumentRepository
        )
      : new PrismaTimelineRepository());

  const timelineService =
    options?.timelineService ?? new TimelineService(timelineRepo, documentService);

  const medicationRepo =
    options?.medicationRepo ??
    (useInMemoryDb
      ? new InMemoryMedicationRepository(
          prescriptionRepo as InMemoryPrescriptionRepository,
          docRepo as InMemoryDocumentRepository
        )
      : new PrismaMedicationRepository());

  if (useInMemoryDb && prescriptionRepo instanceof InMemoryPrescriptionRepository) {
    prescriptionRepo.setMedicationRepository(medicationRepo as InMemoryMedicationRepository);
  }

  const medicationService =
    options?.medicationService ?? new MedicationService(medicationRepo, documentService);

  app.use(`${env.API_PREFIX}/auth`, createPhoneAuthRouter(phoneAuth));
  app.use(`${env.API_PREFIX}/auth`, createPhoneAccountRouter(phoneAuth, authMiddleware));
  app.use(
    `${env.API_PREFIX}/auth`,
    createAuthRouter(authAdapter, authMiddleware, {
      purgePatientData: (patientProfileId) => documentService.purgeByPatientProfile(patientProfileId),
      patientProfileRepo,
      phoneAuth,
    })
  );

  // Module routers mounted under API_PREFIX
  app.use(
    `${env.API_PREFIX}/documents`,
    authMiddleware,
    requireCompletedAccount,
    createDocumentRouter(documentService)
  );

  app.use(
    `${env.API_PREFIX}/prescriptions`,
    authMiddleware,
    requireCompletedAccount,
    createPrescriptionRouter(jobQueue, prescriptionService)
  );

  app.use(
    `${env.API_PREFIX}/timeline`,
    authMiddleware,
    requireCompletedAccount,
    createTimelineRouter(timelineService)
  );

  app.use(
    `${env.API_PREFIX}/medications`,
    authMiddleware,
    requireCompletedAccount,
    createMedicationRouter(medicationService)
  );

  const reportService =
    options?.reportService ??
    new ReportService(
      timelineRepo,
      medicationRepo,
      documentService,
      patientProfileRepo
    );

  app.use(
    `${env.API_PREFIX}/reports`,
    authMiddleware,
    requireCompletedAccount,
    createReportRouter(reportService)
  );

  app.use(errorHandler);

  return app;
};
