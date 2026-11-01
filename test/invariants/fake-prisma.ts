/**
 * Minimal in-memory stand-in for the Prisma calls the auth adapter makes, so the invariant kit
 * can run the real DatabaseAuthProviderAdapter and inspect the audit rows it writes.
 *
 * Deliberate copy of createFakePrisma() in test/auth-database-adapter.test.ts: that helper lives
 * inside a test file and is not exported, and importing a test file would register its suites.
 * If the original is ever moved to a shared module, delete this copy and import it.
 */
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

type Row = Record<string, any>;

export function createFakePrisma() {
  const tables: Record<string, Row[]> = {
    user: [],
    patientProfile: [],
    emailVerificationToken: [],
    passwordResetToken: [],
    refreshToken: [],
    auditEvent: [],
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));

  const delegate = (name: string) => ({
    create: async ({ data }: { data: Row }) => {
      if (name === 'user' && tables.user.some((u) => u.email === data.email)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      // Audit rows get only their real columns, so the test sees exactly what the adapter wrote.
      const defaults =
        name === 'auditEvent'
          ? { id: crypto.randomUUID(), createdAt: new Date() }
          : { id: crypto.randomUUID(), createdAt: new Date(), revokedAt: null, passwordChangedAt: null, isVerified: false };
      const row = { ...defaults, ...data };
      tables[name].push(row);
      return row;
    },
    findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = tables[name].find((r) => matches(r, where));
      if (!row) return null;
      if (name === 'user' && include?.patientProfile) {
        return { ...row, patientProfile: tables.patientProfile.find((p) => p.userId === row.id) ?? null };
      }
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = tables[name].find((r) => matches(r, where));
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = tables[name].filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const doomed = tables[name].filter((r) => matches(r, where));
      tables[name] = tables[name].filter((r) => !doomed.includes(r));
      if (name === 'user') {
        for (const u of doomed) {
          for (const t of ['emailVerificationToken', 'passwordResetToken', 'refreshToken']) {
            tables[t] = tables[t].filter((r) => r.userId !== u.id);
          }
        }
      }
      return { count: doomed.length };
    },
  });

  const client: any = {
    user: delegate('user'),
    patientProfile: delegate('patientProfile'),
    emailVerificationToken: delegate('emailVerificationToken'),
    passwordResetToken: delegate('passwordResetToken'),
    refreshToken: delegate('refreshToken'),
    auditEvent: delegate('auditEvent'),
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      const snapshot = new Map<string, Row[]>();
      for (const [k, v] of Object.entries(tables)) snapshot.set(k, v.map((r) => ({ ...r })));
      try {
        return await fn(client);
      } catch (err) {
        for (const [k, v] of snapshot) tables[k] = v;
        throw err;
      }
    },
  };
  return { client: client as PrismaClient, tables };
}
