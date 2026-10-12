import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthProviderAdapter } from './auth-adapter.js';

const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
  fullName: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export function createAuthRouter(
  authAdapter: AuthProviderAdapter,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void
): Router {
  const router = Router();

  // POST /auth/signup
  router.post('/signup', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.errors.map((e) => e.message).join(', '),
          },
        });
        return;
      }

      const { email, password, fullName } = parsed.data;
      const result = await authAdapter.signUpWithEmail(email, password, fullName);

      res.status(201).json({
        data: {
          user: {
            id: result.userId,
            email,
            patientProfileId: result.patientProfileId,
          },
          session: result.session,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      if (msg.includes('already registered')) {
        res.status(409).json({
          error: {
            code: 'EMAIL_ALREADY_EXISTS',
            message: 'An account with this email already exists',
          },
        });
        return;
      }
      next(err);
    }
  });

  // POST /auth/login
  router.post('/login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.errors.map((e) => e.message).join(', '),
          },
        });
        return;
      }

      const { email, password } = parsed.data;
      const session = await authAdapter.signInWithEmail(email, password);

      res.status(200).json({
        data: {
          user: {
            id: session.userId,
            email,
            patientProfileId: session.patientProfileId,
          },
          session,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      if (msg.includes('Invalid email or password') || msg.includes('not found')) {
        res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid email or password',
          },
        });
        return;
      }
      next(err);
    }
  });

  // GET /auth/me
  if (authMiddleware) {
    router.get('/me', authMiddleware, (req: Request, res: Response): void => {
      res.status(200).json({
        data: {
          userId: req.authContext!.userId,
          email: req.authContext!.email,
          patientProfileId: req.authContext!.patientProfileId,
        },
      });
    });
  }

  return router;
}
