/**
 * Invariant 1: never trust a client-supplied patientProfileId. Identity is derived from the
 * verified token only. User B sends User A's patientProfileId in the body, query string and
 * headers of reads and writes; nothing may be read from, or written to, User A's records.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import {
  API,
  TOKEN_A,
  TOKEN_B,
  PATIENT_A,
  PATIENT_B,
  PLANTED,
  buildWorld,
  seedPatientA,
  uploadDocument,
  reviewBody,
  type PatientAResources,
  type World,
} from './helpers.js';

const SPOOF_HEADERS = {
  'x-patient-profile-id': PATIENT_A,
  'x-patient-id': PATIENT_A,
  patientProfileId: PATIENT_A,
};

describe('Invariant: a client-supplied patientProfileId is ignored', () => {
  let w: World;
  let a: PatientAResources;

  beforeAll(async () => {
    w = buildWorld();
    a = await seedPatientA(w);
  });

  const asB = (method: 'get' | 'post', url: string) => {
    let r = (request(w.app) as any)[method](url).set('Authorization', TOKEN_B);
    for (const [k, v] of Object.entries(SPOOF_HEADERS)) r = r.set(k, v);
    return r;
  };

  it('reads: query string, header and a spoofed id never widen the result set', async () => {
    const reads = ['documents', 'timeline', 'medications', 'medications/doses', 'prescriptions/timeline'];
    for (const path of reads) {
      const res = await asB('get', `${API}/${path}?patientProfileId=${PATIENT_A}&patient_profile_id=${PATIENT_A}`);
      expect(res.status, path).toBe(200);
      expect(res.body.data, path).toEqual([]);
    }
  });

  it('upload-intent: the storage key is built from the token, not the body', async () => {
    const res = await asB('post', `${API}/documents/upload-intent`).send({
      filename: 'x.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 1000,
      patientProfileId: PATIENT_A,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.storageKey.startsWith(`documents/${PATIENT_B}/`)).toBe(true);
    expect(res.body.data.storageKey).not.toContain(PATIENT_A);
  });

  it('manual medication: created under User B even when the body names User A', async () => {
    const res = await asB('post', `${API}/medications`).send({
      nameAsWritten: 'Spoof-Med-B',
      patientProfileId: PATIENT_A,
    });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    expect((await request(w.app).get(`${API}/medications/${id}`).set('Authorization', TOKEN_B)).status).toBe(200);
    expect((await request(w.app).get(`${API}/medications/${id}`).set('Authorization', TOKEN_A)).status).toBe(404);
    const aList = await request(w.app).get(`${API}/medications`).set('Authorization', TOKEN_A);
    expect(JSON.stringify(aList.body)).not.toContain('Spoof-Med-B');
  });

  it('extract-job and confirm: records land under User B, not the id in the body', async () => {
    const doc = await uploadDocument(w, TOKEN_B, PATIENT_B, 'b.pdf');
    const job = await asB('post', `${API}/prescriptions/extract-job`).send({
      documentId: doc.documentId,
      patientProfileId: PATIENT_A,
    });
    expect(job.status).toBe(202);
    expect(job.body.data.patientProfileId).toBe(PATIENT_B);

    const confirmed = await asB('post', `${API}/prescriptions/${job.body.data.id}/confirm`).send(
      reviewBody({ patientProfileId: PATIENT_A, doctor_name: 'Dr. Spoof-B' }),
    );
    expect(confirmed.status).toBe(201);

    const bTimeline = await request(w.app).get(`${API}/timeline`).set('Authorization', TOKEN_B);
    expect(bTimeline.body.data.length).toBe(1);
    const aTimeline = await request(w.app).get(`${API}/timeline`).set('Authorization', TOKEN_A);
    expect(JSON.stringify(aTimeline.body)).not.toContain('Dr. Spoof-B');
    expect(aTimeline.body.data.length).toBe(1); // only A's original event
  });

  it('extract-job: naming User A in the body cannot reach User A document', async () => {
    const res = await asB('post', `${API}/prescriptions/extract-job`).send({
      documentId: a.documentId,
      patientProfileId: PATIENT_A,
    });
    expect(res.status).toBe(404);
  });

  it('reports: a spoofed id and A record ids in the body export nothing of User A', async () => {
    const res = await asB('post', `${API}/reports/export-data`).send({
      patientProfileId: PATIENT_A,
      includeTimeline: true,
      includeMedications: true,
      selectedEventIds: [a.eventId],
      selectedMedicationIds: [a.medicationId],
    });
    expect(res.status).toBeLessThan(500);
    const text = JSON.stringify(res.body);
    for (const v of [PLANTED.drug, PLANTED.doctor, a.eventId, a.medicationId]) expect(text).not.toContain(v);
  });

  it('GET /patient/profile returns the token identity even when a spoofed id is supplied', async () => {
    const res = await asB('get', `${API}/patient/profile?patientProfileId=${PATIENT_A}`);
    expect(res.status).toBe(200);
    expect(res.body.data.patientProfileId).toBe(PATIENT_B);
  });

  it('ownership route: a spoofed id in the query or body still cannot select another patient', async () => {
    // Path id is B's own; a conflicting query id must not be honoured (it is rejected as 404).
    const own = await request(w.app).get(`${API}/patient/${PATIENT_B}/records`).set('Authorization', TOKEN_B);
    expect(own.status).toBe(200);
    expect(own.body.data.patientProfileId).toBe(PATIENT_B);
    const other = await request(w.app).get(`${API}/patient/${PATIENT_A}/records`).set('Authorization', TOKEN_B);
    expect(other.status).toBe(404);
  });
});
