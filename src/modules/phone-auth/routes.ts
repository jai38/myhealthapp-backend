import crypto from 'node:crypto';
import express, { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { fieldErrors } from '../../middleware/validation.js';
import { PHONE_AUTH_LIMITS as L } from './limits.js';
import type { PhoneAuthService, SignInResult } from './phone-auth-service.js';
import type { OtpDelivery } from './store.js';

const uuid = z.string().uuid();
const version = z.string().trim().min(1).max(40);

const RequestSchema = z.object({
  phone: z.string().max(32),
  installId: uuid,
  termsVersion: version,
});

const DeviceSchema = z.object({
  installId: uuid,
  name: z.string().trim().min(1).max(80),
  platform: z.enum(['ios', 'android', 'web', 'other']),
});

const VerifySchema = z.object({
  requestId: uuid,
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  device: DeviceSchema,
});

const SecondFactorSchema = z.object({
  secondFactorToken: z.string().min(1).max(200),
  recoveryCode: z.string().min(1).max(64),
});

export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'SELF_DESCRIBE', 'PREFER_NOT_TO_SAY'] as const;

const AccountSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Please enter your full name.').max(100),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be YYYY-MM-DD'),
    gender: z.enum(GENDERS),
    genderSelfDescription: z.string().trim().max(60).optional(),
    email: z.string().trim().email().max(254).optional(),
    healthDataConsentVersion: version,
  })
  .superRefine((v, ctx) => {
    if (v.gender === 'SELF_DESCRIBE' && !v.genderSelfDescription) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['genderSelfDescription'], message: 'Required when gender is SELF_DESCRIBE' });
    }
  });

function validationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: { code: 'VALIDATION_ERROR', message: 'Invalid request', fields: fieldErrors(error) },
  });
}

/**
 * The client's IP for per-IP limits. API Gateway appends the caller's address as the last
 * X-Forwarded-For entry, so earlier entries (which a client can send itself) are ignored.
 */
export function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const header = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  const last = header?.split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last || req.socket.remoteAddress || 'unknown';
}

function signInBody(result: SignInResult) {
  if (result.status === 'SIGNED_IN') {
    return {
      status: result.status,
      needsSecondFactor: false,
      isNewUser: result.isNewUser,
      profileComplete: result.profileComplete,
      accessToken: result.session.accessToken,
      refreshToken: result.session.refreshToken,
      expiresAt: result.session.expiresAt,
      deviceId: result.session.deviceId,
      ...(result.recoveryCodeUsed ? { recoveryCodeUsed: true } : {}),
    };
  }
  if (result.status === 'SECOND_FACTOR_REQUIRED') {
    return {
      status: result.status,
      needsSecondFactor: true,
      secondFactorToken: result.secondFactorToken,
      methods: result.methods,
      expiresInSeconds: result.expiresInSeconds,
      withoutCode: result.withoutCode,
    };
  }
  return { status: result.status, needsSecondFactor: false };
}

/** Public routes under /auth: request and verify a code, check delivery, complete the second factor. */
export function createPhoneAuthRouter(service: PhoneAuthService): Router {
  const router = Router();

  router.post('/otp/request', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RequestSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);

      const result = await service.requestCode({ ...parsed.data, ip: clientIp(req) });
      if (result.ok) {
        res.status(200).json({
          data: {
            requestId: result.requestId,
            codeLength: L.codeLength,
            expiresInSeconds: L.codeTtlSeconds,
            resendAfterSeconds: L.resendAfterSeconds,
            channel: 'WHATSAPP',
          },
        });
        return;
      }
      if (result.error === 'INVALID_PHONE') {
        res.status(400).json({ error: { code: 'INVALID_PHONE', message: 'Enter a 10-digit Indian mobile number' } });
        return;
      }
      if (result.error === 'OTP_UNAVAILABLE') {
        res.status(503).json({ error: { code: 'OTP_UNAVAILABLE', message: 'Sign-in codes are not available yet' } });
        return;
      }
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many codes. Try again later.',
          details: { reason: result.reason, retryAfterSeconds: result.retryAfterSeconds },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/otp/request/:requestId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = String(req.params.requestId ?? '');
      const delivery = uuid.safeParse(requestId).success ? await service.deliveryStatus(requestId) : null;
      if (!delivery) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Code request not found' } });
        return;
      }
      res.status(200).json({ data: { delivery } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/otp/verify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = VerifySchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);

      const outcome = await service.verifyCode(parsed.data);
      if (outcome.ok) {
        res.status(200).json({ data: signInBody(outcome.result) });
        return;
      }
      if (outcome.error === 'WRONG_CODE') {
        res.status(400).json({
          error: { code: 'WRONG_CODE', message: 'That code is not right', details: { attemptsLeft: outcome.attemptsLeft } },
        });
        return;
      }
      if (outcome.error === 'LOCKED') {
        res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
        res.status(429).json({
          error: { code: 'LOCKED', message: 'Too many wrong codes. Ask for a new one.', details: { retryAfterSeconds: outcome.retryAfterSeconds } },
        });
        return;
      }
      res.status(410).json({ error: { code: 'CODE_EXPIRED', message: 'This code has expired. Ask for a new one.' } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/second-factor', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SecondFactorSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);

      const outcome = await service.completeSecondFactor(parsed.data);
      if (outcome.ok) {
        res.status(200).json({ data: signInBody(outcome.result) });
        return;
      }
      if (outcome.error === 'WRONG_RECOVERY_CODE') {
        res.status(400).json({
          error: {
            code: 'WRONG_RECOVERY_CODE',
            message: 'That code doesn’t match',
            details: { attemptsLeft: outcome.attemptsLeft },
          },
        });
        return;
      }
      if (outcome.error === 'LOCKED') {
        res.status(429).json({ error: { code: 'LOCKED', message: 'Too many wrong recovery codes. Sign in again.' } });
        return;
      }
      res.status(410).json({ error: { code: 'CHALLENGE_EXPIRED', message: 'Sign in again' } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Routes under /auth that need a phone session: devices, recovery code, account (S03). */
export function createPhoneAccountRouter(
  service: PhoneAuthService,
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void,
): Router {
  const router = Router();

  const phoneOnly = (req: Request, res: Response, next: NextFunction): void => {
    if (req.authContext?.authMethod !== 'phone') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    next();
  };

  router.get('/devices', authMiddleware, phoneOnly, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = req.authContext!;
      res.status(200).json({ data: await service.listDevices(ctx.userId, ctx.deviceId!) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/devices/:deviceId', authMiddleware, phoneOnly, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deviceId = String(req.params.deviceId ?? '');
      if (!uuid.safeParse(deviceId).success) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'deviceId must be a UUID' } });
        return;
      }
      // Another user's device, or one already removed, is "not found" (rule 4).
      if (!(await service.revokeDevice(req.authContext!.userId, deviceId))) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
        return;
      }
      res.status(200).json({ data: { revoked: true } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/recovery-code', authMiddleware, phoneOnly, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = await service.createRecoveryCode(req.authContext!.userId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ data: { recoveryCode: code } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/account', authMiddleware, phoneOnly, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const summary = await service.accountSummary(req.authContext!.userId);
      if (!summary) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
        return;
      }
      const p = summary.profile;
      const placeholder = !summary.profileComplete;
      res.status(200).json({
        data: {
          phone: summary.phone,
          profileComplete: summary.profileComplete,
          hasRecoveryCode: summary.hasRecoveryCode,
          ...(p && !placeholder
            ? {
                fullName: p.fullName,
                dateOfBirth: p.dateOfBirth,
                gender: p.gender,
                ...(p.genderSelfDescription ? { genderSelfDescription: p.genderSelfDescription } : {}),
                ...(p.contactEmail ? { email: p.contactEmail } : {}),
              }
            : {}),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/account', authMiddleware, phoneOnly, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = AccountSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const outcome = await service.completeAccount(req.authContext!.userId, parsed.data);
      if (!outcome.ok && outcome.error === 'UNDER_18') {
        res.status(422).json({ error: { code: 'UNDER_18', message: 'You need to be 18 or older to create an account' } });
        return;
      }
      if (!outcome.ok) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid date of birth',
            fields: [{ path: 'dateOfBirth', message: 'Not a real date, or in the future' }],
          },
        });
        return;
      }
      res.status(200).json({ data: { profileComplete: true } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Meta's webhook for message statuses. Mounted before the JSON parser: the signature covers the raw
 * bytes. GET is Meta's one-time verification; POST carries statuses, signed with the app secret.
 */
export function createWhatsAppWebhookRouter(
  service: PhoneAuthService,
  config: { appSecret?: string; verifyToken?: string },
): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (
      mode === 'subscribe' &&
      typeof token === 'string' &&
      config.verifyToken &&
      safeEqual(token, config.verifyToken) &&
      typeof challenge === 'string' &&
      /^[\w-]{1,200}$/.test(challenge)
    ) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Verification failed' } });
  });

  router.post('/', express.raw({ type: '*/*', limit: '256kb' }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const signature = req.headers['x-hub-signature-256'];
      if (!config.appSecret || typeof signature !== 'string' || !validSignature(raw, signature, config.appSecret)) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Bad signature' } });
        return;
      }
      let payload: any;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON' } });
        return;
      }
      for (const status of extractStatuses(payload)) {
        await service.recordDelivery(status.id, status.delivery);
      }
      // Meta retries anything but 200; unknown message ids are ignored.
      res.status(200).json({ data: { received: true } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function validSignature(raw: Buffer, header: string, appSecret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
  return safeEqual(header, expected);
}

/** Message statuses in a Meta webhook payload, mapped to our delivery states. */
export function extractStatuses(payload: any): Array<{ id: string; delivery: OtpDelivery }> {
  const out: Array<{ id: string; delivery: OtpDelivery }> = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      for (const s of Array.isArray(change?.value?.statuses) ? change.value.statuses : []) {
        if (typeof s?.id !== 'string') continue;
        let delivery: OtpDelivery | null = null;
        if (s.status === 'sent') delivery = 'SENT';
        else if (s.status === 'delivered' || s.status === 'read') delivery = 'DELIVERED';
        else if (s.status === 'failed') {
          const codes = (Array.isArray(s.errors) ? s.errors : []).map((e: any) => e?.code);
          delivery = codes.includes(131026) ? 'WHATSAPP_UNAVAILABLE' : 'FAILED';
        }
        if (delivery) out.push({ id: s.id, delivery });
      }
    }
  }
  return out;
}
