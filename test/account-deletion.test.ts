import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { MockAuthProviderAdapter } from '../src/modules/auth/auth-adapter.js';
import { MemoryStorageProvider } from '../src/modules/storage/storage-provider.js';
import { InMemoryDocumentRepository } from '../src/modules/persistence/repositories.js';

describe('DELETE /auth/account - storage and document scope', () => {
  let storage: MemoryStorageProvider;
  let docRepo: InMemoryDocumentRepository;
  let app: ReturnType<typeof createApp>;

  const tokenA = 'mock-access-jwt-userA'; // patient pat_userA
  const profileA = 'pat_userA';
  const profileB = 'pat_userB';

  const newKey = (profile: string) => `documents/${profile}/${crypto.randomUUID()}`;

  async function seedDocument(profile: string): Promise<{ key: string; id: string }> {
    const key = newKey(profile);
    const bytes = Buffer.from('%PDF-1.4 test');
    await storage.putObject(key, profile, bytes, 'application/pdf');
    const doc = await docRepo.create({
      patientProfileId: profile,
      storageKey: key,
      originalFilename: 'x.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: bytes.length,
      sha256Checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
      status: 'UPLOADED',
    });
    return { key, id: doc.id };
  }

  beforeEach(() => {
    storage = new MemoryStorageProvider();
    docRepo = new InMemoryDocumentRepository();
    app = createApp({
      authAdapter: new MockAuthProviderAdapter(),
      storageProvider: storage,
      docRepo,
    });
  });

  it('requires authentication', async () => {
    const res = await request(app).delete('/api/v1/auth/account');
    expect(res.status).toBe(401);
  });

  it('deletes all of the caller\'s storage objects and document rows, including objects with no document row', async () => {
    const a1 = await seedDocument(profileA);
    const a2 = await seedDocument(profileA);
    // An uploaded object that never became a document (abandoned or rejected intent).
    const orphanKey = newKey(profileA);
    await storage.putObject(orphanKey, profileA, Buffer.from('%PDF-1.4 orphan'), 'application/pdf');

    const res = await request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    for (const key of [a1.key, a2.key, orphanKey]) {
      expect((await storage.checkObjectExists(key, profileA)).exists).toBe(false);
    }
    expect(await docRepo.listByPatient(profileA)).toHaveLength(0);
  });

  it('never touches another patient\'s objects or documents', async () => {
    await seedDocument(profileA);
    const b1 = await seedDocument(profileB);
    // A key that merely shares a textual prefix with profile A's id must survive as well.
    const lookalikeProfile = `${profileA}x`;
    const lookalike = await seedDocument(lookalikeProfile);

    const res = await request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    expect((await storage.checkObjectExists(b1.key, profileB)).exists).toBe(true);
    expect(await docRepo.findById(b1.id)).not.toBeNull();
    expect((await storage.checkObjectExists(lookalike.key, lookalikeProfile)).exists).toBe(true);
    expect(await docRepo.findById(lookalike.id)).not.toBeNull();
  });

  it('ignores any identifier in the request: only the token decides what is deleted', async () => {
    await seedDocument(profileA);
    const b1 = await seedDocument(profileB);

    const res = await request(app)
      .delete(`/api/v1/auth/account?patientProfileId=${profileB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ patientProfileId: profileB, userId: 'userB' });
    expect(res.status).toBe(200);

    expect((await storage.checkObjectExists(b1.key, profileB)).exists).toBe(true);
    expect(await docRepo.findById(b1.id)).not.toBeNull();
  });

  it('does not delete the account when the storage purge fails, so the request can be retried', async () => {
    let deleted = false;
    class Adapter extends MockAuthProviderAdapter {
      async deleteAccount(userId: string): Promise<void> {
        deleted = true;
        return super.deleteAccount(userId);
      }
    }
    const failing = new MemoryStorageProvider();
    failing.deleteByPrefix = async () => {
      throw new Error('storage unavailable');
    };
    const failingApp = createApp({ authAdapter: new Adapter(), storageProvider: failing, docRepo });

    const res = await request(failingApp).delete('/api/v1/auth/account').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(500);
    expect(deleted).toBe(false);
  });
});

describe('storage deleteByPrefix guard', () => {
  it('refuses a prefix that is not exactly the caller\'s own', async () => {
    const storage = new MemoryStorageProvider();
    await expect(storage.deleteByPrefix('documents/pat_userB/', 'pat_userA')).rejects.toThrow(/Forbidden/);
    await expect(storage.deleteByPrefix('documents/', 'pat_userA')).rejects.toThrow(/Forbidden/);
    await expect(storage.deleteByPrefix('documents/pat_userA', 'pat_userA')).rejects.toThrow(/Forbidden/);
    await expect(storage.deleteByPrefix('documents/../', '..')).rejects.toThrow(/Forbidden/);
    await expect(storage.deleteByPrefix('documents//', '')).rejects.toThrow(/Forbidden/);
  });
});
