import type { PrismaClient } from '@prisma/client';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { resolveS3ClientConfig, validateStorageKey } from '../../modules/storage/storage-keys.js';
import { PASSWORD_HASH_PLACEHOLDER, SEED_EMAIL_DOMAIN, World } from './builder.js';
import { RenderedFile, inspectImage, renderPdf, renderPlaceholderPng, sha256 } from './files.js';

/** Where generated prescription images live in the bucket, outside documents/ so no patient key can reach them. */
export const SEED_ASSETS_PREFIX = 'seed-assets/';

export class SeedStorage {
  private readonly client: S3Client;
  readonly bucket: string;

  constructor() {
    const resolved = resolveS3ClientConfig();
    this.client = new S3Client(resolved.clientConfig);
    this.bucket = resolved.bucket;
  }

  async put(storageKey: string, patientProfileId: string, bytes: Buffer, mimeType: string): Promise<void> {
    validateStorageKey(storageKey, patientProfileId);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, Body: bytes, ContentType: mimeType }));
  }

  async deletePatientFiles(patientProfileId: string): Promise<void> {
    const prefix = `documents/${patientProfileId}/`;
    let token: string | undefined;
    do {
      const list = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (list.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k) && (k as string).startsWith(prefix));
      if (keys.length > 0) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }

  /** A generated template image from seed-assets/<ID>.png|jpg, or null when there is none. */
  async getSeedAsset(templateId: string): Promise<Buffer | null> {
    for (const ext of ['png', 'jpg', 'jpeg']) {
      try {
        const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: `${SEED_ASSETS_PREFIX}${templateId}.${ext}` }));
        if (res.Body) return Buffer.from(await res.Body.transformToByteArray());
      } catch {
        // Not there: try the next extension.
      }
    }
    return null;
  }
}

export type ImageSource = (templateId: string) => Promise<Buffer | null>;

export interface WriteOptions {
  passwordHash: string;
  storage: SeedStorage | null;
  images: ImageSource | null;
  reset: boolean;
  log: (line: string) => void;
}

const CHUNK = 2000;

async function inChunks<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  }));
}

/** Deletes every seeded account (and its files). Real sign-ups in dev are left alone. */
export async function removeSeedUsers(prisma: PrismaClient, storage: SeedStorage | null, log: (l: string) => void): Promise<number> {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: `@${SEED_EMAIL_DOMAIN}` } },
    select: { id: true, patientProfile: { select: { id: true } } },
  });
  if (users.length === 0) return 0;
  if (storage) {
    const profileIds = users.map((u) => u.patientProfile?.id).filter((id): id is string => Boolean(id));
    await pool(profileIds, 8, (id) => storage.deletePatientFiles(id));
  }
  const ids = users.map((u) => u.id);
  await prisma.auditEvent.deleteMany({ where: { userId: { in: ids } } });
  // Cascades through profiles, documents, prescriptions, medications, doses and tokens.
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  log(`Removed ${users.length} seeded accounts.`);
  return users.length;
}

/** Turns each document's file spec into bytes, then fills size, checksum and dimensions from them. */
export async function renderFiles(world: World, images: ImageSource | null, log: (l: string) => void): Promise<Map<string, RenderedFile>> {
  const rendered = new Map<string, RenderedFile>();
  const templateCache = new Map<string, RenderedFile | null>();
  let usedImages = 0;

  for (const doc of world.documents) {
    const id = doc.id as string;
    const spec = world.files.get(id);
    if (!spec) throw new Error(`No file spec for document ${id}`);

    let file: RenderedFile | undefined;
    if (spec.sameBytesAs) file = rendered.get(spec.sameBytesAs);
    if (!file && spec.templateId && images) {
      if (!templateCache.has(spec.templateId)) {
        const buf = await images(spec.templateId);
        templateCache.set(spec.templateId, buf ? inspectImage(buf, spec.templateId) : null);
      }
      file = templateCache.get(spec.templateId) ?? undefined;
      if (file) usedImages++;
    }
    if (!file) file = spec.kind === 'pdf' ? await renderPdf(spec, id) : renderPlaceholderPng(spec, id);

    rendered.set(id, file);
    doc.mimeType = file.mimeType;
    doc.fileSizeBytes = file.bytes.length;
    doc.sha256Checksum = sha256(file.bytes);
    doc.imageWidth = file.width;
    doc.imageHeight = file.height;
    doc.pageCount = file.pageCount;
    if (spec.templateId && file.mimeType === 'image/jpeg') doc.originalFilename = doc.originalFilename.replace(/\.png$/, '.jpg');
  }
  const found = [...templateCache.values()].filter(Boolean).length;
  log(`Rendered ${rendered.size} files (${usedImages} documents use ${found} generated handwritten images; the rest are PDFs or placeholders).`);
  return rendered;
}

export async function writeWorld(prisma: PrismaClient, world: World, opts: WriteOptions): Promise<void> {
  const existing = await prisma.user.count({ where: { email: { endsWith: `@${SEED_EMAIL_DOMAIN}` } } });
  if (existing > 0 && !opts.reset) {
    throw new Error(`${existing} seeded accounts already exist. Re-run with --reset to replace them.`);
  }
  if (opts.reset) await removeSeedUsers(prisma, opts.storage, opts.log);

  const files = await renderFiles(world, opts.images, opts.log);

  for (const u of world.users) {
    if (u.passwordHash === PASSWORD_HASH_PLACEHOLDER) u.passwordHash = opts.passwordHash;
  }

  const steps: Array<[string, () => Promise<void>]> = [
    ['users', () => inChunks(world.users, (data) => prisma.user.createMany({ data }))],
    ['patient profiles', () => inChunks(world.profiles, (data) => prisma.patientProfile.createMany({ data }))],
    ['preferences', () => inChunks(world.preferences, (data) => prisma.userPreferences.createMany({ data }))],
    ['documents', () => inChunks(world.documents, (data) => prisma.document.createMany({ data }))],
    ['upload intents', () => inChunks(world.uploadIntents, (data) => prisma.uploadIntent.createMany({ data }))],
    ['extraction jobs', () => inChunks(world.jobs, (data) => prisma.extractionJob.createMany({ data }))],
    ['prescriptions', () => inChunks(world.prescriptions, (data) => prisma.prescription.createMany({ data }))],
    ['prescription items', () => inChunks(world.items, (data) => prisma.prescriptionItem.createMany({ data }))],
    ['medications', () => inChunks(world.medications, (data) => prisma.medication.createMany({ data }))],
    ['dose logs', () => inChunks(world.doses, (data) => prisma.doseLog.createMany({ data }))],
    ['timeline events', () => inChunks(world.timeline, (data) => prisma.timelineEvent.createMany({ data }))],
    ['audit events', () => inChunks(world.audits, (data) => prisma.auditEvent.createMany({ data }))],
  ];
  for (const [name, run] of steps) {
    await run();
    opts.log(`  wrote ${name}`);
  }

  if (opts.storage) {
    const storage = opts.storage;
    let done = 0;
    await pool(world.documents, 16, async (doc) => {
      const file = files.get(doc.id as string);
      if (!file) return;
      await storage.put(doc.storageKey, doc.patientProfileId, file.bytes, file.mimeType);
      done++;
      if (done % 500 === 0) opts.log(`  uploaded ${done}/${world.documents.length} files`);
    });
    opts.log(`Uploaded ${done} files to bucket ${storage.bucket}.`);
  } else {
    opts.log('Files not uploaded (--no-files): documents will show as missing in the viewer.');
  }
}
