import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('GET /healthz', () => {
  const app = createApp();

  it('returns 200 OK with service metadata', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('service', 'myhealthapp-backend');
    expect(res.body).toHaveProperty('timestamp');
  });
});
