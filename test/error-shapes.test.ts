import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { z } from 'zod';
import type { Express, Request, Response } from 'express';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const API = '/api/v1';
const TOKEN = 'Bearer mock-access-jwt-userA';
const PLANTED = 'Asha Test Testmed A 500 mg';

function expectFields(body: any): void {
  expect(Array.isArray(body.error.fields)).toBe(true);
  expect(body.error.fields.length).toBeGreaterThan(0);
  for (const f of body.error.fields) {
    expect(typeof f.path).toBe('string');
    expect(typeof f.message).toBe('string');
  }
}

describe('Error shapes', () => {
  let app: Express;
  beforeAll(() => {
    app = createApp();
  });

  describe('a malformed JSON body', () => {
    const cases: Array<[string, string, string | undefined]> = [
      ['POST', `${API}/auth/login`, undefined],
      ['POST', `${API}/medications`, TOKEN],
      ['POST', `${API}/documents/confirm-upload`, TOKEN],
      ['POST', `${API}/reports/export-data`, TOKEN],
    ];

    it.each(cases)('%s %s answers 400 INVALID_JSON, not 500, and echoes nothing', async (_m, path, token) => {
      let req = request(app).post(path).set('Content-Type', 'application/json');
      if (token) req = req.set('Authorization', token);
      const res = await req.send(`{"nameAsWritten": "${PLANTED}",`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON' } });
      expect(JSON.stringify(res.body)).not.toContain('Asha');
    });

    it('a body over 1 MB answers 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await request(app)
        .post(`${API}/medications`)
        .set('Authorization', TOKEN)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ notes: 'x'.repeat(1024 * 1024 + 10) }));
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('validation failures share one shape: 400 with fields[{ path, message }]', () => {
    it('auth (message still joined, no details)', async () => {
      const res = await request(app).post(`${API}/auth/login`).send({ email: 'not-an-email', password: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(typeof res.body.error.message).toBe('string');
      expect(res.body.error.details).toBeUndefined();
      expectFields(res.body);
      expect(res.body.error.fields.map((f: any) => f.path)).toEqual(expect.arrayContaining(['email', 'password']));
    });

    it('prescription confirm (details kept as zod format output)', async () => {
      const res = await request(app)
        .post(`${API}/prescriptions/${crypto.randomUUID()}/confirm`)
        .set('Authorization', TOKEN)
        .send({ medicines: [] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toBeTypeOf('object');
      expectFields(res.body);
      expect(res.body.error.fields[0].path).toBe('medicines');
    });

    it('medications', async () => {
      const res = await request(app).post(`${API}/medications`).set('Authorization', TOKEN).send({ nameAsWritten: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toBeTypeOf('object');
      expectFields(res.body);
      expect(res.body.error.fields[0].path).toBe('nameAsWritten');
    });

    it('timeline query (code stays INVALID_QUERY_PARAMETERS)', async () => {
      const res = await request(app).get(`${API}/timeline`).query({ limit: '500' }).set('Authorization', TOKEN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_QUERY_PARAMETERS');
      expectFields(res.body);
      expect(res.body.error.fields[0].path).toBe('limit');
    });

    it('reports schema failure (details kept as the zod errors array)', async () => {
      const res = await request(app).post(`${API}/reports/export-data`).set('Authorization', TOKEN).send({ includeTimeline: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(res.body.error.details)).toBe(true);
      expectFields(res.body);
      expect(res.body.error.fields[0].path).toBe('includeTimeline');
    });

    it.each(['export-data', 'generate', 'generate-pdf'])(
      'reports/%s: a bad date range is VALIDATION_ERROR on startDate, never EMPTY_REPORT_ERROR',
      async (route) => {
        const res = await request(app)
          .post(`${API}/reports/${route}`)
          .set('Authorization', TOKEN)
          .send({ startDate: '2026-05-01', endDate: '2026-01-01', allowEmpty: true });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toEqual([{ path: 'startDate', message: expect.any(String) }]);
      }
    );

    it('reports/generate with no records still answers EMPTY_REPORT_ERROR', async () => {
      const res = await request(app).post(`${API}/reports/generate`).set('Authorization', TOKEN).send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('EMPTY_REPORT_ERROR');
    });
  });

  describe('the global handler', () => {
    function capture(): { res: Response; out: { status?: number; body?: any } } {
      const out: { status?: number; body?: any } = {};
      const res = {
        status(code: number) {
          out.status = code;
          return this;
        },
        json(body: unknown) {
          out.body = body;
          return this;
        },
      } as unknown as Response;
      return { res, out };
    }

    it('answers a stray ZodError with a plain 500, never 422 or field paths', () => {
      const parsed = z.object({ secretField: z.string() }).safeParse({});
      expect(parsed.success).toBe(false);
      const { res, out } = capture();
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        errorHandler((parsed as any).error, {} as Request, res, () => {});
      } finally {
        process.env.NODE_ENV = prev;
      }
      expect(out.status).toBe(500);
      expect(out.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    });

    it('does not treat an ordinary error with a status as a body error', () => {
      const err = Object.assign(new Error('boom'), { status: 400 });
      const { res, out } = capture();
      errorHandler(err, {} as Request, res, () => {});
      expect(out.status).toBe(500);
    });
  });
});
