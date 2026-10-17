import { Router, Request, Response, NextFunction } from 'express';
import { ExtractionJobQueue } from '../ai-extraction/job-queue.js';
import { PrescriptionService } from './prescription-service.js';
import { PatientPrescriptionReviewSchema } from './schemas.js';

const getParamString = (param: string | string[] | undefined): string => {
  if (Array.isArray(param)) return param[0] || '';
  return param || '';
};

function parseTimezoneOffset(req: Request): number {
  const val = req.headers['x-timezone-offset'];
  if (typeof val === 'string') {
    const num = parseInt(val, 10);
    if (!isNaN(num) && num >= -840 && num <= 840) {
      return num;
    }
  }
  return 0;
}

export function createPrescriptionRouter(
  jobQueue: ExtractionJobQueue,
  prescriptionService: PrescriptionService
): Router {
  const router = Router();

  // POST /extract-job (submits extraction job)
  router.post('/extract-job', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { documentId, idempotencyKey, autoProcess } = req.body;
      if (!documentId) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'documentId is required' },
        });
        return;
      }

      const patientProfileId = req.authContext!.patientProfileId;
      let job = await jobQueue.submitJob({
        patientProfileId,
        documentId,
        idempotencyKey,
      });

      // Auto-process by default in dev/test flows unless autoProcess is explicitly false
      if (autoProcess !== false && job.status === 'QUEUED') {
        job = await jobQueue.processJob(job.id);
      }

      res.status(202).json({ data: job });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Job submission failed';
      if (msg.includes('Document not found')) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found' } });
        return;
      }
      next(err);
      return;
    }
  });

  // GET /extract-job/:jobId (polls or checks job status)
  router.get('/extract-job/:jobId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const jobId = getParamString(req.params.jobId);
      if (!jobId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'jobId is required' } });
        return;
      }

      const patientProfileId = req.authContext!.patientProfileId;
      const job = await jobQueue.getJob(patientProfileId, jobId);
      res.status(200).json({ data: job });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Extraction job not found')) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extraction job not found' } });
        return;
      }
      next(err);
      return;
    }
  });

  // POST /extract-job/:jobId/process (processes an existing queued job)
  router.post('/extract-job/:jobId/process', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const jobId = getParamString(req.params.jobId);
      if (!jobId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'jobId is required' } });
        return;
      }

      const patientProfileId = req.authContext!.patientProfileId;
      await jobQueue.getJob(patientProfileId, jobId); // ownership check
      const job = await jobQueue.processJob(jobId);
      res.status(200).json({ data: job });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Extraction job not found')) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extraction job not found' } });
        return;
      }
      next(err);
      return;
    }
  });

  // POST /extract-job/:jobId/cancel (cancels a job)
  router.post('/extract-job/:jobId/cancel', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const jobId = getParamString(req.params.jobId);
      if (!jobId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'jobId is required' } });
        return;
      }

      const patientProfileId = req.authContext!.patientProfileId;
      const job = await jobQueue.cancelJob(patientProfileId, jobId);
      res.status(200).json({ data: job });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Extraction job not found')) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extraction job not found' } });
        return;
      }
      if (msg.includes('Cannot cancel an already succeeded job')) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: msg } });
        return;
      }
      next(err);
      return;
    }
  });

  // POST /:jobId/confirm (patient confirmation endpoint creating verified clinical records)
  router.post('/:jobId/confirm', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const jobId = getParamString(req.params.jobId);
      if (!jobId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'jobId is required' } });
        return;
      }

      const patientProfileId = req.authContext!.patientProfileId;
      const userId = req.authContext!.userId;

      const parseResult = PatientPrescriptionReviewSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid prescription review payload',
            details: parseResult.error.format(),
          },
        });
        return;
      }

      const tzOffset = parseTimezoneOffset(req);
      const result = await prescriptionService.confirmPrescription(
        { userId, patientProfileId },
        jobId,
        parseResult.data,
        tzOffset
      );

      res.status(201).json({ data: result });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Confirmation failed';
      if (msg.includes('not found')) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: msg } });
        return;
      }
      if (
        msg.includes('already been confirmed') ||
        msg.includes('Cannot confirm an unreviewed') ||
        msg.includes('non-succeeded')
      ) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: msg } });
        return;
      }
      next(err);
      return;
    }
  });

  // GET /timeline (retrieves verified medical timeline events)
  router.get('/timeline', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext!.patientProfileId;
      const events = await prescriptionService.getTimelineEvents(patientProfileId);
      res.status(200).json({ data: events });
      return;
    } catch (err) {
      next(err);
      return;
    }
  });

  // GET /:prescriptionId (retrieves confirmed prescription)
  router.get('/:prescriptionId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const prescriptionId = getParamString(req.params.prescriptionId);
      if (!prescriptionId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'prescriptionId is required' } });
        return;
      }

      const patientProfileId = req.authContext!.patientProfileId;
      const result = await prescriptionService.getPrescription(patientProfileId, prescriptionId);
      res.status(200).json({ data: result });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Prescription not found')) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Prescription not found' } });
        return;
      }
      next(err);
      return;
    }
  });

  return router;
}
