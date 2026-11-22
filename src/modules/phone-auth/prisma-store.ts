import type { PrismaClient } from '@prisma/client';
import { PHONE_AUTH_LIMITS } from './limits.js';
import {
  PROFILE_NAME_PLACEHOLDER,
  type ChallengeRow,
  type ConsentKind,
  type CountKey,
  type DeviceRow,
  type OtpDelivery,
  type OtpRequestRow,
  type PhoneAuthStore,
  type PhoneUserRow,
  type ProfileUpdate,
  type ProfileView,
  type RefreshRow,
} from './store.js';

const FINAL_DELIVERY: OtpDelivery[] = ['DELIVERED', 'WHATSAPP_UNAVAILABLE', 'FAILED'];

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

const userSelect = {
  id: true,
  phoneE164: true,
  createdAt: true,
  lastActiveAt: true,
  recoveryCodeHmac: true,
  recoveryCodeCreatedAt: true,
  patientProfile: { select: { id: true, profileCompletedAt: true } },
} as const;

type SelectedUser = {
  id: string;
  phoneE164: string | null;
  createdAt: Date;
  lastActiveAt: Date | null;
  recoveryCodeHmac: string | null;
  recoveryCodeCreatedAt: Date | null;
  patientProfile: { id: string; profileCompletedAt: Date | null } | null;
};

function toUser(u: SelectedUser | null): PhoneUserRow | null {
  if (!u || !u.phoneE164 || !u.patientProfile) return null;
  return {
    id: u.id,
    phoneE164: u.phoneE164,
    patientProfileId: u.patientProfile.id,
    createdAt: u.createdAt,
    lastActiveAt: u.lastActiveAt,
    recoveryCodeHmac: u.recoveryCodeHmac,
    recoveryCodeCreatedAt: u.recoveryCodeCreatedAt,
    profileCompletedAt: u.patientProfile.profileCompletedAt,
  };
}

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export class PrismaPhoneAuthStore implements PhoneAuthStore {
  constructor(private readonly prisma: PrismaClient) {}

  // -- codes -----------------------------------------------------------------

  async createOtpRequest(row: Parameters<PhoneAuthStore['createOtpRequest']>[0], now: Date): Promise<OtpRequestRow> {
    return (await this.prisma.otpRequest.create({ data: { ...row, createdAt: now } })) as OtpRequestRow;
  }

  async cancelOpenOtpRequests(phoneHmac: string, now: Date): Promise<void> {
    await this.prisma.otpRequest.updateMany({
      where: { phoneHmac, consumedAt: null, cancelledAt: null },
      data: { cancelledAt: now },
    });
  }

  async countOtpRequests(key: CountKey, since: Date): Promise<number> {
    const where = key === 'all' ? { createdAt: { gte: since } } : { ...key, createdAt: { gte: since } };
    return this.prisma.otpRequest.count({ where });
  }

  async otpRequestTimes(phoneHmac: string, since: Date): Promise<Date[]> {
    const rows = await this.prisma.otpRequest.findMany({
      where: { phoneHmac, createdAt: { gte: since } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.createdAt);
  }

  async getOtpRequest(id: string): Promise<OtpRequestRow | null> {
    if (!isUuid(id)) return null;
    return (await this.prisma.otpRequest.findUnique({ where: { id } })) as OtpRequestRow | null;
  }

  async addWrongAttempt(id: string): Promise<number | null> {
    const updated = await this.prisma.otpRequest.updateMany({
      where: { id, consumedAt: null, cancelledAt: null },
      data: { wrongAttempts: { increment: 1 } },
    });
    if (updated.count !== 1) return null;
    const row = await this.prisma.otpRequest.findUnique({ where: { id }, select: { wrongAttempts: true } });
    return row?.wrongAttempts ?? null;
  }

  async consumeOtpRequest(id: string, now: Date): Promise<boolean> {
    const updated = await this.prisma.otpRequest.updateMany({
      where: {
        id,
        consumedAt: null,
        cancelledAt: null,
        expiresAt: { gt: now },
        wrongAttempts: { lt: PHONE_AUTH_LIMITS.maxWrongAttemptsPerCode },
      },
      data: { consumedAt: now },
    });
    return updated.count === 1;
  }

  async setDelivery(id: string, delivery: OtpDelivery, providerMessageId?: string): Promise<void> {
    await this.prisma.otpRequest.update({
      where: { id },
      data: { delivery, ...(providerMessageId ? { providerMessageId } : {}) },
    });
  }

  async setDeliveryByProviderId(providerMessageId: string, delivery: OtpDelivery): Promise<void> {
    await this.prisma.otpRequest.updateMany({
      where: { providerMessageId, delivery: { notIn: FINAL_DELIVERY } },
      data: { delivery },
    });
  }

  async purgeOtpRequestsBefore(cutoff: Date): Promise<void> {
    await this.prisma.otpRequest.deleteMany({ where: { createdAt: { lt: cutoff } } });
  }

  // -- users -----------------------------------------------------------------

  async findUserByPhone(phoneE164: string): Promise<PhoneUserRow | null> {
    return toUser(await this.prisma.user.findUnique({ where: { phoneE164 }, select: userSelect }));
  }

  async getUser(userId: string): Promise<PhoneUserRow | null> {
    if (!isUuid(userId)) return null;
    return toUser(await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect }));
  }

  async createPhoneUser(phoneE164: string, now: Date): Promise<{ user: PhoneUserRow; created: boolean }> {
    // Look first, so the usual returning-user path doesn't raise (and log) a unique violation.
    const existing = await this.findUserByPhone(phoneE164);
    if (existing) return { user: existing, created: false };
    try {
      const created = await this.prisma.user.create({
        data: {
          phoneE164,
          phoneVerifiedAt: now,
          lastActiveAt: now,
          authProvider: 'PHONE',
          isVerified: true,
          patientProfile: { create: { fullName: PROFILE_NAME_PLACEHOLDER, isPrimaryAccountHolder: true } },
        },
        select: userSelect,
      });
      return { user: toUser(created)!, created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.findUserByPhone(phoneE164);
      if (!existing) throw err;
      return { user: existing, created: false };
    }
  }

  async touchUser(userId: string, now: Date): Promise<void> {
    await this.prisma.user.updateMany({ where: { id: userId }, data: { lastActiveAt: now } });
  }

  async setRecoveryCode(userId: string, hmac: string | null, now: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { recoveryCodeHmac: hmac, recoveryCodeCreatedAt: hmac ? now : null },
    });
  }

  async consumeRecoveryCode(userId: string, hmac: string): Promise<boolean> {
    const updated = await this.prisma.user.updateMany({
      where: { id: userId, recoveryCodeHmac: hmac },
      data: { recoveryCodeHmac: null, recoveryCodeCreatedAt: null },
    });
    return updated.count === 1;
  }

  async getProfile(userId: string): Promise<ProfileView | null> {
    const p = await this.prisma.patientProfile.findUnique({ where: { userId } });
    if (!p) return null;
    return {
      fullName: p.fullName,
      dateOfBirth: isoDate(p.dateOfBirth),
      gender: p.gender,
      genderSelfDescription: p.genderSelfDescription,
      contactEmail: p.contactEmail,
      profileCompletedAt: p.profileCompletedAt,
    };
  }

  async updateProfile(userId: string, update: ProfileUpdate): Promise<void> {
    await this.prisma.patientProfile.update({
      where: { userId },
      data: {
        fullName: update.fullName,
        dateOfBirth: new Date(`${update.dateOfBirth}T00:00:00.000Z`),
        gender: update.gender,
        genderSelfDescription: update.genderSelfDescription,
        contactEmail: update.contactEmail,
        profileCompletedAt: update.completedAt,
      },
    });
  }

  // -- consent ---------------------------------------------------------------

  async addConsent(userId: string, kind: ConsentKind, version: string, now: Date): Promise<void> {
    await this.prisma.consentRecord.create({ data: { userId, kind, version, acceptedAt: now } });
  }

  async latestConsent(userId: string, kind: ConsentKind): Promise<{ version: string; acceptedAt: Date } | null> {
    return this.prisma.consentRecord.findFirst({
      where: { userId, kind },
      orderBy: { acceptedAt: 'desc' },
      select: { version: true, acceptedAt: true },
    });
  }

  // -- devices ---------------------------------------------------------------

  async findActiveDevice(userId: string, installIdHmac: string): Promise<DeviceRow | null> {
    return this.prisma.device.findFirst({ where: { userId, installIdHmac, revokedAt: null } });
  }

  async getDevice(deviceId: string): Promise<DeviceRow | null> {
    if (!isUuid(deviceId)) return null;
    return this.prisma.device.findUnique({ where: { id: deviceId } });
  }

  async createDevice(row: { userId: string; installIdHmac: string; name: string; platform: string }, now: Date): Promise<DeviceRow> {
    return this.prisma.device.create({ data: { ...row, createdAt: now, lastSeenAt: now } });
  }

  async listActiveDevices(userId: string): Promise<DeviceRow[]> {
    return this.prisma.device.findMany({ where: { userId, revokedAt: null }, orderBy: { lastSeenAt: 'desc' } });
  }

  async touchDevice(deviceId: string, now: Date): Promise<void> {
    await this.prisma.device.updateMany({ where: { id: deviceId }, data: { lastSeenAt: now } });
  }

  async revokeDevice(userId: string, deviceId: string, now: Date): Promise<boolean> {
    if (!isUuid(deviceId)) return false;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.device.updateMany({ where: { id: deviceId, userId, revokedAt: null }, data: { revokedAt: now } });
      if (updated.count !== 1) return false;
      await tx.refreshToken.updateMany({ where: { deviceId, revokedAt: null }, data: { revokedAt: now } });
      return true;
    });
  }

  // -- refresh tokens --------------------------------------------------------

  async createRefreshToken(row: Omit<RefreshRow, 'id' | 'revokedAt'>): Promise<void> {
    await this.prisma.refreshToken.create({ data: row });
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshRow | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async claimRefreshToken(id: string, now: Date): Promise<boolean> {
    const updated = await this.prisma.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
    return updated.count === 1;
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
  }

  // -- second factor ---------------------------------------------------------

  async createChallenge(row: Omit<ChallengeRow, 'id' | 'wrongAttempts' | 'consumedAt'>): Promise<ChallengeRow> {
    return this.prisma.secondFactorChallenge.create({ data: row });
  }

  async findChallenge(tokenHash: string): Promise<ChallengeRow | null> {
    return this.prisma.secondFactorChallenge.findUnique({ where: { tokenHash } });
  }

  async addChallengeWrongAttempt(id: string): Promise<number | null> {
    const updated = await this.prisma.secondFactorChallenge.updateMany({
      where: { id, consumedAt: null },
      data: { wrongAttempts: { increment: 1 } },
    });
    if (updated.count !== 1) return null;
    const row = await this.prisma.secondFactorChallenge.findUnique({ where: { id }, select: { wrongAttempts: true } });
    return row?.wrongAttempts ?? null;
  }

  async consumeChallenge(id: string, now: Date): Promise<boolean> {
    const updated = await this.prisma.secondFactorChallenge.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: now }, wrongAttempts: { lt: PHONE_AUTH_LIMITS.maxSecondFactorAttempts } },
      data: { consumedAt: now },
    });
    return updated.count === 1;
  }

  async audit(userId: string, action: string, resourceType: string, resourceId?: string): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { userId, action, resourceType, resourceId } });
    } catch {
      // An audit failure must not fail a sign-in.
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
