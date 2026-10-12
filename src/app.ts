import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { createAuthMiddleware, requireOwnership } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { StorageProvider, MemoryStorageProvider } from './modules/storage/storage-provider.js';
import {
  PrescriptionExtractionProvider,
  MockPrescriptionExtractionProvider,
} from './modules/ai-extraction/provider.js';
import { DocumentService } from './modules/documents/document-service.js';
import { ExtractionJobQueue } from './modules/ai-extraction/job-queue.js';
import { PrescriptionService } from './modules/prescriptions/prescription-service.js';
import { createDocumentRouter } from './modules/documents/routes.js';
import { createPrescriptionRouter } from './modules/prescriptions/routes.js';

export interface AppOptions {
  storageProvider?: StorageProvider;
  extractionProvider?: PrescriptionExtractionProvider;
  documentService?: DocumentService;
  jobQueue?: ExtractionJobQueue;
  prescriptionService?: PrescriptionService;
}

export const createApp = (options?: AppOptions): Express => {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '20mb' }));

  // Liveness & Readiness probe
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'myhealthapp-backend',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
    });
  });

  const authMiddleware = createAuthMiddleware();

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

  // Services initialization (supports injection for deterministic testing)
  const storageProvider = options?.storageProvider ?? new MemoryStorageProvider();
  const extractionProvider =
    options?.extractionProvider ?? new MockPrescriptionExtractionProvider();
  const documentService =
    options?.documentService ?? new DocumentService(storageProvider);
  const jobQueue =
    options?.jobQueue ?? new ExtractionJobQueue(extractionProvider, documentService);
  const prescriptionService =
    options?.prescriptionService ?? new PrescriptionService(documentService, jobQueue);

  // Module routers mounted under API_PREFIX
  app.use(
    `${env.API_PREFIX}/documents`,
    authMiddleware,
    createDocumentRouter(documentService)
  );

  app.use(
    `${env.API_PREFIX}/prescriptions`,
    authMiddleware,
    createPrescriptionRouter(jobQueue, prescriptionService)
  );

  app.use(errorHandler);

  return app;
};
