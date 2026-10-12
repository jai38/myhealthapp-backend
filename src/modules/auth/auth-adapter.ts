import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';

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
  userId: string;
  patientProfileId?: string;
  requiresVerification: boolean;
  session?: AuthSession;
}

export interface AuthProviderAdapter {
  signUpWithEmail(email: string, password: string, fullName?: string): Promise<SignUpResult>;
  verifyEmail(token: string): Promise<boolean>;
  signInWithEmail(email: string, password: string): Promise<AuthSession>;
  signInWithGoogle(idToken: string): Promise<AuthSession>;
  refreshToken(refreshToken: string): Promise<AuthSession>;
  signOut(session: AuthSession): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<void>;
  verifySessionToken(token: string): Promise<{ userId: string; email: string; patientProfileId?: string }>;
}

/**
 * MockAuthProviderAdapter for local testing and deterministic CI runs.
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
    if (token === 'invalid-token') return false;
    return true;
  }

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

  async signInWithGoogle(idToken: string): Promise<AuthSession> {
    if (!idToken || idToken === 'invalid-google-token') {
      throw new Error('Invalid Google ID Token');
    }
    const userId = `usr_google_mock_${idToken.slice(0, 8)}`;
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
      throw new Error('Invalid or expired refresh token');
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

  async signOut(session: AuthSession): Promise<void> {
    this.sessions.delete(session.accessToken);
  }

  async requestPasswordReset(_email: string): Promise<void> {
    // Generates mock reset token and sends simulated email
  }

  async resetPassword(token: string, _newPassword: string): Promise<void> {
    if (token === 'expired-token') {
      throw new Error('Password reset token has expired');
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
      const decoded = jwt.verify(token, env.JWT_SECRET) as { userId: string; email: string; patientProfileId?: string };
      return { userId: decoded.userId, email: decoded.email, patientProfileId: decoded.patientProfileId || `pat_${decoded.userId}` };
    } catch {
      throw new Error('Unrecognized token format');
    }
  }
}

/**
 * DatabaseAuthProviderAdapter: Real production/beta authentication using PostgreSQL + Prisma,
 * bcryptjs for password hashing, and signed JWTs.
 */
export class DatabaseAuthProviderAdapter implements AuthProviderAdapter {
  constructor(private prisma: PrismaClient) {}

  async signUpWithEmail(email: string, password: string, fullName?: string): Promise<SignUpResult> {
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new Error('Email is already registered');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          authProvider: 'EMAIL',
          isVerified: true,
        },
      });

      const profile = await tx.patientProfile.create({
        data: {
          userId: user.id,
          fullName: fullName && fullName.trim().length > 0 ? fullName.trim() : 'Patient Profile',
          isPrimaryAccountHolder: true,
        },
      });

      return { user, profile };
    });

    const session = this.generateSession(result.user.id, result.user.email, result.profile.id);

    return {
      userId: result.user.id,
      patientProfileId: result.profile.id,
      requiresVerification: false,
      session,
    };
  }

  async signInWithEmail(email: string, password: string): Promise<AuthSession> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { patientProfile: true },
    });

    if (!user || !user.passwordHash) {
      throw new Error('Invalid email or password');
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      throw new Error('Invalid email or password');
    }

    let profileId = user.patientProfile?.id;
    if (!profileId) {
      const newProfile = await this.prisma.patientProfile.create({
        data: {
          userId: user.id,
          fullName: 'Patient Profile',
          isPrimaryAccountHolder: true,
        },
      });
      profileId = newProfile.id;
    }

    return this.generateSession(user.id, user.email, profileId);
  }

  private generateSession(userId: string, email: string, patientProfileId: string): AuthSession {
    const accessToken = jwt.sign(
      { userId, email, patientProfileId },
      env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    const refreshToken = jwt.sign(
      { userId, type: 'refresh' },
      env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return {
      userId,
      patientProfileId,
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    };
  }

  async verifySessionToken(token: string): Promise<{ userId: string; email: string; patientProfileId?: string }> {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as {
        userId: string;
        email: string;
        patientProfileId?: string;
      };
      return {
        userId: decoded.userId,
        email: decoded.email,
        patientProfileId: decoded.patientProfileId,
      };
    } catch {
      throw new Error('Invalid or expired session token');
    }
  }

  async verifyEmail(_token: string): Promise<boolean> {
    return true;
  }

  async signInWithGoogle(_idToken: string): Promise<AuthSession> {
    throw new Error('Google sign-in is not yet configured for internal auth');
  }

  async refreshToken(refreshToken: string): Promise<AuthSession> {
    try {
      const decoded = jwt.verify(refreshToken, env.JWT_SECRET) as { userId: string; type: string };
      if (decoded.type !== 'refresh') {
        throw new Error('Invalid token type');
      }
      const user = await this.prisma.user.findUnique({
        where: { id: decoded.userId },
        include: { patientProfile: true },
      });
      if (!user) throw new Error('User not found');
      const profileId = user.patientProfile?.id;
      if (!profileId) throw new Error('Patient profile not found');
      return this.generateSession(user.id, user.email, profileId);
    } catch {
      throw new Error('Invalid or expired refresh token');
    }
  }

  async signOut(_session: AuthSession): Promise<void> {
    // Stateless JWT, client clears stored token
  }

  async requestPasswordReset(_email: string): Promise<void> {
    // Stub
  }

  async resetPassword(_token: string, _newPassword: string): Promise<void> {
    // Stub
  }
}

