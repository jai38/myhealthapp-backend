import { Request, Response, NextFunction } from 'express';
import { AuthProviderAdapter, MockAuthProviderAdapter } from '../modules/auth/auth-adapter.js';

export interface AuthenticatedContext {
  userId: string;
  email: string;
  patientProfileId: string;
}

declare global {
  namespace Express {
    interface Request {
      authContext?: AuthenticatedContext;
    }
  }
}

// In-memory or database-backed resolver mapping userId -> patientProfileId
const patientProfileResolver = async (userId: string): Promise<string> => {
  try {
    const { getPrismaClient } = await import('../modules/persistence/database.js');
    const client = getPrismaClient();
    const profile = await client.patientProfile.findUnique({ where: { userId } });
    if (profile) return profile.id;
  } catch {
    // In-memory / mock test fallback
  }
  return `pat_${userId}`;
};

export const createAuthMiddleware = (authAdapter: AuthProviderAdapter = new MockAuthProviderAdapter()) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or malformed Authorization header',
        },
      });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const verified = await authAdapter.verifySessionToken(token);
      const patientProfileId = verified.patientProfileId || await patientProfileResolver(verified.userId);

      // Invariant: Derive patientProfileId exclusively from verified session, never client headers
      req.authContext = {
        userId: verified.userId,
        email: verified.email,
        patientProfileId,
      };

      next();
    } catch {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired session token',
        },
      });
      return;
    }
  };
};

export const requireOwnership = (paramKey: string = 'patientProfileId') => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authContext) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      return;
    }

    const requestedId = req.params[paramKey] || req.query[paramKey] || req.body[paramKey];

    // If an explicit ID is requested, it MUST strictly match the authenticated patientProfileId
    if (requestedId && requestedId !== req.authContext.patientProfileId) {
      // Return 404 to prevent ID enumeration
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
        },
      });
      return;
    }

    next();
  };
};
