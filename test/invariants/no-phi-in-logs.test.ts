/**
 * Invariant 7: no PHI in logs or audit records. IDs, action codes and timestamps only.
 *
 * Strategy: plant recognisable fake health strings (drug, doctor, diagnosis, clinic, filename,
 * notes, instructions, a patient name and an email) into every write path, run complete flows
 * including failures, and assert the strings never appear in anything the process wrote to
 * console or to stdout/stderr, nor in any audit row.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { DatabaseAuthProviderAdapter } from '../../src/modules/auth/auth-adapter.js';
import { MemoryEmailSender } from '../../src/modules/auth/email-service.js';
import { createFakePrisma } from './fake-prisma.js';
import {
  API,
  TOKEN_A,
  TOKEN_B,
  PLANTED,
  buildWorld,
  seedPatientA,
  reviewBody,
  uploadDocument,
  PATIENT_A,
} from './helpers.js';

const PLANTED_NAME = 'Plantedperson Wobblesworth';
const PLANTED_EMAIL = 'planted.person.wobblesworth@example.com';
const PASSWORD = 'correct horse battery';

const ALL_PLANTED: string[] = [...Object.values(PLANTED), PLANTED_NAME, PLANTED_EMAIL, 'Manual-Planted-Med'];

/** Captures everything written through console.* and process.stdout/stderr. */
function startCapture() {
  const lines: string[] = [];
  const originals = {
    log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug,
    out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr),
  };
  const fmt = (args: unknown[]) =>
    args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    (console as any)[level] = (...args: unknown[]) => { lines.push(`[console.${level}] ${fmt(args)}`); };
  }
  // Only record writes that are not vitest's own reporter output.
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => { lines.push(`[stdout] ${String(chunk)}`); return originals.out(chunk, ...rest); };
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => { lines.push(`[stderr] ${String(chunk)}`); return originals.err(chunk, ...rest); };
  return {
    lines,
    stop() {
      console.log = originals.log; console.info = originals.info; console.warn = originals.warn;
      console.error = originals.error; console.debug = originals.debug;
      (process.stdout as any).write = originals.out; (process.stderr as any).write = originals.err;
    },
  };
}

const leaks = (lines: string[]) =>
  lines.flatMap((l) => ALL_PLANTED.filter((p) => l.includes(p)).map((p) => `${p} in ${l.slice(0, 120)}`));

describe('Invariant: no health data in logs', () => {
  it('a full patient journey, including failures, writes none of the planted strings', async () => {
    const cap = startCapture();
    let sawOutput = false;
    try {
      const w = buildWorld();
      const a = await seedPatientA(w); // planted drug, doctor, diagnosis, clinic, instructions, filename

      // Dose notes and manual medication with planted text
      await request(w.app).post(`${API}/medications/doses/${a.doseId}/action`).set('Authorization', TOKEN_A)
        .send({ action: 'TAKEN', notes: PLANTED.note });
      await request(w.app).post(`${API}/medications`).set('Authorization', TOKEN_A)
        .send({ nameAsWritten: 'Manual-Planted-Med', notes: PLANTED.note, prescribedInstructions: PLANTED.instructions });
      await request(w.app).post(`${API}/medications/${a.manualMedicationId}/discontinue`).set('Authorization', TOKEN_A)
        .send({ reason: PLANTED.note });
      await request(w.app).post(`${API}/reports/generate`).set('Authorization', TOKEN_A)
        .send({ title: PLANTED.diagnosis, includeTimeline: true, includeMedications: true });

      // Failure paths with planted text in the payload
      await request(w.app).post(`${API}/prescriptions/${a.jobId}/confirm`).set('Authorization', TOKEN_A).send(reviewBody());
      await request(w.app).post(`${API}/prescriptions/${a.jobId}/confirm`).set('Authorization', TOKEN_B).send(reviewBody());
      await request(w.app).post(`${API}/prescriptions/${a.queuedJobId}/confirm`).set('Authorization', TOKEN_A)
        .send({ medicines: [{ name_as_written: PLANTED.drug, dosage_form: 'NOT_A_FORM' }] });
      await request(w.app).post(`${API}/medications/doses/${a.doseId}/action`).set('Authorization', TOKEN_A)
        .send({ action: 'BOGUS', notes: PLANTED.note });
      await request(w.app).post(`${API}/documents/confirm-upload`).set('Authorization', TOKEN_B)
        .send({ storageKey: `documents/${PATIENT_A}/${PLANTED.filename}` });
      await request(w.app).get(`${API}/timeline?search=${encodeURIComponent(PLANTED.drug)}&limit=9999`).set('Authorization', TOKEN_A);
      await uploadDocument(w, TOKEN_A, PATIENT_A, PLANTED.filename);

      // A forced 500 whose error message contains PHI must still not be logged.
      const throwing = createApp({
        timelineService: { getTimeline: async () => { throw new Error(`boom ${PLANTED.drug} ${PLANTED.diagnosis}`); } } as any,
      });
      await request(throwing).get(`${API}/timeline`).set('Authorization', TOKEN_A);

      sawOutput = true;
    } finally {
      cap.stop();
    }
    expect(sawOutput).toBe(true);
    expect(leaks(cap.lines)).toEqual([]);
  });

  it('auth flows (signup, verify, login, reset, delete) log no email, name or token', async () => {
    const cap = startCapture();
    const fake = createFakePrisma();
    const sender = new MemoryEmailSender();
    const adapter = new DatabaseAuthProviderAdapter(fake.client, sender);
    const app = createApp({ authAdapter: adapter });
    const tokens: string[] = [];
    try {
      await request(app).post(`${API}/auth/signup`).send({ email: PLANTED_EMAIL, password: PASSWORD, fullName: PLANTED_NAME });
      await request(app).post(`${API}/auth/signup`).send({ email: PLANTED_EMAIL, password: PASSWORD, fullName: PLANTED_NAME });
      const ver = [...sender.outbox].reverse().find((m) => m.kind === 'verification')!.token;
      tokens.push(ver);
      await request(app).post(`${API}/auth/verify-email`).send({ token: ver });
      await request(app).post(`${API}/auth/login`).send({ email: PLANTED_EMAIL, password: 'wrong-password' });
      const login = await request(app).post(`${API}/auth/login`).send({ email: PLANTED_EMAIL, password: PASSWORD });
      tokens.push(login.body.data.session.accessToken, login.body.data.session.refreshToken);
      await request(app).post(`${API}/auth/request-password-reset`).send({ email: PLANTED_EMAIL });
      const reset = [...sender.outbox].reverse().find((m) => m.kind === 'password-reset')!.token;
      tokens.push(reset);
      await request(app).post(`${API}/auth/reset-password`).send({ token: reset, password: 'another long password' });
      await request(app).post(`${API}/auth/refresh`).send({ refreshToken: login.body.data.session.refreshToken });
      await request(app).delete(`${API}/auth/account`).set('Authorization', `Bearer ${login.body.data.session.accessToken}`);
    } finally {
      cap.stop();
    }
    const bad = [...ALL_PLANTED, ...tokens];
    const found = cap.lines.flatMap((l) => bad.filter((p) => l.includes(p)).map((p) => `${p.slice(0, 20)} in ${l.slice(0, 100)}`));
    expect(found).toEqual([]);
  });
});

describe('Invariant: audit records hold IDs and action codes only', () => {
  it('audit rows written by real auth flows contain only the allowed columns and no planted text', async () => {
    const fake = createFakePrisma();
    const sender = new MemoryEmailSender();
    const app = createApp({ authAdapter: new DatabaseAuthProviderAdapter(fake.client, sender) });

    await request(app).post(`${API}/auth/signup`).send({ email: PLANTED_EMAIL, password: PASSWORD, fullName: PLANTED_NAME });
    const ver = [...sender.outbox].reverse().find((m) => m.kind === 'verification')!.token;
    await request(app).post(`${API}/auth/verify-email`).send({ token: ver });
    const login = await request(app).post(`${API}/auth/login`).send({ email: PLANTED_EMAIL, password: PASSWORD });
    await request(app).post(`${API}/auth/request-password-reset`).send({ email: PLANTED_EMAIL });
    const reset = [...sender.outbox].reverse().find((m) => m.kind === 'password-reset')!.token;
    await request(app).post(`${API}/auth/reset-password`).send({ token: reset, password: 'another long password' });
    await request(app).post(`${API}/auth/refresh`).send({ refreshToken: login.body.data.session.refreshToken });
    await request(app).delete(`${API}/auth/account`).set('Authorization', `Bearer ${login.body.data.session.accessToken}`);

    const rows = fake.tables.auditEvent;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const allowed = new Set(['id', 'userId', 'action', 'resourceType', 'resourceId', 'createdAt']);
    for (const row of rows) {
      expect(Object.keys(row).filter((k) => !allowed.has(k))).toEqual([]);
      expect(row.action).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(row.resourceType).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
    const text = JSON.stringify(rows);
    for (const p of [...ALL_PLANTED, ver, reset]) expect(text).not.toContain(p);
  });

  it('the AuditEvent table has no free-text or JSON column that could carry PHI', () => {
    const schema = fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const model = schema.match(/model AuditEvent \{([\s\S]*?)\n\}/);
    expect(model).not.toBeNull();
    const columns = model![1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('@@') && !l.startsWith('//'))
      .map((l) => l.split(/\s+/)[0]);
    expect(columns.sort()).toEqual(['action', 'createdAt', 'id', 'resourceId', 'resourceType', 'userId']);
  });
});

