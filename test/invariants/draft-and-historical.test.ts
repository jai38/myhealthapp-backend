/**
 * Invariants 8 and 9, only the parts the existing suites do not already prove.
 *
 * Already proven elsewhere (not repeated here):
 *   - AI draft absent from /timeline and /prescriptions/timeline: timeline.test.ts,
 *     extraction-pipeline.test.ts
 *   - AI draft absent from reports: report.test.ts ("unreviewed AI extraction drafts are NEVER included")
 *   - Confirmed items start INACTIVE with no reminderTimes: medication.test.ts RULE A
 *
 * Added here: a succeeded-but-unconfirmed AI draft creates no medication, no dose, no report row
 * and no stored prescription; a confirmed historical prescription creates no dose occurrences at
 * all (not only "inactive"); and omitting is_active_medication defaults to inactive.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import {
  API,
  TOKEN_A,
  buildWorld,
  uploadDocument,
  reviewBody,
  PATIENT_A,
  PLANTED,
  type World,
} from './helpers.js';

describe('Invariant: AI output is a draft until the patient confirms', () => {
  let w: World;
  let jobId: string;

  beforeEach(async () => {
    w = buildWorld();
    const doc = await uploadDocument(w, TOKEN_A, PATIENT_A);
    const job = await request(w.app).post(`${API}/prescriptions/extract-job`).set('Authorization', TOKEN_A).send({ documentId: doc.documentId });
    expect(job.status).toBe(202);
    expect(job.body.data.status).toBe('SUCCEEDED');
    jobId = job.body.data.id;
  });

  it('an unconfirmed SUCCEEDED extraction creates no medication, no dose and no report record', async () => {
    const meds = await request(w.app).get(`${API}/medications`).set('Authorization', TOKEN_A);
    expect(meds.body.data).toEqual([]);
    const doses = await request(w.app).get(`${API}/medications/doses`).set('Authorization', TOKEN_A);
    expect(doses.body.data).toEqual([]);
    const exp = await request(w.app).post(`${API}/reports/export-data`).set('Authorization', TOKEN_A)
      .send({ includeTimeline: true, includeMedications: true });
    expect(exp.status).toBe(200);
    expect(exp.body.data.summary.totalRecords).toBe(0);
    const timeline = await request(w.app).get(`${API}/timeline`).set('Authorization', TOKEN_A);
    expect(timeline.body.data).toEqual([]);
  });

  it('the draft payload the job exposes is not reachable as a prescription before confirmation', async () => {
    const job = await request(w.app).get(`${API}/prescriptions/extract-job/${jobId}`).set('Authorization', TOKEN_A);
    expect(job.status).toBe(200);
    const byJobId = await request(w.app).get(`${API}/prescriptions/${jobId}`).set('Authorization', TOKEN_A);
    expect(byJobId.status).toBe(404);
  });

  it('a rejected review (invalid payload) leaves nothing behind', async () => {
    const res = await request(w.app).post(`${API}/prescriptions/${jobId}/confirm`).set('Authorization', TOKEN_A)
      .send({ medicines: [] });
    expect(res.status).toBe(400);
    const timeline = await request(w.app).get(`${API}/timeline`).set('Authorization', TOKEN_A);
    expect(timeline.body.data).toEqual([]);
    const meds = await request(w.app).get(`${API}/medications`).set('Authorization', TOKEN_A);
    expect(meds.body.data).toEqual([]);
  });

  describe('historical prescriptions', () => {
    const confirm = (medOverrides: Record<string, unknown> = {}, omitFlag = false) => {
      const body: any = reviewBody({ prescription_date: '2024-01-15' }, medOverrides);
      if (omitFlag) delete body.medicines[0].is_active_medication;
      return request(w.app).post(`${API}/prescriptions/${jobId}/confirm`).set('Authorization', TOKEN_A).send(body);
    };

    it('creates no dose occurrences and no reminders when the flag is false', async () => {
      expect((await confirm({ is_active_medication: false })).status).toBe(201);
      const meds = await request(w.app).get(`${API}/medications`).set('Authorization', TOKEN_A);
      expect(meds.body.data).toHaveLength(1);
      expect(meds.body.data[0].status).toBe('INACTIVE');
      expect(meds.body.data[0].reminderTimes ?? []).toEqual([]);
      const doses = await request(w.app).get(`${API}/medications/doses`).set('Authorization', TOKEN_A);
      expect(doses.body.data).toEqual([]);
    });

    it('defaults to inactive with no doses when the flag is omitted', async () => {
      expect((await confirm({}, true)).status).toBe(201);
      const meds = await request(w.app).get(`${API}/medications`).set('Authorization', TOKEN_A);
      expect(meds.body.data[0].status).toBe('INACTIVE');
      const doses = await request(w.app).get(`${API}/medications/doses`).set('Authorization', TOKEN_A);
      expect(doses.body.data).toEqual([]);
    });

    it('even when the flag is true, confirming creates no reminder times and no doses until the patient schedules', async () => {
      expect((await confirm({ is_active_medication: true })).status).toBe(201);
      const meds = await request(w.app).get(`${API}/medications`).set('Authorization', TOKEN_A);
      expect(meds.body.data[0].reminderTimes ?? []).toEqual([]);
      const doses = await request(w.app).get(`${API}/medications/doses`).set('Authorization', TOKEN_A);
      expect(doses.body.data).toEqual([]);
    });

    it('activation is the only path to doses, and it needs explicit reminder times', async () => {
      await confirm({ is_active_medication: false });
      const meds = await request(w.app).get(`${API}/medications`).set('Authorization', TOKEN_A);
      const id = meds.body.data[0].id;
      const noTimes = await request(w.app).post(`${API}/medications/${id}/activate`).set('Authorization', TOKEN_A).send({});
      expect(noTimes.status).toBe(400);
      expect((await request(w.app).get(`${API}/medications/doses`).set('Authorization', TOKEN_A)).body.data).toEqual([]);
    });

    it('preserves nameAsWritten separately from the normalized name', async () => {
      await confirm();
      const meds = await request(w.app).get(`${API}/medications`).set('Authorization', TOKEN_A);
      expect(meds.body.data[0].nameAsWritten).toBe(PLANTED.drug);
    });
  });
});
