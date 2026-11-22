import crypto from 'node:crypto';
import { PHONE_AUTH_LIMITS } from './limits.js';

export type OtpDelivery = 'PENDING' | 'SENT' | 'DELIVERED' | 'WHATSAPP_UNAVAILABLE' | 'FAILED';
export type ConsentKind = 'TERMS' | 'HEALTH_DATA';

export interface OtpRequestRow {
  id: string;
  phoneHmac: string;
  phoneE164: string;
  codeHmac: string;
  installIdHmac: string;
  ipHmac: string;
  termsVersion: string;
  expiresAt: Date;
  wrongAttempts: number;
  consumedAt: Date | null;
  cancelledAt: Date | null;
  delivery: OtpDelivery;
  providerMessageId: string | null;
  createdAt: Date;
}

export interface PhoneUserRow {
  id: string;
  phoneE164: string;
  patientProfileId: string;
  createdAt: Date;
  lastActiveAt: Date | null;
  recoveryCodeHmac: string | null;
  recoveryCodeCreatedAt: Date | null;
  profileCompletedAt: Date | null;
}

export interface DeviceRow {
  id: string;
  userId: string;
  installIdHmac: string;
  name: string;
  platform: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface RefreshRow {
  id: string;
  userId: string;
  deviceId: string | null;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface ChallengeRow {
  id: string;
  userId: string;
  tokenHash: string;
  installIdHmac: string;
  deviceName: string;
  devicePlatform: string;
  wrongAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface ProfileUpdate {
  fullName: string;
  dateOfBirth: string; // YYYY-MM-DD
  gender: string;
  genderSelfDescription: string | null;
  contactEmail: string | null;
  completedAt: Date;
}

export interface ProfileView {
  fullName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  genderSelfDescription: string | null;
  contactEmail: string | null;
  profileCompletedAt: Date | null;
}

export type CountKey = { phoneHmac: string } | { installIdHmac: string } | { ipHmac: string } | 'all';

/**
 * Storage for phone sign-in. Prisma in production, memory in tests. Every write that guards a
 * security rule (consuming a code, claiming a refresh token) is a single conditional update, so two
 * concurrent callers can't both win.
 */
export interface PhoneAuthStore {
  // Codes
  createOtpRequest(row: Omit<OtpRequestRow, 'id' | 'createdAt' | 'wrongAttempts' | 'consumedAt' | 'cancelledAt' | 'delivery' | 'providerMessageId'>, now: Date): Promise<OtpRequestRow>;
  cancelOpenOtpRequests(phoneHmac: string, now: Date): Promise<void>;
  countOtpRequests(key: CountKey, since: Date): Promise<number>;
  /** Creation times of this number's requests since `since`, oldest first. */
  otpRequestTimes(phoneHmac: string, since: Date): Promise<Date[]>;
  getOtpRequest(id: string): Promise<OtpRequestRow | null>;
  /** Adds one wrong attempt if the code is still open; returns the new count, or null if it wasn't. */
  addWrongAttempt(id: string): Promise<number | null>;
  /** Marks the code used. True only for the single caller that consumed it. */
  consumeOtpRequest(id: string, now: Date): Promise<boolean>;
  setDelivery(id: string, delivery: OtpDelivery, providerMessageId?: string): Promise<void>;
  /** Webhook update. Never moves a request back from a final state to an earlier one. */
  setDeliveryByProviderId(providerMessageId: string, delivery: OtpDelivery): Promise<void>;
  purgeOtpRequestsBefore(cutoff: Date): Promise<void>;

  // Users
  findUserByPhone(phoneE164: string): Promise<PhoneUserRow | null>;
  getUser(userId: string): Promise<PhoneUserRow | null>;
  /** Creates the user and an empty profile; returns the existing user if the number won a race. */
  createPhoneUser(phoneE164: string, now: Date): Promise<{ user: PhoneUserRow; created: boolean }>;
  touchUser(userId: string, now: Date): Promise<void>;
  setRecoveryCode(userId: string, hmac: string | null, now: Date): Promise<void>;
  /** Clears the recovery code only if it is still the one given; true for the caller that cleared it. */
  consumeRecoveryCode(userId: string, hmac: string): Promise<boolean>;
  getProfile(userId: string): Promise<ProfileView | null>;
  updateProfile(userId: string, update: ProfileUpdate): Promise<void>;

  // Consent
  addConsent(userId: string, kind: ConsentKind, version: string, now: Date): Promise<void>;
  latestConsent(userId: string, kind: ConsentKind): Promise<{ version: string; acceptedAt: Date } | null>;

  // Devices
  findActiveDevice(userId: string, installIdHmac: string): Promise<DeviceRow | null>;
  getDevice(deviceId: string): Promise<DeviceRow | null>;
  createDevice(row: { userId: string; installIdHmac: string; name: string; platform: string }, now: Date): Promise<DeviceRow>;
  listActiveDevices(userId: string): Promise<DeviceRow[]>;
  touchDevice(deviceId: string, now: Date): Promise<void>;
  /** Revokes the device and its refresh tokens. False if it wasn't the user's active device. */
  revokeDevice(userId: string, deviceId: string, now: Date): Promise<boolean>;

  // Refresh tokens
  createRefreshToken(row: Omit<RefreshRow, 'id' | 'revokedAt'>): Promise<void>;
  findRefreshToken(tokenHash: string): Promise<RefreshRow | null>;
  claimRefreshToken(id: string, now: Date): Promise<boolean>;
  revokeFamily(familyId: string, now: Date): Promise<void>;

  // Second factor (P2)
  createChallenge(row: Omit<ChallengeRow, 'id' | 'wrongAttempts' | 'consumedAt'>): Promise<ChallengeRow>;
  findChallenge(tokenHash: string): Promise<ChallengeRow | null>;
  addChallengeWrongAttempt(id: string): Promise<number | null>;
  consumeChallenge(id: string, now: Date): Promise<boolean>;

  /** IDs, action codes and timestamps only (rule 8). */
  audit(userId: string, action: string, resourceType: string, resourceId?: string): Promise<void>;
}

/** Placeholder name signup stores until S03; never shown or exported as a name. */
export const PROFILE_NAME_PLACEHOLDER = 'Patient Profile';

const isOpen = (r: OtpRequestRow) => r.consumedAt === null && r.cancelledAt === null;
const FINAL_DELIVERY: OtpDelivery[] = ['DELIVERED', 'WHATSAPP_UNAVAILABLE', 'FAILED'];

export class InMemoryPhoneAuthStore implements PhoneAuthStore {
  readonly otpRequests = new Map<string, OtpRequestRow>();
  readonly users = new Map<string, PhoneUserRow>();
  readonly profiles = new Map<string, ProfileView>();
  readonly consents: Array<{ userId: string; kind: ConsentKind; version: string; acceptedAt: Date }> = [];
  readonly devices = new Map<string, DeviceRow>();
  readonly refreshTokens = new Map<string, RefreshRow>();
  readonly challenges = new Map<string, ChallengeRow>();
  readonly auditEvents: Array<{ userId: string; action: string; resourceType: string; resourceId?: string; createdAt: Date }> = [];

  async createOtpRequest(row: Parameters<PhoneAuthStore['createOtpRequest']>[0], now: Date): Promise<OtpRequestRow> {
    const full: OtpRequestRow = {
      ...row,
      id: crypto.randomUUID(),
      createdAt: now,
      wrongAttempts: 0,
      consumedAt: null,
      cancelledAt: null,
      delivery: 'PENDING',
      providerMessageId: null,
    };
    this.otpRequests.set(full.id, full);
    return { ...full };
  }

  async cancelOpenOtpRequests(phoneHmac: string, now: Date): Promise<void> {
    for (const r of this.otpRequests.values()) if (r.phoneHmac === phoneHmac && isOpen(r)) r.cancelledAt = now;
  }

  async countOtpRequests(key: CountKey, since: Date): Promise<number> {
    let n = 0;
    for (const r of this.otpRequests.values()) {
      if (r.createdAt < since) continue;
      if (key === 'all') n++;
      else if ('phoneHmac' in key && r.phoneHmac === key.phoneHmac) n++;
      else if ('installIdHmac' in key && r.installIdHmac === key.installIdHmac) n++;
      else if ('ipHmac' in key && r.ipHmac === key.ipHmac) n++;
    }
    return n;
  }

  async otpRequestTimes(phoneHmac: string, since: Date): Promise<Date[]> {
    return [...this.otpRequests.values()]
      .filter((r) => r.phoneHmac === phoneHmac && r.createdAt >= since)
      .map((r) => r.createdAt)
      .sort((a, b) => a.getTime() - b.getTime());
  }

  async getOtpRequest(id: string): Promise<OtpRequestRow | null> {
    const r = this.otpRequests.get(id);
    return r ? { ...r } : null;
  }

  async addWrongAttempt(id: string): Promise<number | null> {
    const r = this.otpRequests.get(id);
    if (!r || !isOpen(r)) return null;
    r.wrongAttempts += 1;
    return r.wrongAttempts;
  }

  async consumeOtpRequest(id: string, now: Date): Promise<boolean> {
    const r = this.otpRequests.get(id);
    if (!r || !isOpen(r) || r.wrongAttempts >= PHONE_AUTH_LIMITS.maxWrongAttemptsPerCode) return false;
    r.consumedAt = now;
    return true;
  }

  async setDelivery(id: string, delivery: OtpDelivery, providerMessageId?: string): Promise<void> {
    const r = this.otpRequests.get(id);
    if (!r) return;
    r.delivery = delivery;
    if (providerMessageId) r.providerMessageId = providerMessageId;
  }

  async setDeliveryByProviderId(providerMessageId: string, delivery: OtpDelivery): Promise<void> {
    for (const r of this.otpRequests.values()) {
      if (r.providerMessageId === providerMessageId && !FINAL_DELIVERY.includes(r.delivery)) r.delivery = delivery;
    }
  }

  async purgeOtpRequestsBefore(cutoff: Date): Promise<void> {
    for (const [id, r] of this.otpRequests) if (r.createdAt < cutoff) this.otpRequests.delete(id);
  }

  async findUserByPhone(phoneE164: string): Promise<PhoneUserRow | null> {
    const u = [...this.users.values()].find((x) => x.phoneE164 === phoneE164);
    return u ? this.withProfile(u) : null;
  }

  async getUser(userId: string): Promise<PhoneUserRow | null> {
    const u = this.users.get(userId);
    return u ? this.withProfile(u) : null;
  }

  private withProfile(u: PhoneUserRow): PhoneUserRow {
    return { ...u, profileCompletedAt: this.profiles.get(u.id)?.profileCompletedAt ?? null };
  }

  async createPhoneUser(phoneE164: string, now: Date): Promise<{ user: PhoneUserRow; created: boolean }> {
    const existing = await this.findUserByPhone(phoneE164);
    if (existing) return { user: existing, created: false };
    const user: PhoneUserRow = {
      id: crypto.randomUUID(),
      phoneE164,
      patientProfileId: crypto.randomUUID(),
      createdAt: now,
      lastActiveAt: now,
      recoveryCodeHmac: null,
      recoveryCodeCreatedAt: null,
      profileCompletedAt: null,
    };
    this.users.set(user.id, user);
    this.profiles.set(user.id, {
      fullName: PROFILE_NAME_PLACEHOLDER,
      dateOfBirth: null,
      gender: null,
      genderSelfDescription: null,
      contactEmail: null,
      profileCompletedAt: null,
    });
    return { user: { ...user }, created: true };
  }

  async touchUser(userId: string, now: Date): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.lastActiveAt = now;
  }

  async setRecoveryCode(userId: string, hmac: string | null, now: Date): Promise<void> {
    const u = this.users.get(userId);
    if (!u) return;
    u.recoveryCodeHmac = hmac;
    u.recoveryCodeCreatedAt = hmac ? now : null;
  }

  async consumeRecoveryCode(userId: string, hmac: string): Promise<boolean> {
    const u = this.users.get(userId);
    if (!u || u.recoveryCodeHmac !== hmac) return false;
    u.recoveryCodeHmac = null;
    u.recoveryCodeCreatedAt = null;
    return true;
  }

  async getProfile(userId: string): Promise<ProfileView | null> {
    const p = this.profiles.get(userId);
    return p ? { ...p } : null;
  }

  async updateProfile(userId: string, update: ProfileUpdate): Promise<void> {
    const p = this.profiles.get(userId);
    if (!p) return;
    Object.assign(p, {
      fullName: update.fullName,
      dateOfBirth: update.dateOfBirth,
      gender: update.gender,
      genderSelfDescription: update.genderSelfDescription,
      contactEmail: update.contactEmail,
      profileCompletedAt: update.completedAt,
    });
  }

  async addConsent(userId: string, kind: ConsentKind, version: string, now: Date): Promise<void> {
    this.consents.push({ userId, kind, version, acceptedAt: now });
  }

  async latestConsent(userId: string, kind: ConsentKind): Promise<{ version: string; acceptedAt: Date } | null> {
    const rows = this.consents.filter((c) => c.userId === userId && c.kind === kind);
    const last = rows[rows.length - 1];
    return last ? { version: last.version, acceptedAt: last.acceptedAt } : null;
  }

  async findActiveDevice(userId: string, installIdHmac: string): Promise<DeviceRow | null> {
    const d = [...this.devices.values()].find((x) => x.userId === userId && x.installIdHmac === installIdHmac && !x.revokedAt);
    return d ? { ...d } : null;
  }

  async getDevice(deviceId: string): Promise<DeviceRow | null> {
    const d = this.devices.get(deviceId);
    return d ? { ...d } : null;
  }

  async createDevice(row: { userId: string; installIdHmac: string; name: string; platform: string }, now: Date): Promise<DeviceRow> {
    const d: DeviceRow = { ...row, id: crypto.randomUUID(), createdAt: now, lastSeenAt: now, revokedAt: null };
    this.devices.set(d.id, d);
    return { ...d };
  }

  async listActiveDevices(userId: string): Promise<DeviceRow[]> {
    return [...this.devices.values()]
      .filter((d) => d.userId === userId && !d.revokedAt)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map((d) => ({ ...d }));
  }

  async touchDevice(deviceId: string, now: Date): Promise<void> {
    const d = this.devices.get(deviceId);
    if (d) d.lastSeenAt = now;
  }

  async revokeDevice(userId: string, deviceId: string, now: Date): Promise<boolean> {
    const d = this.devices.get(deviceId);
    if (!d || d.userId !== userId || d.revokedAt) return false;
    d.revokedAt = now;
    for (const t of this.refreshTokens.values()) if (t.deviceId === deviceId && !t.revokedAt) t.revokedAt = now;
    return true;
  }

  async createRefreshToken(row: Omit<RefreshRow, 'id' | 'revokedAt'>): Promise<void> {
    const id = crypto.randomUUID();
    this.refreshTokens.set(id, { ...row, id, revokedAt: null });
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshRow | null> {
    const t = [...this.refreshTokens.values()].find((x) => x.tokenHash === tokenHash);
    return t ? { ...t } : null;
  }

  async claimRefreshToken(id: string, now: Date): Promise<boolean> {
    const t = this.refreshTokens.get(id);
    if (!t || t.revokedAt) return false;
    t.revokedAt = now;
    return true;
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    for (const t of this.refreshTokens.values()) if (t.familyId === familyId && !t.revokedAt) t.revokedAt = now;
  }

  async createChallenge(row: Omit<ChallengeRow, 'id' | 'wrongAttempts' | 'consumedAt'>): Promise<ChallengeRow> {
    const c: ChallengeRow = { ...row, id: crypto.randomUUID(), wrongAttempts: 0, consumedAt: null };
    this.challenges.set(c.id, c);
    return { ...c };
  }

  async findChallenge(tokenHash: string): Promise<ChallengeRow | null> {
    const c = [...this.challenges.values()].find((x) => x.tokenHash === tokenHash);
    return c ? { ...c } : null;
  }

  async addChallengeWrongAttempt(id: string): Promise<number | null> {
    const c = this.challenges.get(id);
    if (!c || c.consumedAt) return null;
    c.wrongAttempts += 1;
    return c.wrongAttempts;
  }

  async consumeChallenge(id: string, now: Date): Promise<boolean> {
    const c = this.challenges.get(id);
    if (!c || c.consumedAt || c.wrongAttempts >= PHONE_AUTH_LIMITS.maxSecondFactorAttempts) return false;
    c.consumedAt = now;
    return true;
  }

  async audit(userId: string, action: string, resourceType: string, resourceId?: string): Promise<void> {
    this.auditEvents.push({ userId, action, resourceType, resourceId, createdAt: new Date() });
  }
}
