import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('Auth Middleware & Server-Side Ownership', () => {
  const app = createApp();

  it('rejects unauthenticated requests to protected endpoints with 401', async () => {
    const res = await request(app).get('/api/v1/patient/profile');
    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty('code', 'UNAUTHORIZED');
  });

  it('rejects invalid or forged bearer tokens with 401', async () => {
    const res = await request(app)
      .get('/api/v1/patient/profile')
      .set('Authorization', 'Bearer invalid-forged-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty('code', 'UNAUTHORIZED');
  });

  it('allows verified tokens and derives patientProfileId exclusively on the server', async () => {
    const validToken = 'Bearer mock-access-jwt-user123';
    const res = await request(app)
      .get('/api/v1/patient/profile')
      .set('Authorization', validToken);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('userId', 'user123');
    expect(res.body.data).toHaveProperty('patientProfileId', 'pat_user123');
  });

  it('rejects cross-patient access when User A requests User B resource with 404', async () => {
    const userAToken = 'Bearer mock-access-jwt-userA';
    // User A attempts to access records belonging to userB (patient profile pat_userB)
    const res = await request(app)
      .get('/api/v1/patient/pat_userB/records')
      .set('Authorization', userAToken);

    // Invariant: returns 404 to prevent ID enumeration
    expect(res.status).toBe(404);
    expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
  });

  it('allows access when authenticated user accesses their own resource', async () => {
    const userAToken = 'Bearer mock-access-jwt-userA';
    const res = await request(app)
      .get('/api/v1/patient/pat_userA/records')
      .set('Authorization', userAToken);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('patientProfileId', 'pat_userA');
  });
});
