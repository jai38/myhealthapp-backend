import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthError, AuthProviderAdapter } from './auth-adapter.js';

// bcrypt only uses the first 72 bytes, so longer passwords would be silently truncated.
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters long')
  .max(72, 'Password must be at most 72 characters long');

const signupSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
  password: passwordSchema,
  fullName: z.string().max(200).optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
  password: z.string().min(1, 'Password is required').max(1024),
});

const emailOnlySchema = z.object({
  email: z.string().email('Invalid email address').max(254),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required').max(512),
  password: passwordSchema,
});

const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required').max(512),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required').max(512),
});

export interface AuthRouterOptions {
  /**
   * Deletes every stored document object and document row for the patient profile.
   * Called by DELETE /auth/account before the user row is removed.
   */
  purgePatientData?: (patientProfileId: string) => Promise<unknown>;
}

function validationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: error.errors.map((e) => e.message).join(', '),
    },
  });
}

export function createAuthRouter(
  authAdapter: AuthProviderAdapter,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
  options: AuthRouterOptions = {},
): Router {
  const router = Router();

  // POST /auth/signup
  // The response is identical whether or not the email is already registered.
  router.post('/signup', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error);
        return;
      }

      const { email, password, fullName } = parsed.data;
      const result = await authAdapter.signUpWithEmail(email, password, fullName);

      const user: Record<string, unknown> = { email };
      if (result.session) {
        user.id = result.userId;
        user.patientProfileId = result.patientProfileId;
      }

      res.status(201).json({
        data: {
          user,
          ...(result.session ? { session: result.session } : {}),
          requiresVerification: result.requiresVerification,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/login
  router.post('/login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error);
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
      if (err instanceof AuthError && err.code === 'INVALID_CREDENTIALS') {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' },
        });
        return;
      }
      if (err instanceof AuthError && err.code === 'EMAIL_NOT_VERIFIED') {
        res.status(403).json({
          error: {
            code: 'EMAIL_NOT_VERIFIED',
            message: 'Please verify your email address before logging in. Check your inbox for the verification link.',
          },
        });
        return;
      }
      next(err);
    }
  });

  // POST /auth/refresh - rotates the refresh token; a reused token ends the whole session family
  router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = refreshSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error);
        return;
      }

      const session = await authAdapter.refreshToken(parsed.data.refreshToken);
      res.status(200).json({ data: { session } });
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' },
        });
        return;
      }
      next(err);
    }
  });

  // POST /auth/logout - revokes the refresh-token family; always succeeds
  router.post('/logout', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = refreshSchema.safeParse(req.body);
      if (parsed.success) {
        await authAdapter.signOut(parsed.data.refreshToken);
      }
      res.status(200).json({ data: { message: 'Signed out.' } });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/request-password-reset
  router.post('/request-password-reset', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = emailOnlySchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error);
        return;
      }

      await authAdapter.requestPasswordReset(parsed.data.email);

      // Same reply whether or not the account exists.
      res.status(200).json({
        data: { message: 'If an account exists with this email, a password reset link has been sent.' },
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/reset-password
  router.post('/reset-password', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error);
        return;
      }

      await authAdapter.resetPassword(parsed.data.token, parsed.data.password);

      res.status(200).json({
        data: { message: 'Password has been reset successfully. You can now log in with your new password.' },
      });
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        res.status(400).json({
          error: {
            code: 'INVALID_TOKEN',
            message: 'The reset token is invalid or has expired. Please request a new password reset.',
          },
        });
        return;
      }
      next(err);
    }
  });

  // POST /auth/verify-email
  router.post('/verify-email', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = verifyEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error);
        return;
      }

      const verified = await authAdapter.verifyEmail(parsed.data.token);

      if (!verified) {
        res.status(400).json({
          error: {
            code: 'INVALID_TOKEN',
            message: 'The verification token is invalid or has expired. Request a new verification email.',
          },
        });
        return;
      }

      res.status(200).json({
        data: { message: 'Email verified successfully. You can now log in.' },
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /auth/resend-verification - same reply whether or not the account exists or is already verified
  router.post('/resend-verification', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = emailOnlySchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error);
        return;
      }

      await authAdapter.resendVerification(parsed.data.email);

      res.status(200).json({
        data: { message: 'If the account exists and is not yet verified, a new verification link has been sent.' },
      });
    } catch (err) {
      next(err);
    }
  });

  if (authMiddleware) {
    // GET /auth/me
    router.get('/me', authMiddleware, (req: Request, res: Response): void => {
      res.status(200).json({
        data: {
          userId: req.authContext!.userId,
          email: req.authContext!.email,
          patientProfileId: req.authContext!.patientProfileId,
        },
      });
    });

    // DELETE /auth/account - erases the caller's account and all of their data.
    // Identity comes only from the verified token; the request carries no identifiers.
    router.delete('/account', authMiddleware, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { userId, patientProfileId } = req.authContext!;

        // Storage objects and document rows first. If this fails, nothing else is deleted and the
        // caller can retry. The DB delete then cascades every remaining patient-owned row.
        if (options.purgePatientData) {
          await options.purgePatientData(patientProfileId);
        }
        await authAdapter.deleteAccount(userId);

        res.status(200).json({
          data: { message: 'Account and all associated data have been permanently deleted.' },
        });
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}
