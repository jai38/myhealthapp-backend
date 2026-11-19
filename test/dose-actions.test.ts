import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import {
  InMemoryDocumentRepository,
  InMemoryExtractionJobRepository,
  InMemoryPrescriptionRepository,
  InMemoryMedicationRepository,
  InMemoryPatientProfileRepository,
} from '../src/modules/persistence/repositories.js';

const API = '/api/v1';
const A = 'pat_userA';
const TOKEN_A = 'Bearer mock-access-jwt-userA';
const TOKEN_B = 'Bearer mock-access-jwt-userB';
const HOUR = 60 * 60 * 1000;

describe('Phase 4b task 16: dose actions for S06 and S07', () => {
  let app: Express;
  let medicationRepo: InMemoryMedicationRepository;
  let profileRepo: InMemoryPatientProfileRepository;
  let pastDoseId: string;
  let futureDoseId: string;

  beforeEach(async () => {
    const docRepo = new InMemoryDocumentRepository();
    const jobRepo = new InMemoryExtractionJobRepository();
    const prescriptionRepo = new InMemoryPrescriptionRepository(jobRepo, docRepo);
    medicationRepo = new InMemoryMedicationRepository(prescriptionRepo, docRepo);
    prescriptionRepo.setMedicationRepository(medicationRepo);
    profileRepo = new InMemoryPatientProfileRepository();
    app = createApp({ docRepo, jobRepo, prescriptionRepo, medicationRepo, patientProfileRepo: profileRepo });

    // No reminder times, so nothing else generates doses: the test owns every dose that exists.
    const med = await medicationRepo.createMedication({ patientProfileId: A, nameAsWritten: 'Testmed A 500 mg', dosageForm: 'TABLET' });
    const now = Date.now();
    const [past, future] = await medicationRepo.createDoseLogs([
      { medicationId: med.id, patientProfileId: A, scheduledTime: new Date(now - 2 * HOUR) },
      { medicationId: med.id, patientProfileId: A, scheduledTime: new Date(now + 3 * HOUR) },
    ]);
    pastDoseId = past.id;
    futureDoseId = future.id;
  });

  const post = (doseId: string, body: object, token = TOKEN_A) =>
    request(app).post(`${API}/medications/doses/${doseId}/action`).set('Authorization', token).send(body);
  const patch = (doseId: string, body: object, token = TOKEN_A) =>
    request(app).patch(`${API}/medications/doses/${doseId}/action`).set('Authorization', token).send(body);
  const stored = async (doseId: string) => (await medicationRepo.getDoseLogById(doseId, A))!;

  describe('Missed comes only from the patient', () => {
    it('POST accepts MISSED on a due dose', async () => {
      const res = await post(pastDoseId, { action: 'MISSED' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('MISSED');
      expect((await stored(pastDoseId)).status).toBe('MISSED');
    });

    it('PATCH accepts MISSED as a correction', async () => {
      await post(pastDoseId, { action: 'TAKEN' });
      const res = await patch(pastDoseId, { action: 'MISSED' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('MISSED');
    });

    it.each(['POST', 'PATCH'])('%s refuses MISSED on a dose that is not due yet', async (method) => {
      const res = method === 'POST' ? await post(futureDoseId, { action: 'MISSED' }) : await patch(futureDoseId, { action: 'MISSED' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ACTION');
      expect((await stored(futureDoseId)).status).toBe('PENDING');
    });

    it("another patient's MISSED gets 404 and changes nothing", async () => {
      expect((await post(pastDoseId, { action: 'MISSED' }, TOKEN_B)).status).toBe(404);
      expect((await patch(pastDoseId, { action: 'MISSED' }, TOKEN_B)).status).toBe(404);
      expect((await stored(pastDoseId)).status).toBe('PENDING');
    });
  });

  describe('nothing marks Taken or Missed without an explicit call', () => {
    it('reading doses leaves a past unrecorded dose PENDING (Not confirmed)', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .get(`${API}/medications/doses`)
          .query({ from: new Date(Date.now() - 6 * HOUR).toISOString(), to: new Date(Date.now() + 6 * HOUR).toISOString() })
          .set('Authorization', TOKEN_A);
        expect(res.status).toBe(200);
        const dose = res.body.data.find((d: any) => d.id === pastDoseId);
        expect(dose.status).toBe('PENDING');
        expect(dose.actionTime).toBeUndefined();
      }
      await request(app).get(`${API}/medications`).set('Authorization', TOKEN_A);
      expect((await stored(pastDoseId)).status).toBe('PENDING');
    });

    it('a snooze stays a snooze', async () => {
      const res = await post(pastDoseId, { action: 'SNOOZED', snoozeMinutes: 15 });
      expect(res.body.data.status).toBe('SNOOZED');
      expect((await stored(pastDoseId)).status).toBe('SNOOZED');
    });

    it('a refused call leaves the dose exactly as it was', async () => {
      await post(pastDoseId, { action: 'MISSED', actionTime: new Date(Date.now() + HOUR).toISOString() });
      await post(pastDoseId, { action: 'TAKEN', skipReason: 'RAN_OUT' });
      const dose = await stored(pastDoseId);
      expect(dose.status).toBe('PENDING');
      expect(dose.actionTime).toBeFalsy();
    });
  });

  describe('Undo (PATCH to PENDING)', () => {
    it.each(['MISSED', 'TAKEN', 'SKIPPED'])('after %s returns the dose to PENDING with no trace left', async (action) => {
      await post(pastDoseId, action === 'SKIPPED' ? { action, skipReason: 'FELT_UNWELL', notes: 'n' } : { action, notes: 'n' });
      const res = await patch(pastDoseId, { action: 'PENDING' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.actionTime).toBeUndefined();
      expect(res.body.data.skipReason).toBeUndefined();
      expect(res.body.data.notes).toBeUndefined();
      const dose = await stored(pastDoseId);
      expect(dose.status).toBe('PENDING');
      expect(dose.status).not.toBe('MISSED');
      expect(dose.actionTime).toBeFalsy();
    });
  });

  describe('actionTime', () => {
    it('refuses a future actionTime with 400 VALIDATION_ERROR on actionTime', async () => {
      const res = await post(pastDoseId, { action: 'TAKEN', actionTime: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fields).toEqual([{ path: 'actionTime', message: 'actionTime cannot be in the future' }]);
      expect((await stored(pastDoseId)).status).toBe('PENDING');
    });

    it('accepts a past actionTime ("other time")', async () => {
      const at = new Date(Date.now() - HOUR).toISOString();
      const res = await post(pastDoseId, { action: 'TAKEN', actionTime: at });
      expect(res.status).toBe(200);
      expect(new Date(res.body.data.actionTime).toISOString()).toBe(at);
    });

    it('allows a few seconds of phone clock drift', async () => {
      const res = await post(pastDoseId, { action: 'TAKEN', actionTime: new Date(Date.now() + 20_000).toISOString() });
      expect(res.status).toBe(200);
    });
  });

  describe('skip reason', () => {
    it.each(['FELT_UNWELL', 'DOCTOR_ADVISED', 'RAN_OUT', 'SIDE_EFFECTS', 'OTHER'])('stores %s with SKIPPED', async (reason) => {
      const res = await post(pastDoseId, { action: 'SKIPPED', skipReason: reason });
      expect(res.status).toBe(200);
      expect(res.body.data.skipReason).toBe(reason);
      expect((await stored(pastDoseId)).skipReason).toBe(reason);
    });

    it('is optional', async () => {
      const res = await post(pastDoseId, { action: 'SKIPPED' });
      expect(res.status).toBe(200);
      expect(res.body.data.skipReason).toBeUndefined();
    });

    it('refuses an unknown reason and a reason with any other action', async () => {
      expect((await post(pastDoseId, { action: 'SKIPPED', skipReason: 'BORED' })).status).toBe(400);
      for (const action of ['TAKEN', 'MISSED', 'SNOOZED']) {
        const res = await post(pastDoseId, { action, skipReason: 'RAN_OUT' });
        expect(res.status).toBe(400);
        expect(res.body.error.fields[0].path).toBe('skipReason');
      }
      expect((await patch(pastDoseId, { action: 'TAKEN', skipReason: 'RAN_OUT' })).status).toBe(400);
    });

    it('is cleared when a skip is corrected to Taken', async () => {
      await post(pastDoseId, { action: 'SKIPPED', skipReason: 'SIDE_EFFECTS' });
      const res = await patch(pastDoseId, { action: 'TAKEN' });
      expect(res.body.data.status).toBe('TAKEN');
      expect(res.body.data.skipReason).toBeUndefined();
    });

    it('PATCH can set a reason when correcting to SKIPPED', async () => {
      await post(pastDoseId, { action: 'TAKEN' });
      const res = await patch(pastDoseId, { action: 'SKIPPED', skipReason: 'DOCTOR_ADVISED' });
      expect(res.body.data.skipReason).toBe('DOCTOR_ADVISED');
    });
  });

  describe('GET /auth/me fullName', () => {
    it("returns the patient's own name", async () => {
      profileRepo.setFullName(A, 'Asha Test');
      const res = await request(app).get(`${API}/auth/me`).set('Authorization', TOKEN_A);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ userId: 'userA', email: expect.any(String), patientProfileId: A, fullName: 'Asha Test' });
    });

    it('leaves fullName out when none was given (blank or the signup placeholder)', async () => {
      for (const name of [undefined, '  ', 'Patient Profile']) {
        if (name !== undefined) profileRepo.setFullName(A, name);
        const res = await request(app).get(`${API}/auth/me`).set('Authorization', TOKEN_A);
        expect(res.status).toBe(200);
        expect(res.body.data).not.toHaveProperty('fullName');
      }
    });

    it("never returns another patient's name", async () => {
      profileRepo.setFullName(A, 'Asha Test');
      const res = await request(app).get(`${API}/auth/me`).set('Authorization', TOKEN_B);
      expect(res.body.data.patientProfileId).not.toBe(A);
      expect(JSON.stringify(res.body)).not.toContain('Asha');
    });
  });
});
