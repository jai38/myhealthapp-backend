import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'net';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { S3StorageProvider } from '../src/modules/storage/storage-provider.js';
import {
  PrismaDocumentRepository,
  PrismaExtractionJobRepository,
  PrismaPrescriptionRepository,
  PrismaUploadIntentRepository,
} from '../src/modules/persistence/repositories.js';
import { getPrismaClient, checkDatabaseHealth } from '../src/modules/persistence/database.js';
import { PrismaClient } from '@prisma/client';

// Helper to check if a TCP port is open locally
function isPortOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isResolved = false;

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      isResolved = true;
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      isResolved = true;
      socket.destroy();
      resolve(false);
    });

    socket.once('error', () => {
      isResolved = true;
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

const isPostgresAvailable = await isPortOpen('localhost', 5432, 800);
const isMinioAvailable = await isPortOpen('localhost', 9000, 800);

describe.skipIf(!isPostgresAvailable || !isMinioAvailable)(
  'Durable PostgreSQL and MinIO Integration Suite',
  () => {
    let prisma: PrismaClient;
    let docRepo: PrismaDocumentRepository;
    let jobRepo: PrismaExtractionJobRepository;
    let rxRepo: PrismaPrescriptionRepository;
    let intentRepo: PrismaUploadIntentRepository;
    let s3Provider: S3StorageProvider;

    const testRunId = crypto.randomUUID();
    const testUserId = crypto.randomUUID();
    const testPatientProfileId = crypto.randomUUID();
    const testDocumentId = crypto.randomUUID();
    const testJobId = crypto.randomUUID();
    const testStorageKey = `documents/${testPatientProfileId}/integ-${testRunId}.pdf`;

    beforeAll(async () => {
      prisma = getPrismaClient();
      docRepo = new PrismaDocumentRepository(prisma);
      jobRepo = new PrismaExtractionJobRepository(prisma);
      rxRepo = new PrismaPrescriptionRepository(prisma);
      intentRepo = new PrismaUploadIntentRepository(prisma);
      s3Provider = new S3StorageProvider(intentRepo, {
        endpoint: 'http://localhost:9000',
        bucket: 'myhealthapp-documents',
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadminpassword',
      });
    });

    afterAll(async () => {
      // Reliable cleanup of isolated test data in reverse relation order
      try {
        await prisma.timelineEvent.deleteMany({ where: { patientProfileId: testPatientProfileId } });
        await prisma.prescriptionItem.deleteMany({ where: { sourceDocumentId: testDocumentId } });
        await prisma.prescription.deleteMany({ where: { patientProfileId: testPatientProfileId } });
        await prisma.extractionJob.deleteMany({ where: { patientProfileId: testPatientProfileId } });
        await prisma.uploadIntent.deleteMany({ where: { patientProfileId: testPatientProfileId } });
        await prisma.document.deleteMany({ where: { patientProfileId: testPatientProfileId } });
        await prisma.userPreferences.deleteMany({ where: { patientProfileId: testPatientProfileId } });
        await prisma.patientProfile.deleteMany({ where: { id: testPatientProfileId } });
        await prisma.user.deleteMany({ where: { id: testUserId } });
        await s3Provider.deleteObject(testStorageKey, testPatientProfileId).catch(() => {});
      } catch (err) {
        console.warn('Integration test cleanup warning:', err);
      }
    });

    it('applies migrations to clean database and creates test patient and document records', async () => {
      const health = await checkDatabaseHealth();
      expect(health.isConnected).toBe(true);

      // Create test user and patient profile
      const user = await prisma.user.create({
        data: {
          id: testUserId,
          email: `test-integ-${testRunId}@example.com`,
          isVerified: true,
        },
      });
      expect(user.id).toBe(testUserId);

      const profile = await prisma.patientProfile.create({
        data: {
          id: testPatientProfileId,
          userId: testUserId,
          fullName: 'Postgres Integration Patient',
        },
      });
      expect(profile.id).toBe(testPatientProfileId);

      // Create initial document record
      const doc = await docRepo.create({
        id: testDocumentId,
        patientProfileId: testPatientProfileId,
        storageKey: testStorageKey,
        originalFilename: 'rx-integ-test.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 1024,
        sha256Checksum: 'dummy-sha256-checksum',
        status: 'UPLOADED',
      });
      expect(doc.id).toBe(testDocumentId);
      expect(doc.status).toBe('UPLOADED');
    });

    it('persists extraction job, claims it, completes it, and verifies across repository reinitialization', async () => {
      // 1. Persist extraction job
      const createdJob = await jobRepo.create({
        id: testJobId,
        patientProfileId: testPatientProfileId,
        documentId: testDocumentId,
        idempotencyKey: `idemp-${testRunId}`,
        status: 'QUEUED',
        retryCount: 0,
        maxRetries: 3,
        providerName: 'mock-provider',
      });
      expect(createdJob.status).toBe('QUEUED');

      // 2. Concurrency-safe claim
      const claimed = await jobRepo.claimJobForProcessing(testJobId);
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe('PROCESSING');
      expect(claimed!.startedAt).toBeDefined();

      // 3. Complete processing with clinical payload
      const clinicalPayload = {
        doctorName: 'Dr. Ramesh Kumar',
        clinicHospitalName: 'City Care Hospital',
        diagnosis: 'Acute Bronchitis',
        prescriptionDate: '2026-10-12',
        medicines: [
          {
            nameAsWritten: 'Amoxicillin 500mg',
            normalizedMedicineName: 'Amoxicillin',
            strength: '500mg',
            dosageForm: 'CAPSULE',
            frequencyText: 'TDS (3 times daily)',
            durationText: '5 days',
            route: 'ORAL',
            instructions: 'After food',
            isActiveMedication: true,
          },
        ],
      };

      const completed = await jobRepo.completeProcessing(
        testJobId,
        clinicalPayload,
        'SUCCEEDED'
      );
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('SUCCEEDED');
      expect(completed!.completedAt).toBeDefined();

      // 4. Verify durable persistence across reinitialization with fresh Prisma client
      const freshPrisma = new PrismaClient();
      const freshJobRepo = new PrismaExtractionJobRepository(freshPrisma);
      const reloadedJob = await freshJobRepo.findById(testJobId);
      expect(reloadedJob).not.toBeNull();
      expect(reloadedJob!.status).toBe('SUCCEEDED');
      expect(reloadedJob!.extractedPayload).toEqual(clinicalPayload);
      await freshPrisma.$disconnect();
    });

    it('executes prescription confirmation atomically against PostgreSQL', async () => {
      // Atomic multi-table confirmation transaction
      const result = await rxRepo.confirmPrescriptionTransaction({
        patientProfileId: testPatientProfileId,
        documentId: testDocumentId,
        jobId: testJobId,
        prescription: {
          prescriptionDate: '2026-10-12',
          dateIsUncertain: false,
          doctorName: 'Dr. Ramesh Kumar',
          clinicHospitalName: 'City Care Hospital',
          diagnosis: 'Acute Bronchitis',
          confirmedByUserId: testUserId,
        },
        items: [
          {
            nameAsWritten: 'Amoxicillin 500mg',
            normalizedMedicineName: 'Amoxicillin',
            strength: '500mg',
            dosageForm: 'CAPSULE',
            frequencyText: 'TDS (3 times daily)',
            durationText: '5 days',
            route: 'ORAL',
            instructions: 'After food',
            isActiveMedication: true,
          },
        ],
        timelineEvent: {
          eventDate: '2026-10-12',
          title: 'Prescription from Dr. Ramesh Kumar',
          summary: 'Amoxicillin 500mg (5 days)',
        },
      });

      expect(result.prescription.id).toBeDefined();
      expect(result.prescription.reviewStatus).toBe('CONFIRMED');
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.normalizedMedicineName).toBe('Amoxicillin');
      expect(result.timelineEvent.eventType).toBe('PRESCRIPTION_RECORDED');

      // Verify atomically updated job and document in PostgreSQL
      const jobAfter = await jobRepo.findById(testJobId);
      expect(jobAfter!.confirmedAt).toBeDefined();

      const docAfter = await docRepo.findById(testDocumentId);
      expect(docAfter!.status).toBe('CONFIRMED');

      // Verify durable existence across a fresh Prisma client
      const freshPrisma = new PrismaClient();
      const freshRxRepo = new PrismaPrescriptionRepository(freshPrisma);
      const freshLoaded = await freshRxRepo.findById(result.prescription.id, testPatientProfileId);
      expect(freshLoaded).not.toBeNull();
      expect(freshLoaded!.prescription.doctorName).toBe('Dr. Ramesh Kumar');
      expect(freshLoaded!.items).toHaveLength(1);
      await freshPrisma.$disconnect();
    });

    it('forces transaction failure and proves that no partial clinical records remain', async () => {
      const nonExistentDocId = crypto.randomUUID();
      const doomedJobId = crypto.randomUUID();

      let txError: Error | null = null;
      try {
        await rxRepo.confirmPrescriptionTransaction({
          patientProfileId: testPatientProfileId,
          documentId: nonExistentDocId,
          jobId: doomedJobId,
          prescription: {
            doctorName: 'Dr. Ghost',
            confirmedByUserId: testUserId,
            dateIsUncertain: false,
          },
          items: [
            {
              nameAsWritten: 'Ghost Medicine',
              dosageForm: 'TABLET',
              route: 'ORAL',
              isActiveMedication: true,
            },
          ],
          timelineEvent: {
            eventDate: '2026-10-12',
            title: 'Ghost Event',
            summary: 'Should rollback',
          },
        });
      } catch (err: any) {
        txError = err;
      }

      expect(txError).not.toBeNull();

      // Prove that zero orphaned prescription or timeline records exist
      const orphanedRx = await prisma.prescription.findMany({
        where: { jobId: doomedJobId },
      });
      expect(orphanedRx).toHaveLength(0);

      const orphanedEvents = await prisma.timelineEvent.findMany({
        where: { title: 'Ghost Event' },
      });
      expect(orphanedEvents).toHaveLength(0);
    });

    it('races concurrent confirmations and verifies exactly one confirmed prescription and one timeline event', async () => {
      const raceDocId = crypto.randomUUID();
      const raceJobId = crypto.randomUUID();
      const raceStorageKey = `documents/${testPatientProfileId}/race-${testRunId}.pdf`;

      await docRepo.create({
        id: raceDocId,
        patientProfileId: testPatientProfileId,
        storageKey: raceStorageKey,
        originalFilename: 'race-rx.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 2048,
        sha256Checksum: 'dummy-sha256',
        status: 'READY_FOR_REVIEW',
      });

      await jobRepo.create({
        id: raceJobId,
        patientProfileId: testPatientProfileId,
        documentId: raceDocId,
        idempotencyKey: `race-job-${testRunId}`,
        status: 'SUCCEEDED',
        retryCount: 0,
        maxRetries: 3,
        providerName: 'mock-provider',
      });

      // Launch two concurrent confirmation requests racing for the same jobId
      const makeConfirmRequest = () =>
        rxRepo.confirmPrescriptionTransaction({
          patientProfileId: testPatientProfileId,
          documentId: raceDocId,
          jobId: raceJobId,
          prescription: {
            doctorName: 'Dr. Concurrency',
            confirmedByUserId: testUserId,
            dateIsUncertain: false,
          },
          items: [
            {
              nameAsWritten: 'Paracetamol 650mg',
              dosageForm: 'TABLET',
              route: 'ORAL',
              isActiveMedication: true,
            },
          ],
          timelineEvent: {
            eventDate: '2026-10-12',
            title: 'Concurrent Prescription',
            summary: 'Should win race only once',
          },
        });

      const [res1, res2] = await Promise.allSettled([
        makeConfirmRequest(),
        makeConfirmRequest(),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      // Exactly one must win, and one must be rejected (fail closed)
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // Verify in database: exactly one prescription record exists for raceJobId
      const rxsInDb = await prisma.prescription.findMany({
        where: { jobId: raceJobId },
      });
      expect(rxsInDb).toHaveLength(1);

      // Verify exactly one timeline event was recorded
      const eventsInDb = await prisma.timelineEvent.findMany({
        where: { sourceDocumentId: raceDocId },
      });
      expect(eventsInDb).toHaveLength(1);

      // Cleanup race records
      await prisma.timelineEvent.deleteMany({ where: { sourceDocumentId: raceDocId } });
      await prisma.prescriptionItem.deleteMany({ where: { sourceDocumentId: raceDocId } });
      await prisma.prescription.deleteMany({ where: { jobId: raceJobId } });
      await prisma.extractionJob.deleteMany({ where: { id: raceJobId } });
      await prisma.document.deleteMany({ where: { id: raceDocId } });
    });

    it('exercises actual MinIO direct upload, server-side verification, and cleanup', async () => {
      // 1. Generate genuine PDF buffer
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([400, 600]);
      page.drawText('Live MinIO Integration Test Document');
      const pdfBytes = await pdfDoc.save();
      const pdfBuffer = Buffer.from(pdfBytes);

      // 2. Create durable upload intent in PostgreSQL
      const intent = await s3Provider.createUploadIntent({
        patientProfileId: testPatientProfileId,
        filename: 'live-minio-test.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: pdfBuffer.length,
      });

      expect(intent.storageKey).toBeDefined();
      expect(intent.uploadSignedUrl).toContain(':9000');

      // Verify intent exists in PostgreSQL
      const savedIntent = await intentRepo.getIntent(intent.storageKey);
      expect(savedIntent).not.toBeNull();
      expect(savedIntent!.consumed).toBe(false);
      expect(savedIntent!.declaredSizeBytes).toBe(pdfBuffer.length);

      // 3. Client direct PUT to MinIO signed URL
      const putRes = await fetch(intent.uploadSignedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/pdf',
        },
        body: pdfBuffer,
      });
      expect(putRes.ok).toBe(true);

      // 4. Server-side verification and finalize
      const metadata = await s3Provider.verifyAndFinalizeUpload(
        intent.storageKey,
        testPatientProfileId,
        'application/pdf'
      );

      expect(metadata.storageKey).toBe(intent.storageKey);
      expect(metadata.fileSizeBytes).toBe(pdfBuffer.length);
      expect(metadata.sha256Checksum).toBe(
        crypto.createHash('sha256').update(pdfBuffer).digest('hex')
      );

      // Verify intent is marked consumed in PostgreSQL
      const consumedIntent = await intentRepo.getIntent(intent.storageKey);
      expect(consumedIntent!.consumed).toBe(true);

      // 5. Clean up MinIO object
      await s3Provider.deleteObject(intent.storageKey, testPatientProfileId);
    });
  }
);
