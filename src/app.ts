import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { createAuthMiddleware, requireOwnership } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';

export const createApp = (): Express => {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
    })
  );
  app.use(express.json());

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

  app.use(errorHandler);

  return app;
};
