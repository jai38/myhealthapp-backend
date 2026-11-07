import { describe, it, expect } from 'vitest';
import { assertDevSeedTarget, GuardInput } from '../src/scripts/seed-dev/guard.js';
import { generateWorld } from '../src/scripts/seed-dev/generate.js';
import { SEED_EMAIL_DOMAIN } from '../src/scripts/seed-dev/builder.js';
import { renderPlaceholderPng, renderPdf, inspectImage, sha256 } from '../src/scripts/seed-dev/files.js';
import { promptsMarkdown } from '../src/scripts/seed-dev/prompts.js';
import { HANDWRITTEN_TEMPLATES } from '../src/scripts/seed-dev/handwritten-templates.js';
import { validateStorageKey } from '../src/modules/storage/storage-keys.js';
import { ExtractedPrescriptionPayloadSchema } from '../src/modules/prescriptions/schemas.js';

const AWS_DEV_URL = 'postgresql://u:p@myhealth-v1.abc.ap-south-1.rds.amazonaws.com:5432/myhealthapp?schema=dev&sslmode=require';
const AWS_PROD_URL = 'postgresql://u:p@myhealth-v1.abc.ap-south-1.rds.amazonaws.com:5432/myhealthapp?schema=public&sslmode=require';

const awsDev: GuardInput = {
  target: 'dev',
  databaseUrl: AWS_DEV_URL,
  nodeEnv: 'production',
  deploymentEnv: 'dev',
  storageBucket: 'myhealth-v1-dev-documents-123456789012',
  withFiles: true,
};

describe('dev seed guard: prod never receives generated data', () => {
  it('accepts the AWS dev schema with the dev deployment and dev bucket', () => {
    expect(assertDevSeedTarget(awsDev)).toEqual({ local: false, schema: 'dev' });
  });

  it('accepts local Docker Postgres', () => {
    expect(assertDevSeedTarget({ target: 'dev', databaseUrl: 'postgresql://healthuser:healthpassword@localhost:5433/myhealthapp_dev?schema=public', nodeEnv: undefined, deploymentEnv: undefined, storageBucket: undefined, withFiles: true }).local).toBe(true);
  });

  it.each<[string, Partial<GuardInput>]>([
    ['no --target', { target: undefined }],
    ['--target prod', { target: 'prod' }],
    ['prod schema (public)', { databaseUrl: AWS_PROD_URL }],
    ['no schema parameter (defaults to public)', { databaseUrl: AWS_DEV_URL.replace('schema=dev&', '') }],
    ['DEPLOYMENT_ENV=prod', { deploymentEnv: 'prod' }],
    ['DEPLOYMENT_ENV unset on a remote database', { deploymentEnv: undefined }],
    ['prod bucket', { storageBucket: 'myhealth-v1-documents-123456789012' }],
    ['missing DATABASE_URL', { databaseUrl: undefined }],
    ['non-PostgreSQL URL', { databaseUrl: 'mysql://u:p@db.example.com/x?schema=dev' }],
  ])('refuses: %s', (_name, change) => {
    expect(() => assertDevSeedTarget({ ...awsDev, ...change })).toThrow(/Seed refused/);
  });

  it('refuses DEPLOYMENT_ENV=prod even on a local database', () => {
    expect(() => assertDevSeedTarget({ target: 'dev', databaseUrl: 'postgresql://a:b@localhost:5433/x', nodeEnv: 'development', deploymentEnv: 'prod', storageBucket: undefined, withFiles: false })).toThrow(/Seed refused/);
  });

  it('refuses a local database paired with a remote storage endpoint', () => {
    expect(() => assertDevSeedTarget({ target: 'dev', databaseUrl: 'postgresql://a:b@localhost:5433/x', nodeEnv: undefined, deploymentEnv: undefined, storageBucket: 'b', storageEndpoint: 'https://abc.storage.example.co', withFiles: true })).toThrow(/local MinIO/);
  });

  it('allows the prod bucket check to be skipped only when no files are written', () => {
    expect(() => assertDevSeedTarget({ ...awsDev, storageBucket: 'myhealth-v1-documents-1', withFiles: false })).not.toThrow();
  });
});

describe('dev seed world', () => {
  const now = new Date('2026-11-07T06:30:00Z');
  const world = generateWorld({ seed: 7, bulkUsers: 15, maxRxPerUser: 25, now, doseHistoryDays: 60 });

  it('is deterministic for a seed', () => {
    const again = generateWorld({ seed: 7, bulkUsers: 15, maxRxPerUser: 25, now, doseHistoryDays: 60 });
    expect(again.users.map((u) => u.id)).toEqual(world.users.map((u) => u.id));
    expect(again.doses.length).toBe(world.doses.length);
  });

  it('uses only reserved .test emails, unique ids and unique emails', () => {
    expect(world.users.every((u) => u.email.endsWith(`@${SEED_EMAIL_DOMAIN}`))).toBe(true);
    expect(new Set(world.users.map((u) => u.email)).size).toBe(world.users.length);
    const all = [...world.users, ...world.profiles, ...world.documents, ...world.jobs, ...world.prescriptions, ...world.items, ...world.medications, ...world.doses, ...world.timeline].map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps storage keys in the documents/<patientProfileId>/<uuid> form (Rule 5)', () => {
    for (const d of world.documents) expect(() => validateStorageKey(d.storageKey, d.patientProfileId)).not.toThrow();
    for (const i of world.uploadIntents) expect(() => validateStorageKey(i.storageKey, i.patientProfileId)).not.toThrow();
  });

  it('stores extraction drafts that pass the real payload schema', () => {
    for (const j of world.jobs.filter((x) => x.extractedPayload)) {
      expect(ExtractedPrescriptionPayloadSchema.safeParse(j.extractedPayload).success).toBe(true);
    }
  });

  it('never creates reminders or doses for medicines that were not marked active (Rule 11)', () => {
    const items = new Map(world.items.map((i) => [i.id, i]));
    const dosed = new Set(world.doses.map((d) => d.medicationId));
    for (const m of world.medications) {
      const item = m.prescriptionItemId ? items.get(m.prescriptionItemId) : undefined;
      if (item && !item.isActiveMedication) {
        expect(m.reminderTimes).toBeUndefined();
        expect(dosed.has(m.id as string)).toBe(false);
      }
    }
  });

  it('records an action time for every acted-on dose and none for pending ones (Rules 14, 15)', () => {
    for (const d of world.doses) {
      if (d.status === 'PENDING') expect(d.actionTime ?? null).toBeNull();
      else expect(d.actionTime).toBeInstanceOf(Date);
    }
    const never = world.users.find((u) => u.email.startsWith('adherence-never-records@'));
    const profile = world.profiles.find((p) => p.userId === never?.id);
    const theirs = world.doses.filter((d) => d.patientProfileId === profile?.id);
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((d) => d.status === 'PENDING')).toBe(true);
  });

  it('has no duplicate dose for the same medicine and time', () => {
    const keys = world.doses.map((d) => `${d.medicationId}|${(d.scheduledTime as Date).toISOString()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every record inside its own patient', () => {
    const docOwner = new Map(world.documents.map((d) => [d.id, d.patientProfileId]));
    const rxOwner = new Map(world.prescriptions.map((p) => [p.id, p.patientProfileId]));
    for (const p of world.prescriptions) expect(docOwner.get(p.documentId)).toBe(p.patientProfileId);
    for (const t of world.timeline) expect(docOwner.get(t.sourceDocumentId)).toBe(t.patientProfileId);
    for (const m of world.medications) if (m.prescriptionId) expect(rxOwner.get(m.prescriptionId)).toBe(m.patientProfileId);
  });

  it('keeps name as written separate from the normalised name, and leaves uncertain names empty (Rules 12, 13)', () => {
    expect(world.items.some((i) => i.normalizedMedicineName === null)).toBe(true);
    expect(world.items.some((i) => i.normalizedMedicineName && i.normalizedMedicineName !== i.nameAsWritten)).toBe(true);
  });

  it('covers every document, job, medicine and dose status', () => {
    expect(new Set(world.documents.map((d) => d.status))).toEqual(new Set(['UPLOADED', 'EXTRACTING', 'READY_FOR_REVIEW', 'CONFIRMED', 'FAILED']));
    expect(new Set(world.jobs.map((j) => j.status))).toEqual(new Set(['QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED']));
    expect(new Set(world.medications.map((m) => m.status))).toEqual(new Set(['INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETED', 'DISCONTINUED']));
    expect(new Set(world.doses.map((d) => d.status))).toEqual(new Set(['PENDING', 'TAKEN', 'SKIPPED', 'SNOOZED', 'MISSED']));
  });
});

describe('dev seed files', () => {
  it('renders distinct, valid placeholder PNGs', () => {
    const spec = { kind: 'png' as const, templateId: 'HW-07', heading: 'x', lines: [], pages: 1 };
    const a = renderPlaceholderPng(spec, '11111111-1111-4111-8111-111111111111');
    const b = renderPlaceholderPng(spec, '22222222-2222-4222-8222-222222222222');
    expect(inspectImage(a.bytes, 'a')).toMatchObject({ mimeType: 'image/png', width: 480, height: 640 });
    expect(sha256(a.bytes)).not.toBe(sha256(b.bytes));
  });

  it('renders multi-page PDFs that start with the PDF magic bytes', async () => {
    const pdf = await renderPdf({ kind: 'pdf', heading: 'Clinic', lines: ['line one', 'श्रीमती (non-Latin)'], pages: 3 }, '33333333-3333-4333-8333-333333333333');
    expect(pdf.bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.pageCount).toBe(3);
  });

  it('rejects images that are not PNG or JPEG', () => {
    expect(() => inspectImage(Buffer.from('RIFF0000WEBPVP8 '), 'x')).toThrow(/PNG or JPEG/);
  });

  it('writes one prompt per handwritten template', () => {
    const md = promptsMarkdown();
    for (const t of HANDWRITTEN_TEMPLATES) expect(md).toContain(`## ${t.id}:`);
  });
});
