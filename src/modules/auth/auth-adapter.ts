import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { EmailSender, createEmailSender } from './email-service.js';

export interface AuthUser {
  userId: string;
  email: string;
  isVerified: boolean;
}

export interface AuthSession {
  userId: string;
  patientProfileId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface SignUpResult {
  requiresVerification: boolean;
  userId?: string;
  patientProfileId?: string;
  session?: AuthSession;
}

export type AuthErrorCode = 'INVALID_CREDENTIALS' | 'EMAIL_NOT_VERIFIED' | 'INVALID_TOKEN';

/**
 * Typed auth failure. Routes map `code` to HTTP responses; messages are never shown to clients verbatim.
 */
export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

export interface AuthProviderAdapter {
  signUpWithEmail(email: string, password: string, fullName?: string): Promise<SignUpResult>;
  verifyEmail(token: string): Promise<boolean>;
  resendVerification(email: string): Promise<void>;
  signInWithEmail(email: string, password: string): Promise<AuthSession>;
  refreshToken(refreshToken: string): Promise<AuthSession>;
  signOut(refreshToken: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<void>;
  verifySessionToken(token: string): Promise<{ userId: string; email: string; patientProfileId?: string }>;
  /** Removes the user row and everything that cascades from it. Storage purge is the caller's job. */
  deleteAccount(userId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Token helpers: tokens are random, only their SHA-256 hash is stored.
// ---------------------------------------------------------------------------

export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_COST = 10;

// Compared against when the account does not exist so response time does not reveal it.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equalisation-placeholder', BCRYPT_COST);

/**
 * MockAuthProviderAdapter for local testing and deterministic CI runs.
 * Never used in production (validateProductionConfig refuses AUTH_PROVIDER=mock).
 */
export class MockAuthProviderAdapter implements AuthProviderAdapter {
  private users: Map<string, { email: string; passwordHash: string; isVerified: boolean }> = new Map();
  private sessions: Map<string, AuthSession> = new Map();

  async signUpWithEmail(email: string, _password: string, _fullName?: string): Promise<SignUpResult> {
    const userId = `usr_mock_${Buffer.from(email).toString('hex').slice(0, 12)}`;
    const patientProfileId = `pat_${userId}`;
    const session: AuthSession = {
      userId,
      patientProfileId,
      accessToken: `mock-access-jwt-${userId}`,
      refreshToken: `mock-refresh-${userId}`,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
    this.users.set(userId, { email, passwordHash: 'mock-hash', isVerified: true });
    this.sessions.set(session.accessToken, session);
    return { userId, patientProfileId, requiresVerification: false, session };
  }

  async verifyEmail(token: string): Promise<boolean> {
    return Boolean(token) && token.startsWith('mock-valid');
  }

  async resendVerification(_email: string): Promise<void> {}

  async signInWithEmail(email: string, _password: string): Promise<AuthSession> {
    const userId = `usr_mock_${Buffer.from(email).toString('hex').slice(0, 12)}`;
    const session: AuthSession = {
      userId,
      patientProfileId: `pat_${userId}`,
      accessToken: `mock-access-jwt-${userId}`,
      refreshToken: `mock-refresh-${userId}`,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
    this.sessions.set(session.accessToken, session);
    return session;
  }

  async refreshToken(refreshToken: string): Promise<AuthSession> {
    if (!refreshToken || refreshToken.startsWith('expired')) {
      throw new AuthError('INVALID_TOKEN');
    }
    const userId = refreshToken.replace('mock-refresh-', '');
    return {
      userId,
      patientProfileId: `pat_${userId}`,
      accessToken: `mock-access-jwt-refreshed-${userId}`,
      refreshToken: `mock-refresh-new-${userId}`,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
  }

  async signOut(_refreshToken: string): Promise<void> {}

  async requestPasswordReset(_email: string): Promise<void> {}

  async resetPassword(token: string, _newPassword: string): Promise<void> {
    if (!token.startsWith('mock-valid')) {
      throw new AuthError('INVALID_TOKEN');
    }
  }

  async deleteAccount(userId: string): Promise<void> {
    this.users.delete(userId);
    for (const [key, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(key);
    }
  }

  async verifySessionToken(token: string): Promise<{ userId: string; email: string; patientProfileId?: string }> {
    if (!token || token === 'invalid' || token === 'expired') {
      throw new Error('Invalid or expired token');
    }
    if (token.startsWith('mock-access-jwt-')) {
      const userId = token.replace('mock-access-jwt-', '').replace('refreshed-', '');
      return { userId, email: `patient-${userId}@example.com`, patientProfileId: `pat_${userId}` };
    }
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as {
        userId: string;
        email: string;
        patientProfileId?: string;
      };
      return { userId: decoded.userId, email: decoded.email, patientProfileId: decoded.patientProfileId || `pat_${decoded.userId}` };
    } catch {
      throw new Error('Unrecognized token format');
    }
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * DatabaseAuthProviderAdapter: PostgreSQL + Prisma, bcryptjs password hashing, signed JWT access tokens
 * and opaque rotating refresh tokens. Email-and-password only; email OTP and passkeys arrive in Phase 5.
 *
 * Logging rule: nothing here logs tokens, emails, or request bodies.
 */
export class DatabaseAuthProviderAdapter implements AuthProviderAdapter {
  constructor(
    private prisma: PrismaClient,
    private emailSender: EmailSender = createEmailSender(),
    private requireEmailVerification: boolean = env.EMAIL_VERIFICATION_REQUIRED,
  ) {}

  // -- sign-up / verification ------------------------------------------------

  async signUpWithEmail(email: string, password: string, fullName?: string): Promise<SignUpResult> {
    const normalizedEmail = email.trim().toLowerCase();

    // Always hash, so the "already registered" path costs the same as the "new account" path.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const verificationToken = generateOpaqueToken();

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: normalizedEmail,
            passwordHash,
            authProvider: 'EMAIL',
            isVerified: !this.requireEmailVerification,
          },
        });

        const profile = await tx.patientProfile.create({
          data: {
            userId: user.id,
            fullName: fullName && fullName.trim().length > 0 ? fullName.trim() : 'Patient Profile',
            isPrimaryAccountHolder: true,
          },
        });

        if (this.requireEmailVerification) {
          await tx.emailVerificationToken.create({
            data: {
              userId: user.id,
              tokenHash: hashToken(verificationToken),
              expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
            },
          });
        }

        await this.audit(tx, user.id, 'USER_SIGNED_UP', 'USER', user.id);
        return { user, profile };
      });

      if (!this.requireEmailVerification) {
        const session = await this.issueSession(this.prisma, result.user.id, result.user.email, result.profile.id, crypto.randomUUID());
        return {
          userId: result.user.id,
          patientProfileId: result.profile.id,
          session,
          requiresVerification: false,
        };
      }

      this.sendInBackground(() => this.emailSender.sendVerificationEmail(normalizedEmail, verificationToken));

      // No session until the email is verified.
      return {
        userId: result.user.id,
        patientProfileId: result.profile.id,
        requiresVerification: true,
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Indistinguishable from success: the caller must not learn that the email is registered.
        return { requiresVerification: true };
      }
      throw err;
    }
  }

  async verifyEmail(token: string): Promise<boolean> {
    if (!token) return false;

    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!record) return false;

    return this.prisma.$transaction(async (tx) => {
      // Single-use: only one concurrent caller can delete the row.
      const consumed = await tx.emailVerificationToken.deleteMany({ where: { id: record.id } });
      if (consumed.count !== 1 || record.expiresAt.getTime() <= Date.now()) {
        return false;
      }
      await tx.user.update({ where: { id: record.userId }, data: { isVerified: true } });
      await tx.emailVerificationToken.deleteMany({ where: { userId: record.userId } });
      await this.audit(tx, record.userId, 'EMAIL_VERIFIED', 'USER', record.userId);
      return true;
    });
  }

  async resendVerification(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user || user.isVerified) return;

    const token = generateOpaqueToken();
    await this.prisma.$transaction(async (tx) => {
      // One live link per user; older links stop working.
      await tx.emailVerificationToken.deleteMany({ where: { userId: user.id } });
      await tx.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
        },
      });
    });
    this.sendInBackground(() => this.emailSender.sendVerificationEmail(normalizedEmail, token));
  }

  // -- sign-in / sessions ----------------------------------------------------

  async signInWithEmail(email: string, password: string): Promise<AuthSession> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { patientProfile: true },
    });

    // Always run one bcrypt comparison so unknown accounts are not distinguishable by timing.
    const isMatch = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.passwordHash || !isMatch) {
      throw new AuthError('INVALID_CREDENTIALS');
    }

    // Only reveal the verification state to someone who proved they know the password.
    if (!user.isVerified) {
      throw new AuthError('EMAIL_NOT_VERIFIED');
    }

    let profileId = user.patientProfile?.id;
    if (!profileId) {
      const newProfile = await this.prisma.patientProfile.create({
        data: { userId: user.id, fullName: 'Patient Profile', isPrimaryAccountHolder: true },
      });
      profileId = newProfile.id;
    }

    const session = await this.issueSession(this.prisma, user.id, user.email, profileId, crypto.randomUUID());
    await this.auditSafe(user.id, 'LOGIN', 'USER', user.id);
    return session;
  }

  async refreshToken(refreshToken: string): Promise<AuthSession> {
    if (!refreshToken) throw new AuthError('INVALID_TOKEN');

    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!record) throw new AuthError('INVALID_TOKEN');

    if (record.revokedAt) {
      // A rotated-out token came back: assume theft and kill the whole session family.
      await this.revokeFamily(record.familyId);
      await this.auditSafe(record.userId, 'REFRESH_TOKEN_REUSE_DETECTED', 'USER', record.userId);
      throw new AuthError('INVALID_TOKEN');
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new AuthError('INVALID_TOKEN');
    }

    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) {
      await this.revokeFamily(record.familyId);
      throw new AuthError('INVALID_TOKEN');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      include: { patientProfile: true },
    });
    if (!user || !user.isVerified || !user.patientProfile) {
      await this.revokeFamily(record.familyId);
      throw new AuthError('INVALID_TOKEN');
    }

    return this.issueSession(this.prisma, user.id, user.email, user.patientProfile.id, record.familyId);
  }

  async signOut(refreshToken: string): Promise<void> {
    if (!refreshToken) return;
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (record) {
      await this.revokeFamily(record.familyId);
    }
  }

  async verifySessionToken(token: string): Promise<{ userId: string; email: string; patientProfileId?: string }> {
    let decoded: { userId: string; email: string; patientProfileId?: string; iat?: number };
    try {
      decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as typeof decoded;
    } catch {
      throw new Error('Invalid or expired session token');
    }
    if (!decoded.userId || !decoded.patientProfileId) {
      throw new Error('Invalid or expired session token');
    }

    // Deleted accounts and tokens minted before a password change stop working immediately.
    const user = await this.prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user || !user.isVerified) {
      throw new Error('Invalid or expired session token');
    }
    if (user.passwordChangedAt && (decoded.iat ?? 0) < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      throw new Error('Invalid or expired session token');
    }

    return {
      userId: decoded.userId,
      email: decoded.email,
      patientProfileId: decoded.patientProfileId,
    };
  }

  // -- password reset --------------------------------------------------------

  async requestPasswordReset(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) return; // Same outward behaviour as a known address.

    const token = generateOpaqueToken();
    await this.prisma.$transaction(async (tx) => {
      // One live reset link per user; also limits token-table growth from repeated requests.
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      });
    });

    this.sendInBackground(() => this.emailSender.sendPasswordResetEmail(normalizedEmail, token));
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!token) throw new AuthError('INVALID_TOKEN');

    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!record) throw new AuthError('INVALID_TOKEN');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.deleteMany({ where: { id: record.id } });
      if (consumed.count !== 1 || record.expiresAt.getTime() <= Date.now()) {
        throw new AuthError('INVALID_TOKEN');
      }

      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, passwordChangedAt: new Date() },
      });
      await tx.passwordResetToken.deleteMany({ where: { userId: record.userId } });
      // Every existing refresh session ends; access tokens older than the change are rejected.
      await tx.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(tx, record.userId, 'PASSWORD_RESET', 'USER', record.userId);
    });
  }

  // -- account deletion ------------------------------------------------------

  async deleteAccount(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.audit(tx, userId, 'ACCOUNT_DELETED', 'USER', userId);
      // Profile first: it cascades documents, upload intents, jobs, prescriptions, items, timeline,
      // medications, dose logs and preferences. Prescription.confirmedByUserId would otherwise
      // restrict the user delete. Token tables cascade from the user row.
      await tx.patientProfile.deleteMany({ where: { userId } });
      await tx.user.deleteMany({ where: { id: userId } });
    });
  }

  // -- internals -------------------------------------------------------------

  private async issueSession(
    db: Db,
    userId: string,
    email: string,
    patientProfileId: string,
    familyId: string,
  ): Promise<AuthSession> {
    const accessToken = jwt.sign({ userId, email, patientProfileId }, env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });
    const exp = (jwt.decode(accessToken) as { exp: number }).exp;

    const refreshToken = generateOpaqueToken();
    await db.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    return { userId, patientProfileId, accessToken, refreshToken, expiresAt: exp * 1000 };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** IDs, action codes and timestamps only. */
  private async audit(db: Db, userId: string, action: string, resourceType: string, resourceId?: string): Promise<void> {
    await db.auditEvent.create({ data: { userId, action, resourceType, resourceId } });
  }

  private async auditSafe(userId: string, action: string, resourceType: string, resourceId?: string): Promise<void> {
    try {
      await this.audit(this.prisma, userId, action, resourceType, resourceId);
    } catch {
      // Audit failure must not turn a successful login into an error.
    }
  }

  /**
   * Email is sent without awaiting so response time and status never depend on whether an
   * account exists or whether the provider is up. Failures are swallowed: no addresses or tokens
   * in logs.
   */
  private sendInBackground(send: () => Promise<void>): void {
    void send().catch(() => undefined);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
