import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MockAuthProviderAdapter } from '../src/modules/auth/auth-adapter.js';

describe('Authentication Endpoints & Provider Integration', () => {
  const mockAdapter = new MockAuthProviderAdapter();
  const app = createApp({ authAdapter: mockAdapter });

  it('successfully signs up a new user with valid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({
        email: 'testuser@example.com',
        password: 'securePassword123!',
        fullName: 'Jane Doe',
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('user');
    expect(res.body.data.user.email).toBe('testuser@example.com');
    expect(res.body.data.session).toHaveProperty('accessToken');
    expect(res.body.data.session).toHaveProperty('patientProfileId');
  });

  it('rejects signup with invalid email format', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({
        email: 'not-an-email',
        password: 'securePassword123!',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('rejects signup with short password (< 8 chars)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({
        email: 'shortpass@example.com',
        password: '123',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  it('successfully logs in with valid credentials', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'testuser@example.com',
        password: 'securePassword123!',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.session).toHaveProperty('accessToken');
    expect(res.body.data.session).toHaveProperty('patientProfileId');
  });

  it('retrieves /auth/me for authenticated user session', async () => {
    const signupRes = await request(app)
      .post('/api/v1/auth/signup')
      .send({
        email: 'me-test@example.com',
        password: 'securePassword123!',
      });

    const token = signupRes.body.data.session.accessToken;

    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.data).toHaveProperty('userId');
    expect(meRes.body.data).toHaveProperty('patientProfileId');
  });

  it('rejects /auth/me without authorization header with 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty('code', 'UNAUTHORIZED');
  });
});
