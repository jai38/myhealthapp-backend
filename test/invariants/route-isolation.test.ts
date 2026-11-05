/**
 * Invariants 1 and 2 (CLAUDE.md section 6): identity comes from the token, and cross-patient
 * access returns 404, for EVERY registered route.
 *
 * The test walks the live Express router stack. Each route must be classified in ROUTE_POLICY
 * below. A route that is not listed fails the suite, so a new endpoint cannot ship without a
 * decision about how it is isolated. Add the new route to the policy and, if it takes a
 * patient-owned identifier, mark it `owned` so User B is aimed at User A's real resource.
 *
 *   public     no authentication required by design
 *   self       authenticated, scoped only by the token, takes no resource identifier
 *   collection authenticated list/aggregate: User B must never see User A's data in the reply
 *   owned      takes a patient-owned identifier: User B must get 404 for User A's resource
 *   keyed      takes a storage key rather than an id; see the note on confirm-upload
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  API,
  TOKEN_A,
  TOKEN_B,
  PATIENT_A,
  PLANTED,
  buildWorld,
  seedPatientA,
  uploadDocument,
  type PatientAResources,
  type World,
} from './helpers.js';

type Kind = 'public' | 'self' | 'collection' | 'owned' | 'keyed';
interface Policy {
  kind: Kind;
  /** Maps a path parameter name to a field of PatientAResources (or PATIENT_A). */
  params?: Record<string, keyof PatientAResources | 'patientProfileId'>;
  /** Valid body for a mutation, so validation never masks the ownership check. */
  body?: (r: PatientAResources) => unknown;
  /** Query string appended to the request. */
  query?: string;
  /**
   * Set when a route is known to violate the 404 rule. The route is then excluded from the
   * main sweep and asserted on its own with it.fails, so the defect is visible and the test
   * turns red the moment it is fixed (remove the flag and it.fails then).
   */
  defect?: string;
}

const TIMES = { reminderTimes: ['09:00'] };

const ROUTE_POLICY: Record<string, Policy> = {
  // ---- public by design ----
  'GET /healthz': { kind: 'public' },
  [`GET ${API}/app-status`]: { kind: 'public' },
  [`POST ${API}/auth/signup`]: { kind: 'public' },
  [`POST ${API}/auth/login`]: { kind: 'public' },
  [`POST ${API}/auth/refresh`]: { kind: 'public' },
  [`POST ${API}/auth/logout`]: { kind: 'public' },
  [`POST ${API}/auth/request-password-reset`]: { kind: 'public' },
  [`POST ${API}/auth/reset-password`]: { kind: 'public' },
  [`POST ${API}/auth/verify-email`]: { kind: 'public' },
  [`POST ${API}/auth/resend-verification`]: { kind: 'public' },

  // ---- authenticated, token-scoped only ----
  [`GET ${API}/auth/me`]: { kind: 'self' },
  [`DELETE ${API}/auth/account`]: { kind: 'self' },
  [`GET ${API}/patient/profile`]: { kind: 'self' },

  // ---- ownership route that names the patient in the path ----
  [`GET ${API}/patient/:patientProfileId/records`]: {
    kind: 'owned',
    params: { patientProfileId: 'patientProfileId' },
  },

  // ---- documents ----
  [`POST ${API}/documents/upload-intent`]: { kind: 'collection' },
  [`POST ${API}/documents/confirm-upload`]: { kind: 'keyed' },
  [`GET ${API}/documents/:documentId/signed-url`]: { kind: 'owned', params: { documentId: 'documentId' } },
  [`GET ${API}/documents/`]: { kind: 'collection' },

  // ---- prescriptions and extraction jobs ----
  [`POST ${API}/prescriptions/extract-job`]: {
    kind: 'owned',
    body: (r) => ({ documentId: r.documentId }),
  },
  [`GET ${API}/prescriptions/extract-job/:jobId`]: { kind: 'owned', params: { jobId: 'jobId' } },
  [`POST ${API}/prescriptions/extract-job/:jobId/process`]: { kind: 'owned', params: { jobId: 'queuedJobId' } },
  [`POST ${API}/prescriptions/extract-job/:jobId/cancel`]: { kind: 'owned', params: { jobId: 'queuedJobId' } },
  [`POST ${API}/prescriptions/:jobId/confirm`]: {
    kind: 'owned',
    params: { jobId: 'jobId' },
    defect:
      'InMemoryPrescriptionRepository.confirmPrescriptionTransaction checks "already confirmed" before ownership, ' +
      'so User B gets 400 (not 404) for an already-confirmed job of User A. The Prisma repository checks ownership first.',
    body: () => ({
      prescription_date: '2026-10-12',
      medicines: [{ name_as_written: 'B-attempt', dosage_form: 'TABLET', route: 'ORAL', is_active_medication: false }],
    }),
  },
  [`GET ${API}/prescriptions/timeline`]: { kind: 'collection' },
  [`GET ${API}/prescriptions/:prescriptionId`]: { kind: 'owned', params: { prescriptionId: 'prescriptionId' } },

  // ---- timeline ----
  [`GET ${API}/timeline/`]: { kind: 'collection' },
  [`GET ${API}/timeline/:id`]: { kind: 'owned', params: { id: 'eventId' } },
  [`GET ${API}/timeline/:id/document-url`]: { kind: 'owned', params: { id: 'eventId' } },

  // ---- medications ----
  [`POST ${API}/medications/`]: { kind: 'collection', body: () => ({ nameAsWritten: 'B-own-med' }) },
  [`GET ${API}/medications/`]: { kind: 'collection' },
  [`GET ${API}/medications/doses`]: { kind: 'collection' },
  [`POST ${API}/medications/doses/:doseId/action`]: {
    kind: 'owned',
    params: { doseId: 'doseId' },
    body: () => ({ action: 'TAKEN' }),
  },
  [`PATCH ${API}/medications/doses/:doseId/action`]: {
    kind: 'owned',
    params: { doseId: 'doseId' },
    body: () => ({ action: 'TAKEN' }),
  },
  [`GET ${API}/medications/:id`]: { kind: 'owned', params: { id: 'medicationId' } },
  [`GET ${API}/medications/:id/document-url`]: { kind: 'owned', params: { id: 'medicationId' } },
  [`POST ${API}/medications/:id/activate`]: { kind: 'owned', params: { id: 'medicationId' }, body: () => TIMES },
  [`PATCH ${API}/medications/:id/schedule`]: { kind: 'owned', params: { id: 'manualMedicationId' }, body: () => TIMES },
  [`POST ${API}/medications/:id/pause`]: { kind: 'owned', params: { id: 'manualMedicationId' }, body: () => ({}) },
  [`POST ${API}/medications/:id/resume`]: { kind: 'owned', params: { id: 'manualMedicationId' }, body: () => ({}) },
  [`POST ${API}/medications/:id/complete`]: { kind: 'owned', params: { id: 'manualMedicationId' }, body: () => ({}) },
  [`POST ${API}/medications/:id/discontinue`]: { kind: 'owned', params: { id: 'manualMedicationId' }, body: () => ({}) },

  // ---- reports ----
  [`POST ${API}/reports/export-data`]: {
    kind: 'collection',
    body: (r) => ({ includeTimeline: true, includeMedications: true, selectedEventIds: [r.eventId], allowEmpty: true }),
  },
  [`POST ${API}/reports/generate`]: {
    kind: 'collection',
    body: (r) => ({ includeTimeline: true, includeMedications: true, selectedMedicationIds: [r.medicationId], allowEmpty: true }),
  },
  [`POST ${API}/reports/generate-pdf`]: {
    kind: 'collection',
    body: (r) => ({ includeTimeline: true, includeMedications: true, selectedEventIds: [r.eventId], allowEmpty: true }),
  },
  [`GET ${API}/reports/:id/download`]: { kind: 'owned', params: { id: 'reportId' } },
};

// ---------------------------------------------------------------------------
// Walk the live Express stack (Express 4 internals) and return "METHOD /full/path" keys.
// ---------------------------------------------------------------------------
function mountPrefix(layer: any): string {
  const src: string = layer.regexp?.source ?? '';
  if (src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^((?:\\\/|[^\\()?*+^$|[\]{}])+)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) throw new Error(`Cannot derive mount path from ${src}; update the walker`);
  return m[1].replace(/\\\//g, '/');
}

function walk(stack: any[], prefix: string, out: Set<string>): void {
  for (const layer of stack) {
    if (layer.route) {
      const paths: string[] = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) out.add(`${method.toUpperCase()} ${prefix}${p}`);
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountPrefix(layer), out);
    }
  }
}

export function listRoutes(app: Express): string[] {
  const out = new Set<string>();
  walk((app as any)._router.stack, '', out);
  return [...out].sort();
}

function fill(path: string, policy: Policy, a: PatientAResources): string {
  let p = path;
  for (const [name, field] of Object.entries(policy.params ?? {})) {
    const value = field === 'patientProfileId' ? PATIENT_A : a[field];
    p = p.replace(`:${name}`, encodeURIComponent(value));
  }
  if (/:[A-Za-z]/.test(p)) throw new Error(`Unfilled path parameter in ${path}`);
  return p + (policy.query ?? '');
}

function send(app: Express, method: string, url: string, token: string | null, body?: unknown) {
  let req = (request(app) as any)[method.toLowerCase()](url);
  if (token) req = req.set('Authorization', token);
  return body === undefined ? req : req.send(body);
}

function entries(): Array<[string, Policy]> {
  return Object.entries(ROUTE_POLICY);
}

describe('Invariant: every registered route is isolated per patient', () => {
  let w: World;
  let a: PatientAResources;

  beforeAll(async () => {
    w = buildWorld();
    a = await seedPatientA(w);
  });

  it('classifies every registered route, with no stale entries', () => {
    const registered = listRoutes(w.app);
    const known = Object.keys(ROUTE_POLICY);
    const unclassified = registered.filter((r) => !known.includes(r));
    const stale = known.filter((k) => !registered.includes(k));
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it('returns 401 for every non-public route with no token, and for a forged token', async () => {
    const failures: string[] = [];
    for (const [key, policy] of entries()) {
      if (policy.kind === 'public') continue;
      const [method, path] = key.split(' ');
      const url = fill(path, policy, a);
      const body = policy.body ? policy.body(a) : {};
      for (const token of [null, 'Bearer forged.token.value', 'Basic abc']) {
        const res = await send(w.app, method, url, token, body);
        if (res.status !== 401) failures.push(`${key} with ${token ?? 'no token'} -> ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('proves the fixture is real: Patient A can read every GET resource that B is aimed at', async () => {
    const failures: string[] = [];
    for (const [key, policy] of entries()) {
      const [method, path] = key.split(' ');
      if (policy.kind !== 'owned' || method !== 'GET') continue;
      const res = await send(w.app, method, fill(path, policy, a), TOKEN_A);
      // document-url routes may report 404 when no source document exists; every other GET must succeed.
      if (res.status >= 400 && !path.endsWith('/document-url')) failures.push(`${key} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('returns 404 to User B for User A resources on every owned route', async () => {
    const failures: string[] = [];
    for (const [key, policy] of entries()) {
      if (policy.kind !== 'owned' || policy.defect) continue;
      const [method, path] = key.split(' ');
      const res = await send(w.app, method, fill(path, policy, a), TOKEN_B, policy.body?.(a));
      if (res.status !== 404) failures.push(`${key} -> ${res.status} ${JSON.stringify(res.body)}`);
    }
    expect(failures).toEqual([]);
  });

  // KNOWN DEFECT (test double only, see ROUTE_POLICY): ownership is checked after the
  // already-confirmed state in the in-memory repository, so existence leaks as a 400.
  it.fails('returns 404 (not 400) to User B for an already-confirmed job of User A', async () => {
    const key = `POST ${API}/prescriptions/:jobId/confirm`;
    const policy = ROUTE_POLICY[key];
    const res = await send(w.app, 'POST', fill(key.split(' ')[1], policy, a), TOKEN_B, policy.body?.(a));
    expect(res.status).toBe(404);
  });

  it('returns 404 to User B for an unconfirmed (still-succeeded) job of User A', async () => {
    const fresh = await uploadDocument(w, TOKEN_A, PATIENT_A, 'fresh.pdf');
    const job = await request(w.app).post(`${API}/prescriptions/extract-job`).set('Authorization', TOKEN_A).send({ documentId: fresh.documentId });
    const key = `POST ${API}/prescriptions/:jobId/confirm`;
    const res = await send(
      w.app, 'POST', `${API}/prescriptions/${job.body.data.id}/confirm`, TOKEN_B, ROUTE_POLICY[key].body?.(a),
    );
    expect(res.status).toBe(404);
  });

  it('never shows User A data in any collection reply to User B', async () => {
    const aValues = [
      ...Object.values(a),
      PLANTED.drug,
      PLANTED.doctor,
      PLANTED.diagnosis,
      PLANTED.clinic,
      PLANTED.filename,
      'Manual-A-Med',
    ];
    const failures: string[] = [];
    for (const [key, policy] of entries()) {
      if (policy.kind !== 'collection' && policy.kind !== 'self') continue;
      const [method, path] = key.split(' ');
      if (method === 'DELETE') continue; // would delete User B; covered in account-deletion.test.ts
      const body = policy.body ? policy.body(a) : method === 'POST' ? defaultCollectionBody(path) : undefined;
      const res = await send(w.app, method, fill(path, policy, a), TOKEN_B, body);
      if (res.status >= 500) failures.push(`${key} -> ${res.status}`);
      const text = JSON.stringify(res.body ?? {}) + (Buffer.isBuffer(res.body) ? res.body.toString('latin1') : '');
      for (const v of aValues) if (text.includes(v)) failures.push(`${key} leaked ${v}`);
    }
    expect(failures).toEqual([]);
  });

  it("User B's failed attempts leave User A's resources untouched", async () => {
    const med = await request(w.app).get(`${API}/medications/${a.manualMedicationId}`).set('Authorization', TOKEN_A);
    expect(med.status).toBe(200);
    expect(med.body.data.status).toBe('ACTIVE');
    const job = await request(w.app).get(`${API}/prescriptions/extract-job/${a.queuedJobId}`).set('Authorization', TOKEN_A);
    expect(job.status).toBe(200);
    expect(job.body.data.status).toBe('QUEUED');
    const dose = await request(w.app).get(`${API}/medications/doses`).set('Authorization', TOKEN_A);
    expect(dose.body.data.find((d: any) => d.id === a.doseId).status).not.toBe('TAKEN');
  });

  /**
   * confirm-upload takes a storage key. The ownership check is a pure string comparison of the
   * patient segment, so the reply is 403 and is identical whether or not the key exists. That
   * gives an attacker nothing to enumerate, which is the purpose of the 404 rule. Documented
   * here so the exception is deliberate and cannot widen.
   */
  it('confirm-upload: another patient key gets the same 403 whether or not it exists', async () => {
    const real = await send(w.app, 'POST', `${API}/documents/confirm-upload`, TOKEN_B, { storageKey: a.storageKey });
    const ghost = await send(w.app, 'POST', `${API}/documents/confirm-upload`, TOKEN_B, {
      storageKey: `documents/${PATIENT_A}/00000000-0000-4000-8000-000000000000`,
    });
    expect(real.status).toBe(403);
    expect(ghost.status).toBe(403);
    expect(ghost.body).toEqual(real.body);
  });
});

function defaultCollectionBody(path: string): unknown {
  if (path.endsWith('/upload-intent')) {
    return { filename: 'b.pdf', mimeType: 'application/pdf', fileSizeBytes: 1000 };
  }
  return {};
}
