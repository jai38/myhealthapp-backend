import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PHONE_AUTH_LIMITS as L } from './limits.js';
import { normalizeIndianMobile } from './phone.js';
import {
  KeyedHasher,
  generateOtpCode,
  generateRecoveryCode,
  normalizeRecoveryCode,
  randomToken,
  sha256Hex,
} from './keyed-hash.js';
import type { PhoneAuthStore, OtpDelivery, PhoneUserRow, DeviceRow } from './store.js';
import { WhatsAppSendError, type WhatsAppSender } from './whatsapp-sender.js';

/**
 * Phone sign-in with WhatsApp codes (Phase 5 tasks 7-9).
 *
 * Rules kept here:
 * - Codes: 6 digits from a CSPRNG, stored only as HMAC-SHA256, compared in constant time, single use,
 *   10 minutes, a new code cancels the old one, 3 wrong attempts lock the code.
 * - Limits are keyed by hashes of the number, install id and IP, never the values.
 * - The code request never looks the number up, so it answers the same for known and unknown numbers.
 * - New device (P2): recovery code if the account has one; otherwise, after 90 days unused, no session
 *   until support confirms the person.
 * - Nothing here logs. The only output is a count metric with no number, code or name in it.
 */

export type DevicePlatform = 'ios' | 'android' | 'web' | 'other';

export interface DeviceInfo {
  installId: string;
  name: string;
  platform: DevicePlatform;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  deviceId: string;
}

export type RequestCodeResult =
  | { ok: true; requestId: string }
  | { ok: false; error: 'INVALID_PHONE' }
  | { ok: false; error: 'OTP_UNAVAILABLE' }
  | { ok: false; error: 'RATE_LIMITED'; reason: 'RESEND_TOO_SOON' | 'TOO_MANY_CODES' | 'DAILY_LIMIT'; retryAfterSeconds: number };

export type SignInResult =
  | { status: 'SIGNED_IN'; isNewUser: boolean; profileComplete: boolean; session: SessionTokens; recoveryCodeUsed?: boolean }
  | {
      status: 'SECOND_FACTOR_REQUIRED';
      secondFactorToken: string;
      methods: Array<'RECOVERY_CODE'>;
      expiresInSeconds: number;
      /** What "I don't have my code" leads to (A02 → A03). */
      withoutCode: 'RECORDS_HIDDEN' | 'CONTACT_SUPPORT';
    }
  | { status: 'SUPPORT_REQUIRED' };

export type VerifyCodeResult =
  | { ok: true; result: SignInResult }
  | { ok: false; error: 'CODE_EXPIRED' }
  | { ok: false; error: 'WRONG_CODE'; attemptsLeft: number }
  | { ok: false; error: 'LOCKED'; retryAfterSeconds: number };

export type SecondFactorResult =
  | { ok: true; result: SignInResult }
  | { ok: false; error: 'CHALLENGE_EXPIRED' }
  | { ok: false; error: 'WRONG_RECOVERY_CODE'; attemptsLeft: number }
  | { ok: false; error: 'LOCKED' };

export interface VerifiedPhoneToken {
  userId: string;
  patientProfileId: string;
  deviceId: string;
  profileComplete: boolean;
}

export interface PhoneAuthOptions {
  store: PhoneAuthStore;
  sender: WhatsAppSender;
  hmacSecret: string;
  jwtSecret: string;
  dailyCap: number;
  /** Local/test only (validateProductionConfig refuses both in production). */
  fixedCode?: string;
  testNumbers?: string[];
  /** Counts only, never a number, code or name. Defaults to nothing. */
  metric?: (name: 'OtpCodesSent' | 'OtpDailyCapReached' | 'OtpSendFailed', value: number) => void;
  clock?: () => Date;
}

export class PhoneAuthService {
  private readonly hasher: KeyedHasher;
  private readonly now: () => Date;
  private readonly metric: NonNullable<PhoneAuthOptions['metric']>;

  constructor(private readonly opts: PhoneAuthOptions) {
    this.hasher = new KeyedHasher(opts.hmacSecret);
    this.now = opts.clock ?? (() => new Date());
    this.metric = opts.metric ?? (() => undefined);
  }

  get enabled(): boolean {
    return this.opts.sender.enabled;
  }

  // -------------------------------------------------------------------------
  // POST /auth/otp/request
  // -------------------------------------------------------------------------

  async requestCode(input: { phone: unknown; installId: string; ip: string; termsVersion: string }): Promise<RequestCodeResult> {
    const phoneE164 = normalizeIndianMobile(input.phone);
    if (!phoneE164) return { ok: false, error: 'INVALID_PHONE' };
    if (!this.opts.sender.enabled) return { ok: false, error: 'OTP_UNAVAILABLE' };

    const now = this.now();
    const { store } = this.opts;
    await store.purgeOtpRequestsBefore(new Date(now.getTime() - L.requestRetentionSeconds * 1000));

    const phoneHmac = this.hasher.hash('phone', phoneE164);
    const installIdHmac = this.hasher.hash('install', input.installId);
    const ipHmac = this.hasher.hash('ip', input.ip);

    const limited = await this.checkRequestLimits(phoneHmac, installIdHmac, ipHmac, now);
    if (limited) return limited;

    const isTestNumber = Boolean(this.opts.fixedCode) && (this.opts.testNumbers ?? []).includes(phoneE164);
    const code = isTestNumber ? this.opts.fixedCode! : generateOtpCode(L.codeLength);

    await store.cancelOpenOtpRequests(phoneHmac, now);
    const row = await store.createOtpRequest(
      {
        phoneHmac,
        phoneE164,
        codeHmac: this.hasher.hash('code', code),
        installIdHmac,
        ipHmac,
        termsVersion: input.termsVersion,
        expiresAt: new Date(now.getTime() + L.codeTtlSeconds * 1000),
      },
      now,
    );

    if (isTestNumber) {
      await store.setDelivery(row.id, 'SENT');
    } else {
      try {
        const sent = await this.opts.sender.sendCode(phoneE164, code);
        await store.setDelivery(row.id, 'SENT', sent.providerMessageId);
        this.metric('OtpCodesSent', 1);
      } catch (err) {
        // The reply stays the same; the app learns the outcome from the status call.
        const delivery: OtpDelivery = err instanceof WhatsAppSendError && err.kind === 'UNAVAILABLE' ? 'WHATSAPP_UNAVAILABLE' : 'FAILED';
        await store.setDelivery(row.id, delivery);
        this.metric('OtpSendFailed', 1);
      }
    }

    return { ok: true, requestId: row.id };
  }

  private async checkRequestLimits(
    phoneHmac: string,
    installIdHmac: string,
    ipHmac: string,
    now: Date,
  ): Promise<RequestCodeResult | null> {
    const { store } = this.opts;
    const t = now.getTime();

    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    if ((await store.countOtpRequests('all', dayStart)) >= this.opts.dailyCap) {
      this.metric('OtpDailyCapReached', 1);
      const nextDay = dayStart.getTime() + 24 * 60 * 60 * 1000;
      return { ok: false, error: 'RATE_LIMITED', reason: 'DAILY_LIMIT', retryAfterSeconds: Math.ceil((nextDay - t) / 1000) };
    }

    const times = await store.otpRequestTimes(phoneHmac, new Date(t - L.numberWindowSeconds * 1000 + 1));
    const last = times[times.length - 1];
    if (last && t - last.getTime() < L.resendAfterSeconds * 1000) {
      return {
        ok: false,
        error: 'RATE_LIMITED',
        reason: 'RESEND_TOO_SOON',
        retryAfterSeconds: Math.ceil((last.getTime() + L.resendAfterSeconds * 1000 - t) / 1000),
      };
    }
    if (times.length >= L.maxCodesPerNumber) {
      const freesAt = times[times.length - L.maxCodesPerNumber]!.getTime() + L.numberWindowSeconds * 1000;
      return { ok: false, error: 'RATE_LIMITED', reason: 'TOO_MANY_CODES', retryAfterSeconds: Math.max(1, Math.ceil((freesAt - t) / 1000)) };
    }

    // Windows exclude their far edge: a request exactly a window old no longer counts.
    const hourAgo = new Date(t - 60 * 60 * 1000 + 1);
    if (
      (await store.countOtpRequests({ installIdHmac }, hourAgo)) >= L.maxCodesPerInstallPerHour ||
      (await store.countOtpRequests({ ipHmac }, hourAgo)) >= L.maxCodesPerIpPerHour
    ) {
      return { ok: false, error: 'RATE_LIMITED', reason: 'TOO_MANY_CODES', retryAfterSeconds: 60 * 60 };
    }
    return null;
  }

  /** Seconds until this number may ask for a new code (0 when it can now). */
  private async secondsUntilNextCode(phoneHmac: string, now: Date): Promise<number> {
    const t = now.getTime();
    const times = await this.opts.store.otpRequestTimes(phoneHmac, new Date(t - L.numberWindowSeconds * 1000 + 1));
    let wait = 0;
    const last = times[times.length - 1];
    if (last) wait = Math.max(wait, last.getTime() + L.resendAfterSeconds * 1000 - t);
    if (times.length >= L.maxCodesPerNumber) {
      wait = Math.max(wait, times[times.length - L.maxCodesPerNumber]!.getTime() + L.numberWindowSeconds * 1000 - t);
    }
    return Math.max(0, Math.ceil(wait / 1000));
  }

  // -------------------------------------------------------------------------
  // GET /auth/otp/request/:requestId and the delivery webhook
  // -------------------------------------------------------------------------

  async deliveryStatus(requestId: string): Promise<OtpDelivery | null> {
    const row = await this.opts.store.getOtpRequest(requestId);
    return row ? row.delivery : null;
  }

  async recordDelivery(providerMessageId: string, delivery: OtpDelivery): Promise<void> {
    await this.opts.store.setDeliveryByProviderId(providerMessageId, delivery);
  }

  // -------------------------------------------------------------------------
  // POST /auth/otp/verify
  // -------------------------------------------------------------------------

  async verifyCode(input: { requestId: string; code: string; device: DeviceInfo }): Promise<VerifyCodeResult> {
    const { store } = this.opts;
    const now = this.now();
    const row = await store.getOtpRequest(input.requestId);
    if (!row || row.consumedAt || row.cancelledAt || row.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, error: 'CODE_EXPIRED' };
    }
    if (row.wrongAttempts >= L.maxWrongAttemptsPerCode) {
      return { ok: false, error: 'LOCKED', retryAfterSeconds: await this.secondsUntilNextCode(row.phoneHmac, now) };
    }

    if (!this.hasher.matches('code', input.code, row.codeHmac)) {
      const attempts = await store.addWrongAttempt(row.id);
      if (attempts === null) return { ok: false, error: 'CODE_EXPIRED' };
      if (attempts >= L.maxWrongAttemptsPerCode) {
        return { ok: false, error: 'LOCKED', retryAfterSeconds: await this.secondsUntilNextCode(row.phoneHmac, now) };
      }
      return { ok: false, error: 'WRONG_CODE', attemptsLeft: L.maxWrongAttemptsPerCode - attempts };
    }

    if (!(await store.consumeOtpRequest(row.id, now))) return { ok: false, error: 'CODE_EXPIRED' };

    const installIdHmac = this.hasher.hash('install', input.device.installId);
    const { user, created } = await store.createPhoneUser(row.phoneE164, now);

    // Terms were accepted on S01, before the code was sent. Record each new version once.
    const terms = await store.latestConsent(user.id, 'TERMS');
    if (!terms || terms.version !== row.termsVersion) await store.addConsent(user.id, 'TERMS', row.termsVersion, now);

    if (created) {
      await store.audit(user.id, 'USER_SIGNED_UP', 'USER', user.id);
      return { ok: true, result: await this.signIn(user, installIdHmac, input.device, { isNewUser: true, now }) };
    }

    const known = await store.findActiveDevice(user.id, installIdHmac);
    if (known) {
      return { ok: true, result: await this.signIn(user, installIdHmac, input.device, { isNewUser: false, now, device: known }) };
    }

    // A new device for an existing account (P2).
    const inactive = this.isInactive(user, now);
    if (user.recoveryCodeHmac) {
      const token = randomToken();
      await store.createChallenge({
        userId: user.id,
        tokenHash: sha256Hex(token),
        installIdHmac,
        deviceName: input.device.name,
        devicePlatform: input.device.platform,
        expiresAt: new Date(now.getTime() + L.secondFactorTtlSeconds * 1000),
      });
      await store.audit(user.id, 'NEW_DEVICE_SECOND_FACTOR_REQUIRED', 'USER', user.id);
      return {
        ok: true,
        result: {
          status: 'SECOND_FACTOR_REQUIRED',
          secondFactorToken: token,
          methods: ['RECOVERY_CODE'],
          expiresInSeconds: L.secondFactorTtlSeconds,
          withoutCode: inactive ? 'RECORDS_HIDDEN' : 'CONTACT_SUPPORT',
        },
      };
    }
    if (inactive) {
      await store.audit(user.id, 'NEW_DEVICE_SUPPORT_HOLD', 'USER', user.id);
      return { ok: true, result: { status: 'SUPPORT_REQUIRED' } };
    }
    return { ok: true, result: await this.signIn(user, installIdHmac, input.device, { isNewUser: false, now }) };
  }

  private isInactive(user: PhoneUserRow, now: Date): boolean {
    const lastUse = (user.lastActiveAt ?? user.createdAt).getTime();
    return now.getTime() - lastUse >= L.inactiveDaysBeforeSupportHold * 24 * 60 * 60 * 1000;
  }

  // -------------------------------------------------------------------------
  // POST /auth/second-factor
  // -------------------------------------------------------------------------

  async completeSecondFactor(input: { secondFactorToken: string; recoveryCode: string }): Promise<SecondFactorResult> {
    const { store } = this.opts;
    const now = this.now();
    const challenge = await store.findChallenge(sha256Hex(input.secondFactorToken));
    if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, error: 'CHALLENGE_EXPIRED' };
    }
    if (challenge.wrongAttempts >= L.maxSecondFactorAttempts) return { ok: false, error: 'LOCKED' };

    const user = await store.getUser(challenge.userId);
    if (!user) return { ok: false, error: 'CHALLENGE_EXPIRED' };

    const normalized = normalizeRecoveryCode(input.recoveryCode);
    const matches = Boolean(normalized && user.recoveryCodeHmac && this.hasher.matches('recovery', normalized, user.recoveryCodeHmac));
    if (!matches) {
      const attempts = await store.addChallengeWrongAttempt(challenge.id);
      if (attempts === null) return { ok: false, error: 'CHALLENGE_EXPIRED' };
      if (attempts >= L.maxSecondFactorAttempts) {
        await store.audit(user.id, 'SECOND_FACTOR_LOCKED', 'USER', user.id);
        return { ok: false, error: 'LOCKED' };
      }
      return { ok: false, error: 'WRONG_RECOVERY_CODE', attemptsLeft: L.maxSecondFactorAttempts - attempts };
    }

    if (!(await store.consumeChallenge(challenge.id, now))) return { ok: false, error: 'CHALLENGE_EXPIRED' };
    // A recovery code works once; the app asks the patient to make a new one (A02).
    if (!(await store.consumeRecoveryCode(user.id, user.recoveryCodeHmac!))) return { ok: false, error: 'CHALLENGE_EXPIRED' };
    await store.audit(user.id, 'RECOVERY_CODE_USED', 'USER', user.id);

    const result = await this.signIn(
      user,
      challenge.installIdHmac,
      { installId: '', name: challenge.deviceName, platform: challenge.devicePlatform as DevicePlatform },
      { isNewUser: false, now },
    );
    return { ok: true, result: { ...result, recoveryCodeUsed: true } as SignInResult };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  private async signIn(
    user: PhoneUserRow,
    installIdHmac: string,
    device: DeviceInfo,
    ctx: { isNewUser: boolean; now: Date; device?: DeviceRow },
  ): Promise<SignInResult> {
    const { store } = this.opts;
    const deviceRow =
      ctx.device ?? (await store.createDevice({ userId: user.id, installIdHmac, name: device.name, platform: device.platform }, ctx.now));
    if (ctx.device) await store.touchDevice(deviceRow.id, ctx.now);
    if (!ctx.device) await store.audit(user.id, 'DEVICE_ADDED', 'DEVICE', deviceRow.id);
    await store.touchUser(user.id, ctx.now);
    await store.audit(user.id, 'LOGIN', 'USER', user.id);

    const session = await this.issueSession(user, deviceRow.id, crypto.randomUUID(), ctx.now);
    return { status: 'SIGNED_IN', isNewUser: ctx.isNewUser, profileComplete: user.profileCompletedAt !== null, session };
  }

  private async issueSession(user: { id: string; patientProfileId: string }, deviceId: string, familyId: string, now: Date): Promise<SessionTokens> {
    const accessToken = jwt.sign(
      { typ: 'phone', userId: user.id, patientProfileId: user.patientProfileId, did: deviceId },
      this.opts.jwtSecret,
      { algorithm: 'HS256', expiresIn: L.accessTokenTtlSeconds },
    );
    const refreshToken = randomToken();
    await this.opts.store.createRefreshToken({
      userId: user.id,
      deviceId,
      familyId,
      tokenHash: sha256Hex(refreshToken),
      expiresAt: new Date(now.getTime() + L.refreshTokenTtlSeconds * 1000),
    });
    return { accessToken, refreshToken, expiresAt: now.getTime() + L.accessTokenTtlSeconds * 1000, deviceId };
  }

  /**
   * Rotates a phone-session refresh token. Returns null when the token isn't a phone session (the
   * email adapter handles it). A token that was already rotated revokes its whole family.
   */
  async refresh(
    refreshToken: string,
  ): Promise<{ ok: true; session: SessionTokens & { userId: string; patientProfileId: string } } | { ok: false } | null> {
    if (!refreshToken) return null;
    const { store } = this.opts;
    const now = this.now();
    const record = await store.findRefreshToken(sha256Hex(refreshToken));
    if (!record || !record.deviceId) return null;

    if (record.revokedAt) {
      await store.revokeFamily(record.familyId, now);
      await store.audit(record.userId, 'REFRESH_TOKEN_REUSE_DETECTED', 'USER', record.userId);
      return { ok: false };
    }
    if (record.expiresAt.getTime() <= now.getTime()) return { ok: false };
    if (!(await store.claimRefreshToken(record.id, now))) {
      await store.revokeFamily(record.familyId, now);
      return { ok: false };
    }

    const [user, device] = await Promise.all([store.getUser(record.userId), store.getDevice(record.deviceId)]);
    if (!user || !device || device.revokedAt || device.userId !== user.id) {
      await store.revokeFamily(record.familyId, now);
      return { ok: false };
    }
    await store.touchDevice(device.id, now);
    await store.touchUser(user.id, now);
    const session = await this.issueSession(user, device.id, record.familyId, now);
    return { ok: true, session: { ...session, userId: user.id, patientProfileId: user.patientProfileId } };
  }

  /** True when the token was a phone session and is now revoked. */
  async signOut(refreshToken: string): Promise<boolean> {
    if (!refreshToken) return false;
    const record = await this.opts.store.findRefreshToken(sha256Hex(refreshToken));
    if (!record || !record.deviceId) return false;
    await this.opts.store.revokeFamily(record.familyId, this.now());
    return true;
  }

  /**
   * Checks a phone-session access token. Returns null for tokens that aren't phone sessions (left to
   * the other verifier); throws for a phone token that is invalid, expired or from a revoked device.
   */
  async verifyAccessToken(token: string): Promise<VerifiedPhoneToken | null> {
    let decoded: { typ?: string; userId?: string; patientProfileId?: string; did?: string };
    try {
      decoded = jwt.verify(token, this.opts.jwtSecret, { algorithms: ['HS256'] }) as typeof decoded;
    } catch (err) {
      // An expired phone token must not fall through to another verifier.
      if (err instanceof jwt.TokenExpiredError) {
        const peek = jwt.decode(token) as { typ?: string } | null;
        if (peek?.typ === 'phone') throw new Error('Invalid or expired session token');
      }
      return null;
    }
    if (decoded.typ !== 'phone') return null;
    if (!decoded.userId || !decoded.patientProfileId || !decoded.did) throw new Error('Invalid or expired session token');

    const [user, device] = await Promise.all([this.opts.store.getUser(decoded.userId), this.opts.store.getDevice(decoded.did)]);
    if (!user || !device || device.revokedAt || device.userId !== user.id || user.patientProfileId !== decoded.patientProfileId) {
      throw new Error('Invalid or expired session token');
    }
    return { userId: user.id, patientProfileId: user.patientProfileId, deviceId: device.id, profileComplete: user.profileCompletedAt !== null };
  }

  // -------------------------------------------------------------------------
  // Devices, recovery code, account (authenticated phone sessions)
  // -------------------------------------------------------------------------

  async listDevices(userId: string, currentDeviceId: string) {
    const devices = await this.opts.store.listActiveDevices(userId);
    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      createdAt: d.createdAt.toISOString(),
      lastSeenAt: d.lastSeenAt.toISOString(),
      current: d.id === currentDeviceId,
    }));
  }

  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    const done = await this.opts.store.revokeDevice(userId, deviceId, this.now());
    if (done) await this.opts.store.audit(userId, 'DEVICE_REVOKED', 'DEVICE', deviceId);
    return done;
  }

  /** Makes a new recovery code (replacing any old one) and returns it once. */
  async createRecoveryCode(userId: string): Promise<string> {
    const code = generateRecoveryCode();
    await this.opts.store.setRecoveryCode(userId, this.hasher.hash('recovery', normalizeRecoveryCode(code)!), this.now());
    await this.opts.store.audit(userId, 'RECOVERY_CODE_CREATED', 'USER', userId);
    return code;
  }

  async accountSummary(userId: string) {
    const [user, profile] = await Promise.all([this.opts.store.getUser(userId), this.opts.store.getProfile(userId)]);
    if (!user) return null;
    return {
      phone: user.phoneE164,
      hasRecoveryCode: user.recoveryCodeHmac !== null,
      profileComplete: user.profileCompletedAt !== null,
      profile,
    };
  }

  /**
   * S03. Under 18 (P4) is refused and nothing is stored. Health-data consent is recorded with the
   * version the app showed.
   */
  async completeAccount(
    userId: string,
    input: {
      fullName: string;
      dateOfBirth: string;
      gender: string;
      genderSelfDescription?: string;
      email?: string;
      healthDataConsentVersion: string;
    },
  ): Promise<{ ok: true } | { ok: false; error: 'UNDER_18' | 'INVALID_DATE_OF_BIRTH' }> {
    const now = this.now();
    const age = ageInYears(input.dateOfBirth, now);
    if (age === null) return { ok: false, error: 'INVALID_DATE_OF_BIRTH' };
    if (age < L.minimumAgeYears) return { ok: false, error: 'UNDER_18' };

    await this.opts.store.updateProfile(userId, {
      fullName: input.fullName.trim(),
      dateOfBirth: input.dateOfBirth,
      gender: input.gender,
      genderSelfDescription: input.gender === 'SELF_DESCRIBE' ? input.genderSelfDescription?.trim() || null : null,
      contactEmail: input.email?.trim().toLowerCase() || null,
      completedAt: now,
    });
    const consent = await this.opts.store.latestConsent(userId, 'HEALTH_DATA');
    if (!consent || consent.version !== input.healthDataConsentVersion) {
      await this.opts.store.addConsent(userId, 'HEALTH_DATA', input.healthDataConsentVersion, now);
    }
    await this.opts.store.audit(userId, 'PROFILE_COMPLETED', 'USER', userId);
    return { ok: true };
  }
}

/** Whole years from a YYYY-MM-DD date to today (UTC); null for an invalid or future date. */
export function ageInYears(dateOfBirth: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dob = new Date(Date.UTC(y, mo - 1, d));
  if (dob.getUTCFullYear() !== y || dob.getUTCMonth() !== mo - 1 || dob.getUTCDate() !== d) return null;
  if (dob.getTime() > now.getTime() || y < 1900) return null;
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() < mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}
