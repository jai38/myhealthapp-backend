import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import {
  DatabaseAuthProviderAdapter,
  hashToken,
} from '../src/modules/auth/auth-adapter.js';
import { MemoryEmailSender } from '../src/modules/auth/email-service.js';

/**
 * Minimal in-memory stand-in for the Prisma calls the auth adapter makes. It lets the real
 * DatabaseAuthProviderAdapter run in unit tests with no database. It models the cascade the
 * migration defines (deleting a user removes its tokens).
 */
function createFakePrisma() {
  type Row = Record<string, any>;
  const tables: Record<string, Row[]> = {
    user: [],
    patientProfile: [],
    emailVerificationToken: [],
    passwordResetToken: [],
    refreshToken: [],
    auditEvent: [],
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));

  const delegate = (name: string) => ({
    create: async ({ data }: { data: Row }) => {
      if (name === 'user' && tables.user.some((u) => u.email === data.email)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      const row = {
        id: crypto.randomUUID(),
        createdAt: new Date(),
        revokedAt: null,
        passwordChangedAt: null,
        isVerified: false,
        ...data,
      };
      tables[name].push(row);
      return row;
    },
    findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = tables[name].find((r) => matches(r, where));
      if (!row) return null;
      if (name === 'user' && include?.patientProfile) {
        return { ...row, patientProfile: tables.patientProfile.find((p) => p.userId === row.id) ?? null };
      }
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = tables[name].find((r) => matches(r, where));
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = tables[name].filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const doomed = tables[name].filter((r) => matches(r, where));
      tables[name] = tables[name].filter((r) => !doomed.includes(r));
      if (name === 'user') {
        for (const u of doomed) {
          for (const t of ['emailVerificationToken', 'passwordResetToken', 'refreshToken']) {
            tables[t] = tables[t].filter((r) => r.userId !== u.id);
          }
        }
      }
      return { count: doomed.length };
    },
  });

  const client: any = {
    user: delegate('user'),
    patientProfile: delegate('patientProfile'),
    emailVerificationToken: delegate('emailVerificationToken'),
    passwordResetToken: delegate('passwordResetToken'),
    refreshToken: delegate('refreshToken'),
    auditEvent: delegate('auditEvent'),
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      const snapshot = JSON.stringify(tables, (_k, v) => v);
      const dates = new Map<string, Row[]>();
      for (const [k, v] of Object.entries(tables)) dates.set(k, v.map((r) => ({ ...r })));
      try {
        return await fn(client);
      } catch (err) {
        // Roll back so atomicity assumptions in the adapter are actually exercised.
        for (const [k, v] of dates) tables[k] = v;
        void snapshot;
        throw err;
      }
    },
  };
  return { client: client as PrismaClient, tables };
}

const PASSWORD = 'correct horse battery';

describe('DatabaseAuthProviderAdapter (auth flows, fake Prisma)', () => {
  let tables: ReturnType<typeof createFakePrisma>['tables'];
  let adapter: DatabaseAuthProviderAdapter;
  let sender: MemoryEmailSender;
  let app: ReturnType<typeof createApp>;

  const latestToken = (kind: 'verification' | 'password-reset') =>
    [...sender.outbox].reverse().find((m) => m.kind === kind)!.token;

  async function registerVerified(email: string) {
    await request(app).post('/api/v1/auth/signup').send({ email, password: PASSWORD });
    const verify = await request(app).post('/api/v1/auth/verify-email').send({ token: latestToken('verification') });
    expect(verify.status).toBe(200);
  }

  beforeEach(() => {
    const fake = createFakePrisma();
    tables = fake.tables;
    sender = new MemoryEmailSender();
    adapter = new DatabaseAuthProviderAdapter(fake.client, sender);
    app = createApp({ authAdapter: adapter });
  });

  describe('token storage', () => {
    it('stores only hashes of verification, reset and refresh tokens', async () => {
      await registerVerified('hash@example.com');
      await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'hash@example.com' });
      const login = await request(app).post('/api/v1/auth/login').send({ email: 'hash@example.com', password: PASSWORD });

      const reset = latestToken('password-reset');
      expect(tables.passwordResetToken[0].tokenHash).toBe(hashToken(reset));
      expect(JSON.stringify(tables)).not.toContain(reset);
      expect(JSON.stringify(tables)).not.toContain(login.body.data.session.refreshToken);
    });
  });

  describe('email verification', () => {
    it('signup returns a session only when verification is explicitly turned off', async () => {
      const fake = createFakePrisma();
      const bridgeApp = createApp({
        authAdapter: new DatabaseAuthProviderAdapter(fake.client, sender, false),
      });
      const signup = await request(bridgeApp).post('/api/v1/auth/signup').send({ email: 'bridge@example.com', password: PASSWORD });
      expect(signup.status).toBe(201);
      expect(signup.body.data.requiresVerification).toBe(false);
      expect(signup.body.data.session.accessToken).toBeTruthy();
      expect(fake.tables.emailVerificationToken).toHaveLength(0);
    });

    it('signup issues no session and login is blocked until the email is verified', async () => {
      const signup = await request(app).post('/api/v1/auth/signup').send({ email: 'new@example.com', password: PASSWORD });
      expect(signup.status).toBe(201);
      expect(signup.body.data.requiresVerification).toBe(true);
      expect(signup.body.data.session).toBeUndefined();

      const login = await request(app).post('/api/v1/auth/login').send({ email: 'new@example.com', password: PASSWORD });
      expect(login.status).toBe(403);
      expect(login.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('does not reveal an unverified account to someone with the wrong password', async () => {
      await request(app).post('/api/v1/auth/signup').send({ email: 'pending@example.com', password: PASSWORD });
      const wrong = await request(app).post('/api/v1/auth/login').send({ email: 'pending@example.com', password: 'wrong-password' });
      const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
    });

    it('verification token is single-use', async () => {
      await request(app).post('/api/v1/auth/signup').send({ email: 'once@example.com', password: PASSWORD });
      const token = latestToken('verification');
      expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
      expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(400);
    });

    it('rejects an expired verification token', async () => {
      await request(app).post('/api/v1/auth/signup').send({ email: 'late@example.com', password: PASSWORD });
      tables.emailVerificationToken[0].expiresAt = new Date(Date.now() - 1000);
      const res = await request(app).post('/api/v1/auth/verify-email').send({ token: latestToken('verification') });
      expect(res.status).toBe(400);
      expect(tables.user[0].isVerified).toBe(false);
    });

    it('signup for an existing email returns the same reply as a new email and sends no second mail', async () => {
      const first = await request(app).post('/api/v1/auth/signup').send({ email: 'dup@example.com', password: PASSWORD });
      const second = await request(app).post('/api/v1/auth/signup').send({ email: 'dup@example.com', password: PASSWORD });
      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(tables.user).toHaveLength(1);
      expect(sender.outbox).toHaveLength(1);
    });

    it('resend-verification gives the same reply for unknown, unverified and verified emails', async () => {
      await request(app).post('/api/v1/auth/signup').send({ email: 'unv@example.com', password: PASSWORD });
      await registerVerified('ver@example.com');
      const replies = [];
      for (const email of ['unv@example.com', 'ver@example.com', 'ghost@example.com']) {
        const res = await request(app).post('/api/v1/auth/resend-verification').send({ email });
        replies.push({ status: res.status, body: res.body });
      }
      expect(replies[1]).toEqual(replies[0]);
      expect(replies[2]).toEqual(replies[0]);
    });
  });

  describe('password reset', () => {
    it('unknown email gets the same reply as a known email, and only the known one is mailed', async () => {
      await registerVerified('known@example.com');
      const before = sender.outbox.length;

      const known = await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'known@example.com' });
      const unknown = await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'unknown@example.com' });

      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
      expect(sender.outbox.length - before).toBe(1);
      expect(tables.passwordResetToken).toHaveLength(1);
    });

    it('a failing email provider does not change the reply for a known address', async () => {
      await registerVerified('fail@example.com');
      sender.sendPasswordResetEmail = async () => {
        throw new Error('provider down');
      };
      const res = await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'fail@example.com' });
      expect(res.status).toBe(200);
    });

    it('reset token cannot be reused', async () => {
      await registerVerified('reuse@example.com');
      await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'reuse@example.com' });
      const token = latestToken('password-reset');

      const first = await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'brand new password 1' });
      expect(first.status).toBe(200);

      const second = await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'attacker chosen pass' });
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe('INVALID_TOKEN');

      const attackerLogin = await request(app).post('/api/v1/auth/login').send({ email: 'reuse@example.com', password: 'attacker chosen pass' });
      expect(attackerLogin.status).toBe(401);
      const goodLogin = await request(app).post('/api/v1/auth/login').send({ email: 'reuse@example.com', password: 'brand new password 1' });
      expect(goodLogin.status).toBe(200);
    });

    it('expired reset token is rejected and the password is unchanged', async () => {
      await registerVerified('expire@example.com');
      await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'expire@example.com' });
      const token = latestToken('password-reset');
      tables.passwordResetToken[0].expiresAt = new Date(Date.now() - 1000);

      const res = await request(app).post('/api/v1/auth/reset-password').send({ token, password: 'brand new password 1' });
      expect(res.status).toBe(400);

      const login = await request(app).post('/api/v1/auth/login').send({ email: 'expire@example.com', password: PASSWORD });
      expect(login.status).toBe(200);
    });

    it('a newer reset request invalidates the older link', async () => {
      await registerVerified('two@example.com');
      await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'two@example.com' });
      const older = latestToken('password-reset');
      await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'two@example.com' });

      const res = await request(app).post('/api/v1/auth/reset-password').send({ token: older, password: 'brand new password 1' });
      expect(res.status).toBe(400);
    });

    it('reset ends existing sessions: old refresh tokens and old access tokens stop working', async () => {
      await registerVerified('sess@example.com');
      const login = await request(app).post('/api/v1/auth/login').send({ email: 'sess@example.com', password: PASSWORD });
      const { accessToken, refreshToken } = login.body.data.session;

      // The password-change cut-off has one-second resolution; make sure the old token predates it.
      await new Promise((r) => setTimeout(r, 1100));
      await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'sess@example.com' });
      await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: latestToken('password-reset'), password: 'brand new password 1' });

      const refresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
      expect(refresh.status).toBe(401);
      const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(me.status).toBe(401);
    });
  });

  describe('refresh token rotation', () => {
    it('rotates on every use and returns a working access token', async () => {
      await registerVerified('rot@example.com');
      const login = await request(app).post('/api/v1/auth/login').send({ email: 'rot@example.com', password: PASSWORD });
      const first = login.body.data.session.refreshToken;

      const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first });
      expect(refreshed.status).toBe(200);
      const second = refreshed.body.data.session.refreshToken;
      expect(second).not.toBe(first);

      const me = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${refreshed.body.data.session.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.data.patientProfileId).toBe(login.body.data.session.patientProfileId);
    });

    it('reusing a rotated token is rejected and revokes the whole family', async () => {
      await registerVerified('theft@example.com');
      const login = await request(app).post('/api/v1/auth/login').send({ email: 'theft@example.com', password: PASSWORD });
      const first = login.body.data.session.refreshToken;
      const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first });
      const second = refreshed.body.data.session.refreshToken;

      const replay = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first });
      expect(replay.status).toBe(401);

      // The legitimate holder of the newest token is cut off too.
      const afterTheft = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: second });
      expect(afterTheft.status).toBe(401);
    });

    it('rejects expired and unknown refresh tokens', async () => {
      await registerVerified('old@example.com');
      const login = await request(app).post('/api/v1/auth/login').send({ email: 'old@example.com', password: PASSWORD });
      tables.refreshToken[0].expiresAt = new Date(Date.now() - 1000);

      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.body.data.session.refreshToken })).status).toBe(401);
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'not-a-real-token' })).status).toBe(401);
    });

    it('logout revokes the refresh-token family', async () => {
      await registerVerified('out@example.com');
      const login = await request(app).post('/api/v1/auth/login').send({ email: 'out@example.com', password: PASSWORD });
      const { refreshToken } = login.body.data.session;

      expect((await request(app).post('/api/v1/auth/logout').send({ refreshToken })).status).toBe(200);
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).status).toBe(401);
    });
  });

  describe('account deletion (database adapter)', () => {
    it('removes the user, profile and every token, writes an audit record, and spares other users', async () => {
      await registerVerified('gone@example.com');
      await registerVerified('stays@example.com');
      const login = await request(app).post('/api/v1/auth/login').send({ email: 'gone@example.com', password: PASSWORD });
      await request(app).post('/api/v1/auth/login').send({ email: 'stays@example.com', password: PASSWORD });
      await request(app).post('/api/v1/auth/request-password-reset').send({ email: 'gone@example.com' });
      const goneId = login.body.data.user.id;

      const res = await request(app)
        .delete('/api/v1/auth/account')
        .set('Authorization', `Bearer ${login.body.data.session.accessToken}`);
      expect(res.status).toBe(200);

      expect(tables.user.map((u) => u.email)).toEqual(['stays@example.com']);
      expect(tables.patientProfile.every((p) => p.userId !== goneId)).toBe(true);
      expect(tables.patientProfile).toHaveLength(1);
      for (const t of ['emailVerificationToken', 'passwordResetToken', 'refreshToken']) {
        expect(tables[t].every((r) => r.userId !== goneId)).toBe(true);
      }
      expect(tables.refreshToken.some((r) => r.userId !== goneId)).toBe(true);

      const audit = tables.auditEvent.find((e) => e.action === 'ACCOUNT_DELETED');
      expect(audit).toMatchObject({ userId: goneId, resourceType: 'USER' });
      // Audit rows carry no email, IP, user agent or free text.
      expect(JSON.stringify(audit)).not.toContain('gone@example.com');
      for (const key of ['email', 'ipAddress', 'userAgent', 'details']) {
        expect(audit).not.toHaveProperty(key);
      }

      // The deleted account's access token no longer works, and it cannot log in.
      const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.data.session.accessToken}`);
      expect(me.status).toBe(401);
      const again = await request(app).post('/api/v1/auth/login').send({ email: 'gone@example.com', password: PASSWORD });
      expect(again.status).toBe(401);
    });
  });
});
