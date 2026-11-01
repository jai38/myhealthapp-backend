/**
 * Invariants 3 and 4: storage keys are exactly documents/<patientProfileId>/<uuid>, and every
 * signed URL lives at most 15 minutes.
 *
 * Complements (does not repeat) upload-intent-lifecycle-and-parser-limits.test.ts, which covers
 * the basic traversal, cross-tenant and missing-segment cases. This file adds extensions and
 * other near-miss shapes, drives them through every provider and the HTTP boundary, and checks
 * the TTL on every route and provider that hands out a URL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import {
  validateStorageKey,
  S3StorageProvider,
  MemoryStorageProvider,
} from '../../src/modules/storage/storage-provider.js';
import { InMemoryUploadIntentRepository } from '../../src/modules/persistence/repositories.js';
import {
  API,
  TOKEN_A,
  PATIENT_A,
  PATIENT_B,
  buildWorld,
  seedPatientA,
  type PatientAResources,
  type World,
} from './helpers.js';

const MAX_TTL_SECONDS = 15 * 60;
const uuid = () => crypto.randomUUID();

function badKeys(patient: string): Array<[string, string]> {
  const id = uuid();
  return [
    ['extension .pdf', `documents/${patient}/${id}.pdf`],
    ['extension .jpg', `documents/${patient}/${id}.jpg`],
    ['trailing dot', `documents/${patient}/${id}.`],
    ['double extension', `documents/${patient}/${id}.pdf.exe`],
    ['trailing slash', `documents/${patient}/${id}/`],
    ['trailing newline', `documents/${patient}/${id}\n`],
    ['trailing space', `documents/${patient}/${id} `],
    ['null byte', `documents/${patient}/${id}\u0000.pdf`],
    ['leading slash', `/documents/${patient}/${id}`],
    ['double slash', `documents//${patient}/${id}`],
    ['empty patient segment', `documents//${id}`],
    ['patient prefix extended', `documents/${patient}x/${id}`],
    ['patient prefix truncated', `documents/${patient.slice(0, -1)}/${id}`],
    ['wrong root case', `Documents/${patient}/${id}`],
    ['dot segment', `documents/${patient}/./${id}`],
    ['parent segment', `documents/${patient}/../${patient}/${id}`],
    ['encoded dot dot', `documents/${patient}/%2e%2e/${id}`],
    ['encoded slash', `documents/${patient}%2f${id}`],
    ['backslash separator', `documents\\${patient}\\${id}`],
    ['uuid with braces', `documents/${patient}/{${id}}`],
    ['uuid without dashes', `documents/${patient}/${id.replace(/-/g, '')}`],
    ['non-hex uuid', `documents/${patient}/${id.replace(/^./, 'z')}`],
    ['another patient', `documents/${PATIENT_B}/${id}`],
  ];
}

describe('Invariant: storage key format', () => {
  it('accepts exactly documents/<patientProfileId>/<uuid>', () => {
    expect(() => validateStorageKey(`documents/${PATIENT_A}/${uuid()}`, PATIENT_A)).not.toThrow();
  });

  it.each(badKeys(PATIENT_A))('validateStorageKey rejects %s', (_label, key) => {
    expect(() => validateStorageKey(key, PATIENT_A)).toThrow();
  });

  it.each([[null], [undefined], [42], [{}], [['documents', PATIENT_A, 'x']]])(
    'validateStorageKey rejects non-string key %j',
    (key) => {
      expect(() => validateStorageKey(key as any, PATIENT_A)).toThrow();
    },
  );

  it('validateStorageKey rejects an empty expected patient id', () => {
    expect(() => validateStorageKey(`documents//${uuid()}`, '')).toThrow();
  });

  describe.each([
    ['MemoryStorageProvider', () => new MemoryStorageProvider(new InMemoryUploadIntentRepository())],
    [
      'S3StorageProvider',
      () => new S3StorageProvider(new InMemoryUploadIntentRepository(), { endpoint: 'http://localhost:9' }),
    ],
  ])('%s refuses malformed keys before touching storage', (_name, make) => {
    const bytes = Buffer.from('%PDF-1.4');
    it.each(badKeys(PATIENT_A))('putObject / getDownloadSignedUrl / getObjectBuffer / checkObjectExists / deleteObject: %s', async (_l, key) => {
      const p: any = make();
      await expect(p.putObject(key, PATIENT_A, bytes, 'application/pdf')).rejects.toThrow();
      await expect(p.getDownloadSignedUrl(key, PATIENT_A)).rejects.toThrow();
      await expect(p.getObjectBuffer(key, PATIENT_A)).rejects.toThrow();
      await expect(p.checkObjectExists(key, PATIENT_A)).rejects.toThrow();
      await expect(p.deleteObject(key, PATIENT_A)).rejects.toThrow();
    });
  });

  describe('at the HTTP boundary', () => {
    let w: World;
    beforeAll(() => {
      w = buildWorld();
    });

    it.each(badKeys(PATIENT_A))('confirm-upload rejects %s and creates no document', async (_l, storageKey) => {
      const res = await request(w.app)
        .post(`${API}/documents/confirm-upload`)
        .set('Authorization', TOKEN_A)
        .send({ storageKey, mimeType: 'application/pdf' });
      expect([400, 403, 404]).toContain(res.status);
      const list = await request(w.app).get(`${API}/documents`).set('Authorization', TOKEN_A);
      expect(list.body.data).toEqual([]);
    });

    it.each([[['documents', PATIENT_A]], [{ a: 1 }], [12345]])(
      'confirm-upload answers a non-string storageKey %j with 4xx, not 500',
      async (storageKey) => {
        const res = await request(w.app)
          .post(`${API}/documents/confirm-upload`)
          .set('Authorization', TOKEN_A)
          .send({ storageKey });
        expect(res.status).toBeLessThan(500);
        expect(res.status).toBeGreaterThanOrEqual(400);
      },
    );

    it.each([[['documents', PATIENT_A]], [{ a: 1 }], [12345]])('confirm-upload never accepts a non-string storageKey %j', async (storageKey) => {
      const res = await request(w.app)
        .post(`${API}/documents/confirm-upload`)
        .set('Authorization', TOKEN_A)
        .send({ storageKey });
      expect(res.status).toBeGreaterThanOrEqual(400);
      const list = await request(w.app).get(`${API}/documents`).set('Authorization', TOKEN_A);
      expect(list.body.data).toEqual([]);
    });

    it('issued keys are exactly documents/<patientProfileId>/<uuid>, whatever the filename says', async () => {
      const filenames = ['rx.pdf', '../../etc/passwd.pdf', 'a/b/c.pdf', 'x'.repeat(200) + '.pdf', 'name with spaces.pdf', 'null\u0000.pdf'];
      for (const filename of filenames) {
        const res = await request(w.app)
          .post(`${API}/documents/upload-intent`)
          .set('Authorization', TOKEN_A)
          .send({ filename, mimeType: 'application/pdf', fileSizeBytes: 2000 });
        if (res.status !== 200) continue; // rejecting a hostile filename is also acceptable
        const key: string = res.body.data.storageKey;
        expect(key).toMatch(
          new RegExp(`^documents/${PATIENT_A}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`),
        );
        expect(key.split('/')).toHaveLength(3);
        expect(key).not.toMatch(/\.[a-z]+$/i);
      }
    });
  });

  it('S3 provider issues keys in the same exact format', async () => {
    const p = new S3StorageProvider(new InMemoryUploadIntentRepository(), { endpoint: 'http://localhost:9' });
    const intent = await p.createUploadIntent({
      patientProfileId: PATIENT_A,
      filename: 'weird.name.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 5000,
    });
    expect(intent.storageKey).toMatch(new RegExp(`^documents/${PATIENT_A}/[0-9a-f-]{36}$`));
  });
});

describe('Invariant: signed URL lifetime is at most 15 minutes', () => {
  let w: World;
  let a: PatientAResources;
  beforeAll(async () => {
    w = buildWorld();
    a = await seedPatientA(w);
  });

  const amzExpires = (url: string): number => {
    const v = new URL(url).searchParams.get('X-Amz-Expires');
    if (v === null) throw new Error(`No X-Amz-Expires in ${url}`);
    return Number(v);
  };

  it('S3 pre-signed upload (PUT) URL', async () => {
    const p = new S3StorageProvider(new InMemoryUploadIntentRepository(), { endpoint: 'http://localhost:9' });
    const intent = await p.createUploadIntent({
      patientProfileId: PATIENT_A,
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 5000,
    });
    expect(intent.expiresInSeconds).toBeLessThanOrEqual(MAX_TTL_SECONDS);
    expect(amzExpires(intent.uploadSignedUrl)).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  it('S3 pre-signed download (GET) URL', async () => {
    const p = new S3StorageProvider(new InMemoryUploadIntentRepository(), { endpoint: 'http://localhost:9' });
    const url = await p.getDownloadSignedUrl(`documents/${PATIENT_A}/${uuid()}`, PATIENT_A);
    expect(amzExpires(url)).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  it('Memory provider download URL', async () => {
    const mem = new MemoryStorageProvider(new InMemoryUploadIntentRepository());
    const key = `documents/${PATIENT_A}/${uuid()}`;
    await mem.putObject(key, PATIENT_A, Buffer.from('x'), 'application/pdf');
    const url = await mem.getDownloadSignedUrl(key, PATIENT_A);
    expect(Number(new URL(url).searchParams.get('expires'))).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  it('upload-intent response', async () => {
    const res = await request(w.app)
      .post(`${API}/documents/upload-intent`)
      .set('Authorization', TOKEN_A)
      .send({ filename: 'a.pdf', mimeType: 'application/pdf', fileSizeBytes: 3000 });
    expect(res.body.data.expiresInSeconds).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  it.each([
    ['documents/:id/signed-url', (r: PatientAResources) => `${API}/documents/${r.documentId}/signed-url`],
    ['timeline/:id/document-url', (r: PatientAResources) => `${API}/timeline/${r.eventId}/document-url`],
    ['medications/:id/document-url', (r: PatientAResources) => `${API}/medications/${r.medicationId}/document-url`],
  ])('%s', async (_label, url) => {
    const res = await request(w.app).get(url(a)).set('Authorization', TOKEN_A);
    expect(res.status).toBe(200);
    expect(res.body.data.signedUrl).toBeTruthy();
    if (res.body.data.expiresInSeconds !== undefined) {
      expect(res.body.data.expiresInSeconds).toBeLessThanOrEqual(MAX_TTL_SECONDS);
    }
    if (res.body.data.expiresAt) {
      expect(new Date(res.body.data.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(MAX_TTL_SECONDS * 1000 + 1000);
    }
    expect(Number(new URL(res.body.data.signedUrl).searchParams.get('expires'))).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  it('report downloadUrl', async () => {
    const res = await request(w.app)
      .post(`${API}/reports/generate`)
      .set('Authorization', TOKEN_A)
      .send({ includeTimeline: true, includeMedications: true });
    expect(res.status).toBe(201);
    expect(Number(new URL(res.body.data.downloadUrl).searchParams.get('expires'))).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });

  /**
   * Guard for future code: any numeric signed-URL lifetime written in src/ must be <= 900.
   * Catches a new `expiresIn: 3600` before it has a route to be tested through.
   */
  it('no source file sets a signed URL lifetime above 900 seconds', () => {
    const root = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          for (const m of text.matchAll(/expiresIn(?:Seconds)?\s*[:=]\s*(\d+)/g)) {
            if (Number(m[1]) > MAX_TTL_SECONDS) offenders.push(`${path.relative(root, full)}: ${m[0]}`);
          }
          for (const m of text.matchAll(/getSignedUrl\([^)]*\{\s*expiresIn:\s*([^}]+)\}/g)) {
            const n = Number(m[1].trim());
            if (Number.isFinite(n) && n > MAX_TTL_SECONDS) offenders.push(`${path.relative(root, full)}: ${m[0]}`);
          }
        }
      }
    };
    visit(root);
    expect(offenders).toEqual([]);
  });
});
