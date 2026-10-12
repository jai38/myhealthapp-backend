/**
 * Authentication Provider Adapter Interface & Mock Implementation
 *
 * This decoupled architecture ensures the backend and client can work
 * seamlessly while final provider selection (Supabase vs Node-Internal vs Firebase)
 * is finalized, avoiding any vendor lock-in.
 */

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

export interface AuthProviderAdapter {
  signUpWithEmail(email: string, password: string): Promise<{ userId: string; requiresVerification: boolean }>;
  verifyEmail(token: string): Promise<boolean>;
  signInWithEmail(email: string, password: string): Promise<AuthSession>;
  signInWithGoogle(idToken: string): Promise<AuthSession>;
  refreshToken(refreshToken: string): Promise<AuthSession>;
  signOut(session: AuthSession): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<void>;
  verifySessionToken(token: string): Promise<{ userId: string; email: string }>;
}

/**
 * MockAuthProviderAdapter for local testing and deterministic CI runs.
 */
export class MockAuthProviderAdapter implements AuthProviderAdapter {
  private users: Map<string, { email: string; passwordHash: string; isVerified: boolean }> = new Map();
  private sessions: Map<string, AuthSession> = new Map();

  async signUpWithEmail(email: string, _password: string): Promise<{ userId: string; requiresVerification: boolean }> {
    const userId = `usr_mock_${Buffer.from(email).toString('hex').slice(0, 12)}`;
    this.users.set(userId, { email, passwordHash: 'mock-hash', isVerified: false });
    return { userId, requiresVerification: true };
  }

  async verifyEmail(token: string): Promise<boolean> {
    if (token === 'invalid-token') return false;
    return true;
  }

  async signInWithEmail(email: string, _password: string): Promise<AuthSession> {
    const userId = `usr_mock_${Buffer.from(email).toString('hex').slice(0, 12)}`;
    const session: AuthSession = {
      userId,
      patientProfileId: `pat_mock_${userId}`,
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
      patientProfileId: `pat_mock_${userId}`,
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
      patientProfileId: `pat_mock_${userId}`,
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

  async verifySessionToken(token: string): Promise<{ userId: string; email: string }> {
    if (!token || token === 'invalid' || token === 'expired') {
      throw new Error('Invalid or expired token');
    }
    if (token.startsWith('mock-access-jwt-')) {
      const userId = token.replace('mock-access-jwt-', '').replace('refreshed-', '');
      return { userId, email: `patient-${userId}@example.com` };
    }
    throw new Error('Unrecognized token format');
  }
}
