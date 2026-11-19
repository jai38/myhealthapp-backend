import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  InMemoryDocumentRepository,
  InMemoryExtractionJobRepository,
  InMemoryMedicationRepository,
  InMemoryPrescriptionRepository,
  InMemoryTimelineRepository,
  InMemoryUploadIntentRepository,
} from '../src/modules/persistence/repositories.js';
import { MedicationService } from '../src/modules/medications/medication-service.js';
import { DocumentService } from '../src/modules/documents/document-service.js';
import { MemoryStorageProvider } from '../src/modules/storage/storage-provider.js';

// Phase 4b task 16 (issues #5, #6, #7, #8): MISSED action, future actionTime, skipReason, /auth/me fullName.
describe('Phase 4b task 16: dose actions and /auth/me', () => {
  let app: any;
  let medicationRepo: InMemoryMedicationRepository;
  let lookedUpName: string | null | undefined;

  const patientA = 'pat_userA';
  const auth = { Authorization: 'Bearer mock-access-jwt-userA' };

  beforeEach(() => {
    const uploadIntentRepo = new InMemoryUploadIntentRepository();
    const docRepo = new InMemoryDocumentRepository();
    const jobRepo = new InMemoryExtractionJobRepository();
    const prescriptionRepo = new InMemoryPrescriptionRepository(jobRepo, docRepo);
    const timelineRepo = new InMemoryTimelineRepository(prescriptionRepo, docRepo);
    medicationRepo = new InMemoryMedicationRepository(prescriptionRepo, docRepo);
    prescriptionRepo.setMedicationRepository(medicationRepo);
    const storageProvider = new MemoryStorageProvider(uploadIntentRepo);
    const documentService = new DocumentService(storageProvider, docRepo);
    const medicationService = new MedicationService(medicationRepo, documentService);
    lookedUpName = 'Asha Rao';

    app = createApp({
      storageProvider,
      documentService,
      medicationService,
      docRepo,
      jobRepo,
      prescriptionRepo,
      uploadIntentRepo,
      timelineRepo,
      medicationRepo,
      lookupFullName: async () => lookedUpName,
    });
  });

  const createDose = async (): Promise<string> => {
    const med = await medicationRepo.createMedication({
      patientProfileId: patientA,
      nameAsWritten: 'Tab Test 10mg',
      dosageForm: 'TABLET',
      status: 'ACTIVE',
    });
    const [dose] = await medicationRepo.createDoseLogs([
      { medicationId: med.id, patientProfileId: patientA, scheduledTime: new Date(Date.now() - 60 * 60 * 1000) },
    ]);
    return dose!.id;
  };

  const post = (id: string, body: object) =>
    request(app).post(`/api/v1/medications/doses/${id}/action`).set(auth).send(body);
  const patch = (id: string, body: object) =>
    request(app).patch(`/api/v1/medications/doses/${id}/action`).set(auth).send(body);

  describe('#5 MISSED', () => {
    it('POST accepts MISSED and stores it', async () => {
      const id = await createDose();
      const res = await post(id, { action: 'MISSED' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('MISSED');
    });

    it('PATCH accepts MISSED', async () => {
      const id = await createDose();
      const res = await patch(id, { action: 'MISSED' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('MISSED');
    });

    it('PATCH back to PENDING from MISSED leaves the dose PENDING, never MISSED', async () => {
      const id = await createDose();
      await post(id, { action: 'MISSED' });
      const res = await patch(id, { action: 'PENDING' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('PENDING');
      expect((await medicationRepo.getDoseLogById(id, patientA))!.status).toBe('PENDING');
    });

    it('an unrecorded past dose stays PENDING: reading doses never marks it MISSED', async () => {
      const id = await createDose();
      const list = await request(app)
        .get('/api/v1/medications/doses')
        .query({ from: new Date(Date.now() - 48 * 3600 * 1000).toISOString(), to: new Date().toISOString() })
        .set(auth);
      expect(list.status).toBe(200);
      const found = list.body.data.find((d: any) => d.id === id);
      expect(found.status).toBe('PENDING');
    });

    it('only the two explicit action routes can write a dose status (nothing automatic sets MISSED)', async () => {
      const { readdirSync, readFileSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const p = join(dir, name);
          return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
        });
      const callers = walk('src')
        .filter((f) => !f.includes('scripts') && !f.endsWith('repositories.ts'))
        .filter((f) => /\.updateDoseAction\(/.test(readFileSync(f, 'utf8')))
        .map((f) => f.replace(/\\/g, '/'));
      expect(callers).toEqual(['src/modules/medications/medication-service.ts']);
      const svc = readFileSync('src/modules/medications/medication-service.ts', 'utf8');
      expect(svc.match(/\.updateDoseAction\(/g)).toHaveLength(2); // recordDoseAction + correctDoseAction
    });

    it('still rejects unknown actions', async () => {
      const id = await createDose();
      expect((await post(id, { action: 'FORGOTTEN' })).status).toBe(400);
      expect((await patch(id, { action: 'SNOOZED' })).status).toBe(400);
    });
  });

  describe('#6 future actionTime', () => {
    it('rejects an actionTime more than 2 minutes ahead and leaves the dose unchanged', async () => {
      const id = await createDose();
      const res = await post(id, {
        action: 'TAKEN',
        actionTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const dose = await medicationRepo.getDoseLogById(id, patientA);
      expect(dose!.status).toBe('PENDING');
      expect(dose!.actionTime).toBeUndefined();
    });

    it('accepts an actionTime within the 2 minute clock skew', async () => {
      const id = await createDose();
      const res = await post(id, {
        action: 'TAKEN',
        actionTime: new Date(Date.now() + 60 * 1000).toISOString(),
      });
      expect(res.status).toBe(200);
    });

    it('accepts a past actionTime', async () => {
      const id = await createDose();
      const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const res = await post(id, { action: 'TAKEN', actionTime: past });
      expect(res.status).toBe(200);
      expect(new Date(res.body.data.actionTime).toISOString()).toBe(past);
    });
  });

  describe('#7 skipReason', () => {
    it.each(['FELT_UNWELL', 'DOCTOR_ADVISED', 'RAN_OUT', 'SIDE_EFFECTS', 'OTHER'])(
      'POST SKIPPED stores and returns %s',
      async (reason) => {
        const id = await createDose();
        const res = await post(id, { action: 'SKIPPED', skipReason: reason });
        expect(res.status).toBe(200);
        expect(res.body.data.skipReason).toBe(reason);
        expect((await medicationRepo.getDoseLogById(id, patientA))!.skipReason).toBe(reason);
      }
    );

    it('skipping without a reason stays valid', async () => {
      const id = await createDose();
      const res = await post(id, { action: 'SKIPPED' });
      expect(res.status).toBe(200);
      expect(res.body.data.skipReason ?? null).toBeNull();
    });

    it('rejects skipReason with any action other than SKIPPED (POST)', async () => {
      for (const action of ['TAKEN', 'SNOOZED', 'MISSED']) {
        const id = await createDose();
        const res = await post(id, { action, skipReason: 'RAN_OUT' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect((await medicationRepo.getDoseLogById(id, patientA))!.status).toBe('PENDING');
      }
    });

    it('rejects an unknown skipReason', async () => {
      const id = await createDose();
      expect((await post(id, { action: 'SKIPPED', skipReason: 'BORED' })).status).toBe(400);
    });

    it('PATCH SKIPPED with a reason stores it; PATCH to another action clears it', async () => {
      const id = await createDose();
      const skipped = await patch(id, { action: 'SKIPPED', skipReason: 'SIDE_EFFECTS' });
      expect(skipped.status).toBe(200);
      expect(skipped.body.data.skipReason).toBe('SIDE_EFFECTS');

      const taken = await patch(id, { action: 'TAKEN' });
      expect(taken.status).toBe(200);
      expect(taken.body.data.skipReason ?? null).toBeNull();
    });

    it('PATCH rejects skipReason with a non-SKIPPED action', async () => {
      const id = await createDose();
      const res = await patch(id, { action: 'TAKEN', skipReason: 'OTHER' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('#8 GET /auth/me fullName', () => {
    it('returns the stored name and keeps the existing fields', async () => {
      const res = await request(app).get('/api/v1/auth/me').set(auth);
      expect(res.status).toBe(200);
      expect(res.body.data.fullName).toBe('Asha Rao');
      expect(res.body.data.userId).toBeDefined();
      expect(res.body.data.email).toBeDefined();
      expect(res.body.data.patientProfileId).toBe(patientA);
    });

    it.each([null, undefined, '', '   ', 'Patient Profile'])('returns null when the name is %j', async (value) => {
      lookedUpName = value as any;
      const res = await request(app).get('/api/v1/auth/me').set(auth);
      expect(res.status).toBe(200);
      expect(res.body.data.fullName).toBeNull();
    });

    it('still requires authentication', async () => {
      expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    });
  });
});
