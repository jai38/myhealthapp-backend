import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { env, validateProductionConfig } from '../src/config/env.js';
import { PhoneAuthService, ageInYears } from '../src/modules/phone-auth/phone-auth-service.js';
import { InMemoryPhoneAuthStore } from '../src/modules/phone-auth/store.js';
import { MemoryWhatsAppSender, MetaCloudWhatsAppSender, WhatsAppSendError } from '../src/modules/phone-auth/whatsapp-sender.js';
import { normalizeIndianMobile } from '../src/modules/phone-auth/phone.js';
import { KeyedHasher, generateRecoveryCode, normalizeRecoveryCode } from '../src/modules/phone-auth/keyed-hash.js';
import { extractStatuses } from '../src/modules/phone-auth/routes.js';

const API = '/api/v1';
const SECRET = env.OTP_HMAC_SECRET;
// Synthetic numbers only (rule 1).
const NUMBER = '9876500001';
const E164 = '+919876500001';
const OTHER = '9876500002';
const TERMS = 'terms-2026-11';
const CONSENT = 'health-2026-11';

interface World {
  app: Express;
  store: InMemoryPhoneAuthStore;
  sender: MemoryWhatsAppSender;
  service: PhoneAuthService;
  clock: { now: Date };
}

function build(opts: { dailyCap?: number; fixedCode?: string; testNumbers?: string[] } = {}): World {
  const store = new InMemoryPhoneAuthStore();
  const sender = new MemoryWhatsAppSender();
  const clock = { now: new Date('2026-11-22T10:00:00.000Z') };
  const service = new PhoneAuthService({
    store,
    sender,
    hmacSecret: SECRET,
    jwtSecret: env.JWT_SECRET,
    dailyCap: opts.dailyCap ?? 1000,
    fixedCode: opts.fixedCode,
    testNumbers: opts.testNumbers,
    clock: () => clock.now,
  });
  return { app: createApp({ phoneAuthService: service }), store, sender, service, clock };
}

const advance = (w: World, seconds: number) => {
  w.clock.now = new Date(w.clock.now.getTime() + seconds * 1000);
};

const device = (installId: string = crypto.randomUUID(), name = 'Test phone') => ({ installId, name, platform: 'android' as const });

async function requestCode(w: World, phone = NUMBER, installId = crypto.randomUUID(), ip?: string) {
  let r = request(w.app).post(`${API}/auth/otp/request`);
  if (ip) r = r.set('X-Forwarded-For', ip);
  return r.send({ phone, installId, termsVersion: TERMS });
}

async function verify(w: World, requestId: string, code: string, dev = device()) {
  return request(w.app).post(`${API}/auth/otp/verify`).send({ requestId, code, device: dev });
}

/** Requests and verifies a code; returns the sign-in reply's data. */
async function signIn(w: World, phone = NUMBER, dev = device()) {
  const req = await requestCode(w, phone, dev.installId);
  expect(req.status).toBe(200);
  const code = w.sender.lastCodeFor(normalizeIndianMobile(phone)!)!;
  const res = await verify(w, req.body.data.requestId, code, dev);
  expect(res.status).toBe(200);
  advance(w, 31);
  return res.body.data;
}

async function completeAccount(w: World, accessToken: string, overrides: Record<string, unknown> = {}) {
  return request(w.app)
    .put(`${API}/auth/account`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ fullName: 'Asha Test', dateOfBirth: '1990-05-01', gender: 'FEMALE', healthDataConsentVersion: CONSENT, ...overrides });
}

describe('Phase 5: phone sign-in with WhatsApp codes', () => {
  let w: World;
  beforeEach(() => {
    w = build();
  });

  describe('numbers', () => {
    it.each([
      ['9876543210', '+919876543210'],
      ['+91 98765 43210', '+919876543210'],
      ['919876543210', '+919876543210'],
      ['09876543210', '+919876543210'],
      ['98765-43210', '+919876543210'],
    ])('normalises %s', (input, out) => expect(normalizeIndianMobile(input)).toBe(out));

    it.each(['5876543210', '987654321', '+1 4155550100', 'abcdefghij', '', '98765432100'])('refuses %s', (input) =>
      expect(normalizeIndianMobile(input)).toBeNull(),
    );

    it('answers an invalid number with 400 INVALID_PHONE and sends nothing', async () => {
      const res = await requestCode(w, '12345');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PHONE');
      expect(w.sender.sent).toHaveLength(0);
    });
  });

  describe('codes', () => {
    it('stores the code only as a keyed hash, never in plain text', async () => {
      const res = await requestCode(w);
      const code = w.sender.lastCodeFor(E164)!;
      expect(code).toMatch(/^\d{6}$/);
      const row = w.store.otpRequests.get(res.body.data.requestId)!;
      expect(row.codeHmac).toBe(new KeyedHasher(SECRET).hash('code', code));
      expect(row.codeHmac).not.toBe(crypto.createHash('sha256').update(code).digest('hex'));
      const stored = JSON.stringify([...w.store.otpRequests.values()]);
      expect(stored).not.toContain(`"${code}"`);
      // Rate-limit keys are keyed hashes too.
      expect(row.phoneHmac).toBe(new KeyedHasher(SECRET).hash('phone', E164));
      expect(row.phoneHmac).not.toContain('9876500001');
    });

    it('answers with the contract shape', async () => {
      const res = await requestCode(w);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        codeLength: 6,
        expiresInSeconds: 600,
        resendAfterSeconds: 30,
        channel: 'WHATSAPP',
      });
    });

    it('a used code fails', async () => {
      const req = await requestCode(w);
      const code = w.sender.lastCodeFor(E164)!;
      expect((await verify(w, req.body.data.requestId, code)).status).toBe(200);
      const again = await verify(w, req.body.data.requestId, code);
      expect(again.status).toBe(410);
      expect(again.body.error.code).toBe('CODE_EXPIRED');
    });

    it('an expired code fails', async () => {
      const req = await requestCode(w);
      const code = w.sender.lastCodeFor(E164)!;
      advance(w, 601);
      const res = await verify(w, req.body.data.requestId, code);
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('CODE_EXPIRED');
    });

    it('a resend cancels the old code', async () => {
      const first = await requestCode(w);
      const oldCode = w.sender.lastCodeFor(E164)!;
      advance(w, 31);
      const second = await requestCode(w);
      const newCode = w.sender.lastCodeFor(E164)!;
      expect((await verify(w, first.body.data.requestId, oldCode)).status).toBe(410);
      expect((await verify(w, second.body.data.requestId, newCode)).status).toBe(200);
    });

    it('refuses the fourth attempt after three wrong codes, even with the right code', async () => {
      const req = await requestCode(w);
      const code = w.sender.lastCodeFor(E164)!;
      const wrong = code === '000000' ? '111111' : '000000';
      const r1 = await verify(w, req.body.data.requestId, wrong);
      const r2 = await verify(w, req.body.data.requestId, wrong);
      const r3 = await verify(w, req.body.data.requestId, wrong);
      expect([r1.status, r1.body.error.details]).toEqual([400, { attemptsLeft: 2 }]);
      expect([r2.status, r2.body.error.details]).toEqual([400, { attemptsLeft: 1 }]);
      expect(r3.status).toBe(429);
      expect(r3.body.error.code).toBe('LOCKED');
      const fourth = await verify(w, req.body.data.requestId, code);
      expect(fourth.status).toBe(429);
      expect(fourth.body.error.code).toBe('LOCKED');
      expect(w.store.users.size).toBe(0);
    });

    it('a fixed code works only for listed test numbers', async () => {
      const t = build({ fixedCode: '123456', testNumbers: [E164] });
      const listed = await requestCode(t);
      expect(t.sender.sent).toHaveLength(0);
      expect((await verify(t, listed.body.data.requestId, '123456')).status).toBe(200);
      const other = await requestCode(t, OTHER);
      expect(t.sender.sent).toHaveLength(1);
      // An unlisted number gets a real random code, so the fixed code fails (unless chance picked it).
      const res = await verify(t, other.body.data.requestId, '123456');
      if (t.sender.lastCodeFor('+919876500002') !== '123456') expect(res.status).toBe(400);
    });
  });

  describe('limits', () => {
    it('refuses a resend sooner than 30 seconds', async () => {
      await requestCode(w);
      advance(w, 10);
      const res = await requestCode(w);
      expect(res.status).toBe(429);
      expect(res.body.error.details).toEqual({ reason: 'RESEND_TOO_SOON', retryAfterSeconds: 20 });
      expect(res.headers['retry-after']).toBe('20');
    });

    it('refuses the fourth resend inside the 10-minute window, then allows one after it', async () => {
      for (let i = 0; i < 4; i++) {
        expect((await requestCode(w)).status).toBe(200);
        advance(w, 31);
      }
      const fifth = await requestCode(w);
      expect(fifth.status).toBe(429);
      expect(fifth.body.error.details.reason).toBe('TOO_MANY_CODES');
      advance(w, fifth.body.error.details.retryAfterSeconds);
      expect((await requestCode(w)).status).toBe(200);
    });

    it('limits per device (install id) across numbers', async () => {
      const installId = crypto.randomUUID();
      for (let i = 0; i < 10; i++) expect((await requestCode(w, `98765100${String(i).padStart(2, '0')}`, installId)).status).toBe(200);
      const res = await requestCode(w, '9876510099', installId);
      expect(res.status).toBe(429);
      expect(res.body.error.details.reason).toBe('TOO_MANY_CODES');
    });

    it('limits per IP across numbers and devices, using the address API Gateway appended', async () => {
      for (let i = 0; i < 20; i++) {
        expect((await requestCode(w, `98765200${String(i).padStart(2, '0')}`, crypto.randomUUID(), `1.1.1.${i}, 203.0.113.7`)).status).toBe(200);
      }
      const res = await requestCode(w, '9876520099', crypto.randomUUID(), '9.9.9.9, 203.0.113.7');
      expect(res.status).toBe(429);
      // A different real address is not affected.
      expect((await requestCode(w, '9876520098', crypto.randomUUID(), '203.0.113.8')).status).toBe(200);
    });

    it('stops at the daily cap for the whole service', async () => {
      const t = build({ dailyCap: 2 });
      expect((await requestCode(t, '9876530001')).status).toBe(200);
      expect((await requestCode(t, '9876530002')).status).toBe(200);
      const res = await requestCode(t, '9876530003');
      expect(res.status).toBe(429);
      expect(res.body.error.details.reason).toBe('DAILY_LIMIT');
      expect(t.sender.sent).toHaveLength(2);
    });
  });

  describe('same answer for known and unknown numbers', () => {
    it('the request call does not reveal who has an account', async () => {
      await signIn(w, NUMBER);
      const known = await requestCode(w, NUMBER);
      const unknown = await requestCode(w, OTHER);
      const strip = (b: any) => ({ ...b, data: { ...b.data, requestId: 'x' } });
      expect(known.status).toBe(unknown.status);
      expect(strip(known.body)).toEqual(strip(unknown.body));
      expect(Object.keys(known.headers).sort()).toEqual(Object.keys(unknown.headers).sort());
    });
  });

  describe('accounts', () => {
    it('creates an account on first verify, records the terms, and gates health data until S03', async () => {
      const s = await signIn(w);
      expect(s).toMatchObject({ status: 'SIGNED_IN', isNewUser: true, profileComplete: false, needsSecondFactor: false });
      const user = [...w.store.users.values()][0]!;
      expect(w.store.consents).toEqual([{ userId: user.id, kind: 'TERMS', version: TERMS, acceptedAt: expect.any(Date) }]);

      const me = await request(w.app).get(`${API}/auth/me`).set('Authorization', `Bearer ${s.accessToken}`);
      expect(me.body.data).toEqual({ userId: user.id, patientProfileId: user.patientProfileId, phone: E164, profileComplete: false });

      const meds = await request(w.app).get(`${API}/medications`).set('Authorization', `Bearer ${s.accessToken}`);
      expect(meds.status).toBe(403);
      expect(meds.body.error.code).toBe('ACCOUNT_INCOMPLETE');

      expect((await completeAccount(w, s.accessToken)).status).toBe(200);
      expect(w.store.consents.map((c) => c.kind)).toEqual(['TERMS', 'HEALTH_DATA']);

      const after = await request(w.app).get(`${API}/auth/me`).set('Authorization', `Bearer ${s.accessToken}`);
      expect(after.body.data).toMatchObject({ fullName: 'Asha Test', profileComplete: true, phone: E164 });
      expect(after.body.data).not.toHaveProperty('email');
      expect((await request(w.app).get(`${API}/medications`).set('Authorization', `Bearer ${s.accessToken}`)).status).toBe(200);
    });

    it('a second sign-in on the same device is not a new user and needs no second factor', async () => {
      const dev = device();
      await signIn(w, NUMBER, dev);
      const again = await signIn(w, NUMBER, dev);
      expect(again).toMatchObject({ status: 'SIGNED_IN', isNewUser: false });
      expect(w.store.users.size).toBe(1);
    });

    it('refuses under 18 (P4) and stores nothing', async () => {
      const s = await signIn(w);
      const res = await completeAccount(w, s.accessToken, { dateOfBirth: '2010-01-01' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('UNDER_18');
      const profile = [...w.store.profiles.values()][0]!;
      expect(profile).toMatchObject({ dateOfBirth: null, profileCompletedAt: null, fullName: 'Patient Profile' });
      expect(w.store.consents.map((c) => c.kind)).toEqual(['TERMS']);
    });

    it('needs a self-description only for SELF_DESCRIBE, and refuses a future date of birth', async () => {
      const s = await signIn(w);
      expect((await completeAccount(w, s.accessToken, { gender: 'SELF_DESCRIBE' })).status).toBe(400);
      expect((await completeAccount(w, s.accessToken, { dateOfBirth: '2030-01-01' })).status).toBe(400);
      expect((await completeAccount(w, s.accessToken, { gender: 'SELF_DESCRIBE', genderSelfDescription: 'Testing' })).status).toBe(200);
    });

    it('works out age in whole years', () => {
      const now = new Date('2026-11-22T00:00:00Z');
      expect(ageInYears('2008-11-22', now)).toBe(18);
      expect(ageInYears('2008-11-23', now)).toBe(17);
      expect(ageInYears('2026-02-30', now)).toBeNull();
    });
  });

  describe('sessions', () => {
    it('access tokens last 15 minutes', async () => {
      const s = await signIn(w);
      const decoded = jwt.decode(s.accessToken) as { exp: number; iat: number; typ: string };
      expect(decoded.exp - decoded.iat).toBe(15 * 60);
      expect(decoded.typ).toBe('phone');
    });

    it('a reused refresh token revokes the whole family', async () => {
      const s = await signIn(w);
      const r1 = await request(w.app).post(`${API}/auth/refresh`).send({ refreshToken: s.refreshToken });
      expect(r1.status).toBe(200);
      const next = r1.body.data.session.refreshToken;
      expect(next).not.toBe(s.refreshToken);

      const reuse = await request(w.app).post(`${API}/auth/refresh`).send({ refreshToken: s.refreshToken });
      expect(reuse.status).toBe(401);
      const afterTheft = await request(w.app).post(`${API}/auth/refresh`).send({ refreshToken: next });
      expect(afterTheft.status).toBe(401);
      expect(w.store.auditEvents.map((e) => e.action)).toContain('REFRESH_TOKEN_REUSE_DETECTED');
    });

    it('lists devices and revokes one; its tokens stop working at once', async () => {
      const a = await signIn(w, NUMBER, device(undefined, 'Phone one'));
      const b = await signIn(w, NUMBER, device(undefined, 'Phone two'));
      const list = await request(w.app).get(`${API}/auth/devices`).set('Authorization', `Bearer ${a.accessToken}`);
      expect(list.body.data.map((d: any) => [d.name, d.current])).toEqual(
        expect.arrayContaining([['Phone one', true], ['Phone two', false]]),
      );

      const del = await request(w.app).delete(`${API}/auth/devices/${b.deviceId}`).set('Authorization', `Bearer ${a.accessToken}`);
      expect(del.status).toBe(200);
      expect((await request(w.app).get(`${API}/auth/me`).set('Authorization', `Bearer ${b.accessToken}`)).status).toBe(401);
      expect((await request(w.app).post(`${API}/auth/refresh`).send({ refreshToken: b.refreshToken })).status).toBe(401);
      expect((await request(w.app).get(`${API}/auth/me`).set('Authorization', `Bearer ${a.accessToken}`)).status).toBe(200);
    });

    it("another user's device is 404, never 403 (rule 4)", async () => {
      const a = await signIn(w, NUMBER);
      const b = await signIn(w, OTHER);
      const res = await request(w.app).delete(`${API}/auth/devices/${b.deviceId}`).set('Authorization', `Bearer ${a.accessToken}`);
      expect(res.status).toBe(404);
      expect((await request(w.app).get(`${API}/auth/me`).set('Authorization', `Bearer ${b.accessToken}`)).status).toBe(200);
    });

    it("identity comes from the token: a phone user can't read another patient's medication", async () => {
      const a = await signIn(w, NUMBER);
      const b = await signIn(w, OTHER);
      await completeAccount(w, a.accessToken);
      await completeAccount(w, b.accessToken, { fullName: 'Ravi Test' });
      const created = await request(w.app)
        .post(`${API}/medications`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ nameAsWritten: 'Testmed A 500 mg', patientProfileId: 'ignored' });
      expect(created.status).toBe(201);
      const userA = [...w.store.users.values()].find((u) => u.phoneE164 === E164)!;
      expect(created.body.data.patientProfileId).toBe(userA.patientProfileId);
      const cross = await request(w.app).get(`${API}/medications/${created.body.data.id}`).set('Authorization', `Bearer ${b.accessToken}`);
      expect(cross.status).toBe(404);
    });

    it('a phone token that fails its own check never falls through to another verifier', async () => {
      const forged = jwt.sign({ typ: 'phone', userId: crypto.randomUUID(), patientProfileId: crypto.randomUUID(), did: crypto.randomUUID() }, env.JWT_SECRET, { expiresIn: 60 });
      expect((await request(w.app).get(`${API}/auth/me`).set('Authorization', `Bearer ${forged}`)).status).toBe(401);
      const s = await signIn(w);
      const { userId, patientProfileId, did } = jwt.decode(s.accessToken) as Record<string, string>;
      const expired = jwt.sign({ typ: 'phone', userId, patientProfileId, did, exp: Math.floor(Date.now() / 1000) - 10 }, env.JWT_SECRET);
      expect((await request(w.app).get(`${API}/auth/me`).set('Authorization', `Bearer ${expired}`)).status).toBe(401);
    });

    it('logout revokes the phone session', async () => {
      const s = await signIn(w);
      expect((await request(w.app).post(`${API}/auth/logout`).send({ refreshToken: s.refreshToken })).status).toBe(200);
      expect((await request(w.app).post(`${API}/auth/refresh`).send({ refreshToken: s.refreshToken })).status).toBe(401);
    });
  });

  describe('new device (P2) and recovery code (P3)', () => {
    async function withRecoveryCode() {
      const first = await signIn(w, NUMBER, device(undefined, 'Old phone'));
      const rc = await request(w.app).post(`${API}/auth/recovery-code`).set('Authorization', `Bearer ${first.accessToken}`);
      expect(rc.status).toBe(201);
      expect(rc.headers['cache-control']).toBe('no-store');
      return { first, code: rc.body.data.recoveryCode as string };
    }

    it('makes a 16-character code in four groups and stores only its keyed hash', async () => {
      const { code } = await withRecoveryCode();
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/);
      const user = [...w.store.users.values()][0]!;
      expect(user.recoveryCodeHmac).toBe(new KeyedHasher(SECRET).hash('recovery', normalizeRecoveryCode(code)!));
      expect(JSON.stringify([...w.store.users.values()])).not.toContain(code.replace(/-/g, ''));
    });

    it('asks a new device for the recovery code, then signs in and uses the code up', async () => {
      const { code } = await withRecoveryCode();
      const req = await requestCode(w);
      const res = await verify(w, req.body.data.requestId, w.sender.lastCodeFor(E164)!, device(undefined, 'New phone'));
      expect(res.body.data).toEqual({
        status: 'SECOND_FACTOR_REQUIRED',
        needsSecondFactor: true,
        secondFactorToken: expect.any(String),
        methods: ['RECOVERY_CODE'],
        expiresInSeconds: 600,
        withoutCode: 'CONTACT_SUPPORT',
      });
      expect(res.body.data).not.toHaveProperty('accessToken');
      const token = res.body.data.secondFactorToken;

      const wrong = await request(w.app).post(`${API}/auth/second-factor`).send({ secondFactorToken: token, recoveryCode: 'AAAA-BBBB-CCCC-DDDD' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toMatchObject({ code: 'WRONG_RECOVERY_CODE', details: { attemptsLeft: 4 } });

      const ok = await request(w.app)
        .post(`${API}/auth/second-factor`)
        .send({ secondFactorToken: token, recoveryCode: code.toLowerCase().replace(/-/g, ' ') });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ status: 'SIGNED_IN', recoveryCodeUsed: true, isNewUser: false });
      expect([...w.store.users.values()][0]!.recoveryCodeHmac).toBeNull();

      // The challenge works once.
      const replay = await request(w.app).post(`${API}/auth/second-factor`).send({ secondFactorToken: token, recoveryCode: code });
      expect(replay.status).toBe(410);
    });

    it('locks the challenge after five wrong recovery codes', async () => {
      const { code } = await withRecoveryCode();
      const req = await requestCode(w);
      const res = await verify(w, req.body.data.requestId, w.sender.lastCodeFor(E164)!, device());
      const token = res.body.data.secondFactorToken;
      for (let i = 0; i < 4; i++) {
        await request(w.app).post(`${API}/auth/second-factor`).send({ secondFactorToken: token, recoveryCode: 'AAAA-BBBB-CCCC-DDDD' });
      }
      const fifth = await request(w.app).post(`${API}/auth/second-factor`).send({ secondFactorToken: token, recoveryCode: 'AAAA-BBBB-CCCC-DDDD' });
      expect(fifth.status).toBe(429);
      const right = await request(w.app).post(`${API}/auth/second-factor`).send({ secondFactorToken: token, recoveryCode: code });
      expect(right.status).toBe(429);
    });

    it('hides records on a new device after 90 days unused when the account has no recovery code', async () => {
      await signIn(w, NUMBER, device(undefined, 'Old phone'));
      advance(w, 90 * 24 * 60 * 60);
      const req = await requestCode(w);
      const res = await verify(w, req.body.data.requestId, w.sender.lastCodeFor(E164)!, device(undefined, 'Someone new'));
      expect(res.body.data).toEqual({ status: 'SUPPORT_REQUIRED', needsSecondFactor: false });
      expect(w.store.devices.size).toBe(1);
      expect(w.store.auditEvents.map((e) => e.action)).toContain('NEW_DEVICE_SUPPORT_HOLD');
    });

    it('lets a new device in with the code alone when the account was used recently and has no recovery code', async () => {
      await signIn(w, NUMBER, device(undefined, 'Old phone'));
      advance(w, 89 * 24 * 60 * 60);
      const s = await signIn(w, NUMBER, device(undefined, 'New phone'));
      expect(s.status).toBe('SIGNED_IN');
    });

    it('tells the app that "no code" means records hidden for an inactive account', async () => {
      await withRecoveryCode();
      advance(w, 91 * 24 * 60 * 60);
      const req = await requestCode(w);
      const res = await verify(w, req.body.data.requestId, w.sender.lastCodeFor(E164)!, device());
      expect(res.body.data.withoutCode).toBe('RECORDS_HIDDEN');
    });

    it('recovery-code normalising', () => {
      expect(normalizeRecoveryCode('k7qf 29xd-m4pl8rwc')).toBe('K7QF29XDM4PL8RWC');
      expect(normalizeRecoveryCode('short')).toBeNull();
      expect(generateRecoveryCode()).toHaveLength(19);
    });
  });

  describe('delivery and the Meta webhook', () => {
    const APP_SECRET = 'test-app-secret';
    function hookApp() {
      const store = new InMemoryPhoneAuthStore();
      const sender = new MemoryWhatsAppSender();
      const service = new PhoneAuthService({ store, sender, hmacSecret: SECRET, jwtSecret: env.JWT_SECRET, dailyCap: 100 });
      const prev = { s: env.META_APP_SECRET, v: env.META_WEBHOOK_VERIFY_TOKEN };
      (env as any).META_APP_SECRET = APP_SECRET;
      (env as any).META_WEBHOOK_VERIFY_TOKEN = 'verify-me';
      const app = createApp({ phoneAuthService: service });
      (env as any).META_APP_SECRET = prev.s;
      (env as any).META_WEBHOOK_VERIFY_TOKEN = prev.v;
      return { app, sender };
    }
    const sign = (body: string) => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
    const failedPayload = (id: string, code: number) =>
      JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id, status: 'failed', errors: [{ code }] }] } }] }] });

    it('reports "no WhatsApp" when Meta says so later', async () => {
      const { app, sender } = hookApp();
      const req = await request(app).post(`${API}/auth/otp/request`).send({ phone: NUMBER, installId: crypto.randomUUID(), termsVersion: TERMS });
      const id = req.body.data.requestId;
      expect((await request(app).get(`${API}/auth/otp/request/${id}`)).body.data).toEqual({ delivery: 'SENT' });

      const body = failedPayload(sender.sent[0]!.providerMessageId, 131026);
      const hook = await request(app).post(`${API}/webhooks/whatsapp`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(body)).send(body);
      expect(hook.status).toBe(200);
      expect((await request(app).get(`${API}/auth/otp/request/${id}`)).body.data).toEqual({ delivery: 'WHATSAPP_UNAVAILABLE' });
    });

    it('refuses a webhook with a bad or missing signature and changes nothing', async () => {
      const { app, sender } = hookApp();
      const req = await request(app).post(`${API}/auth/otp/request`).send({ phone: NUMBER, installId: crypto.randomUUID(), termsVersion: TERMS });
      const body = failedPayload(sender.sent[0]!.providerMessageId, 131026);
      const bad = await request(app).post(`${API}/webhooks/whatsapp`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=00').send(body);
      expect(bad.status).toBe(401);
      expect((await request(app).post(`${API}/webhooks/whatsapp`).set('Content-Type', 'application/json').send(body)).status).toBe(401);
      expect((await request(app).get(`${API}/auth/otp/request/${req.body.data.requestId}`)).body.data.delivery).toBe('SENT');
    });

    it("answers Meta's verification only with the right token", async () => {
      const { app } = hookApp();
      const ok = await request(app).get(`${API}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' });
      expect([ok.status, ok.text]).toEqual([200, '12345']);
      const no = await request(app).get(`${API}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '12345' });
      expect(no.status).toBe(403);
    });

    it('maps Meta statuses', () => {
      const p = { entry: [{ changes: [{ value: { statuses: [
        { id: 'a', status: 'sent' }, { id: 'b', status: 'delivered' }, { id: 'c', status: 'read' },
        { id: 'd', status: 'failed', errors: [{ code: 131026 }] }, { id: 'e', status: 'failed', errors: [{ code: 131000 }] },
      ] } }] }] };
      expect(extractStatuses(p)).toEqual([
        { id: 'a', delivery: 'SENT' }, { id: 'b', delivery: 'DELIVERED' }, { id: 'c', delivery: 'DELIVERED' },
        { id: 'd', delivery: 'WHATSAPP_UNAVAILABLE' }, { id: 'e', delivery: 'FAILED' },
      ]);
    });

    it('a send failure gives the same reply, and the status call reports it', async () => {
      w.sender.failNextSend = true;
      const res = await requestCode(w);
      expect(res.status).toBe(200);
      expect((await request(w.app).get(`${API}/auth/otp/request/${res.body.data.requestId}`)).body.data.delivery).toBe('FAILED');
    });

    it('the Meta sender sends the authentication template with the code and maps 131026', async () => {
      const calls: any[] = [];
      const ok = new MetaCloudWhatsAppSender({
        token: 't', phoneNumberId: '111', templateName: 'ayoreni_code', templateLanguage: 'en', graphApiVersion: 'v23.0',
        fetchImpl: (async (url: string, init: any) => {
          calls.push({ url, init });
          return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 });
        }) as any,
      });
      expect(await ok.sendCode('+919876500001', '123456')).toEqual({ providerMessageId: 'wamid.X' });
      expect(calls[0].url).toBe('https://graph.facebook.com/v23.0/111/messages');
      expect(calls[0].init.headers.Authorization).toBe('Bearer t');
      const body = JSON.parse(calls[0].init.body);
      expect(body).toMatchObject({ to: '919876500001', type: 'template', template: { name: 'ayoreni_code', language: { code: 'en' } } });
      expect(body.template.components[0].parameters[0].text).toBe('123456');

      const unavailable = new MetaCloudWhatsAppSender({
        token: 't', phoneNumberId: '111', templateName: 'x', templateLanguage: 'en', graphApiVersion: 'v23.0',
        fetchImpl: (async () => new Response(JSON.stringify({ error: { code: 131026 } }), { status: 400 })) as any,
      });
      await expect(unavailable.sendCode('+919876500001', '123456')).rejects.toEqual(new WhatsAppSendError('UNAVAILABLE'));
    });
  });

  describe('no numbers, codes or names in logs', () => {
    const lines: string[] = [];
    let spies: Array<{ mockRestore: () => void }> = [];
    beforeEach(() => {
      lines.length = 0;
      const capture = (...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      };
      spies = [
        vi.spyOn(console, 'log').mockImplementation(capture),
        vi.spyOn(console, 'info').mockImplementation(capture),
        vi.spyOn(console, 'warn').mockImplementation(capture),
        vi.spyOn(console, 'error').mockImplementation(capture),
        vi.spyOn(console, 'debug').mockImplementation(capture),
        vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => (capture(String(chunk)), true)) as any),
        vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => (capture(String(chunk)), true)) as any),
      ];
    });
    afterEach(() => spies.forEach((s) => s.mockRestore()));

    it('across request, wrong code, verify, account, recovery code, second factor and refresh', async () => {
      const first = await signIn(w);
      await completeAccount(w, first.accessToken, { email: 'asha@seed.ayoreni.test' });
      const rc = await request(w.app).post(`${API}/auth/recovery-code`).set('Authorization', `Bearer ${first.accessToken}`);
      const req = await requestCode(w);
      const code = w.sender.lastCodeFor(E164)!;
      await verify(w, req.body.data.requestId, code === '000000' ? '111111' : '000000');
      const v = await verify(w, req.body.data.requestId, code, device());
      await request(w.app).post(`${API}/auth/second-factor`).send({ secondFactorToken: v.body.data.secondFactorToken, recoveryCode: rc.body.data.recoveryCode });
      await request(w.app).post(`${API}/auth/refresh`).send({ refreshToken: first.refreshToken });
      await requestCode(w, '12345');

      const planted = ['9876500001', '98765 00001', 'Asha Test', 'asha@seed.ayoreni.test', code, rc.body.data.recoveryCode];
      const text = lines.join('\n');
      for (const p of planted) expect(text).not.toContain(p);
    });

    it('audit records hold ids, action codes and times only', async () => {
      const s = await signIn(w);
      await completeAccount(w, s.accessToken);
      for (const e of w.store.auditEvents) {
        expect(Object.keys(e).sort()).toEqual(['action', 'createdAt', 'resourceId', 'resourceType', 'userId']);
        expect(JSON.stringify(e)).not.toMatch(/9876500001|Asha/);
      }
    });
  });

  describe('when the sender is disabled (production before Meta approval)', () => {
    it('answers 503 OTP_UNAVAILABLE', async () => {
      const app = createApp({
        phoneAuthService: new PhoneAuthService({
          store: new InMemoryPhoneAuthStore(),
          sender: new (await import('../src/modules/phone-auth/whatsapp-sender.js')).DisabledWhatsAppSender(),
          hmacSecret: SECRET,
          jwtSecret: env.JWT_SECRET,
          dailyCap: 10,
        }),
      });
      const res = await request(app).post(`${API}/auth/otp/request`).send({ phone: NUMBER, installId: crypto.randomUUID(), termsVersion: TERMS });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('OTP_UNAVAILABLE');
    });
  });
});

describe('validateProductionConfig refuses phone sign-in fakes', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://produser:securepassword@prod-db.internal:5432/myhealthapp_prod',
    AUTH_PROVIDER: 'node-internal',
    JWT_SECRET: 'a-very-long-production-jwt-secret-with-plenty-of-entropy-32chars',
    EMAIL_VERIFICATION_REQUIRED: false,
    EXTRACTION_MODE: 'inline',
    AI_EXTRACTION_PROVIDER: 'auto',
    AI_PROVIDER_APPROVED: false,
    WHATSAPP_SENDER: 'disabled',
    OTP_HMAC_SECRET: 'another-long-random-secret-for-keyed-hashes-32+',
  } as any;
  const storage = { STORAGE_BUCKET: 'bucket-name' };
  const meta = {
    WHATSAPP_SENDER: 'meta',
    META_WHATSAPP_TOKEN: 'token',
    META_WHATSAPP_PHONE_NUMBER_ID: '111',
    META_WHATSAPP_TEMPLATE_NAME: 'ayoreni_code',
    META_APP_SECRET: 'app-secret',
    META_WEBHOOK_VERIFY_TOKEN: 'verify',
  };

  it('accepts the sender switched off, and a fully set Meta sender', () => {
    expect(() => validateProductionConfig(base, storage)).not.toThrow();
    expect(() => validateProductionConfig({ ...base, ...meta }, storage)).not.toThrow();
  });

  it.each([
    ['the memory (fake) sender', { WHATSAPP_SENDER: 'memory' }, /WHATSAPP_SENDER/],
    ['a fixed code', { OTP_FIXED_CODE: '123456' }, /OTP_FIXED_CODE/],
    ['a test-number allowlist', { OTP_TEST_NUMBERS: '+919876500001' }, /OTP_TEST_NUMBERS/],
    ['the development keyed-hash secret', { ...meta, OTP_HMAC_SECRET: 'dev-insecure-otp-hmac-secret-replace-in-production' }, /OTP_HMAC_SECRET/],
    ['the keyed-hash secret equal to the JWT secret', { ...meta, OTP_HMAC_SECRET: base.JWT_SECRET }, /OTP_HMAC_SECRET must differ/],
    ['Meta without its app secret', { ...meta, META_APP_SECRET: '' }, /META_APP_SECRET/],
    ['Meta with a placeholder token', { ...meta, META_WHATSAPP_TOKEN: 'REPLACE_ME_BY_OWNER' }, /META_WHATSAPP_TOKEN/],
  ])('refuses %s', (_label, change, message) => {
    expect(() => validateProductionConfig({ ...base, ...change }, storage)).toThrow(message);
  });
});
