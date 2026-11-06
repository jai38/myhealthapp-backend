import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { envSchema } from '../src/config/env.js';

describe('GET /api/v1/app-status', () => {
  it('returns non-blocking defaults without a token', async () => {
    const res = await request(createApp()).get('/api/v1/app-status');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      data: { minVersion: '0.0.0', latestVersion: '0.0.0', maintenance: { active: false } },
    });
  });

  it('returns configured versions', async () => {
    const app = createApp({
      appStatus: { minVersion: '1.2.0', latestVersion: '1.4.1', maintenance: false },
    });
    const res = await request(app).get('/api/v1/app-status');
    expect(res.body.data.minVersion).toBe('1.2.0');
    expect(res.body.data.latestVersion).toBe('1.4.1');
  });

  it('reports maintenance with its message', async () => {
    const app = createApp({
      appStatus: {
        minVersion: '0.0.0',
        latestVersion: '0.0.0',
        maintenance: true,
        maintenanceMessage: 'Back shortly.',
      },
    });
    const res = await request(app).get('/api/v1/app-status');
    expect(res.body.data.maintenance).toEqual({ active: true, message: 'Back shortly.' });
  });
});

describe('app-status env parsing', () => {
  it('uses non-blocking defaults', () => {
    const r = envSchema.parse({});
    expect(r.APP_MIN_VERSION).toBe('0.0.0');
    expect(r.APP_LATEST_VERSION).toBe('0.0.0');
    expect(r.APP_MAINTENANCE).toBe(false);
  });

  it('parses maintenance flag', () => {
    expect(envSchema.parse({ APP_MAINTENANCE: 'true' }).APP_MAINTENANCE).toBe(true);
  });

  it('accepts "false" for maintenance', () => {
    expect(envSchema.parse({ APP_MAINTENANCE: 'false' }).APP_MAINTENANCE).toBe(false);
  });

  it.each(['yes', '1', 'on', 'TRUE', 'tru', ''])('rejects APP_MAINTENANCE %j without echoing the value', (v) => {
    const r = envSchema.safeParse({ APP_MAINTENANCE: v });
    expect(r.success).toBe(false);
    if (!r.success) {
      const text = JSON.stringify(r.error.issues);
      expect(text).toContain('APP_MAINTENANCE');
      if (v) expect(text.replace('APP_MAINTENANCE', '')).not.toContain(`"${v}"`);
    }
  });

  it('rejects APP_MIN_VERSION greater than APP_LATEST_VERSION', () => {
    expect(envSchema.safeParse({ APP_MIN_VERSION: '1.4.0', APP_LATEST_VERSION: '1.3.9' }).success).toBe(false);
    expect(envSchema.safeParse({ APP_MIN_VERSION: '2.0.0', APP_LATEST_VERSION: '1.9.9' }).success).toBe(false);
    expect(envSchema.safeParse({ APP_MIN_VERSION: '1.10.0', APP_LATEST_VERSION: '1.9.0' }).success).toBe(false);
  });

  it('accepts APP_MIN_VERSION less than or equal to APP_LATEST_VERSION', () => {
    expect(envSchema.safeParse({ APP_MIN_VERSION: '1.9.0', APP_LATEST_VERSION: '1.10.0' }).success).toBe(true);
    expect(envSchema.safeParse({ APP_MIN_VERSION: '1.2.3', APP_LATEST_VERSION: '1.2.3' }).success).toBe(true);
    expect(envSchema.safeParse({ APP_MIN_VERSION: '0.0.0', APP_LATEST_VERSION: '0.0.0' }).success).toBe(true);
  });

  it.each(['1.2','v1.2.3', '1.2.3-beta', 'abc', ''])('rejects invalid semver %j', (v) => {
    expect(envSchema.safeParse({ APP_MIN_VERSION: v }).success).toBe(false);
    expect(envSchema.safeParse({ APP_LATEST_VERSION: v }).success).toBe(false);
  });
});
