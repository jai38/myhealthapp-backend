import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { MedicationService } from './medication-service.js';
import { MedicationStatusType } from '../persistence/repositories.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const ActivateMedicationSchema = z.object({
  reminderTimes: z.array(z.string().regex(TIME_REGEX, 'Time must be in HH:mm 24-hour format')).min(1, 'At least one reminder time is required'),
  startDate: z.string().regex(DATE_REGEX, 'Start date must be in YYYY-MM-DD format').optional(),
  endDate: z.string().regex(DATE_REGEX, 'End date must be in YYYY-MM-DD format').optional(),
});

const UpdateScheduleSchema = z.object({
  reminderTimes: z.array(z.string().regex(TIME_REGEX, 'Time must be in HH:mm 24-hour format')).min(1, 'At least one reminder time is required'),
  startDate: z.string().regex(DATE_REGEX, 'Start date must be in YYYY-MM-DD format').optional(),
  endDate: z.string().regex(DATE_REGEX, 'End date must be in YYYY-MM-DD format').optional(),
});

const DiscontinueSchema = z.object({
  reason: z.string().max(500, 'Reason cannot exceed 500 characters').optional(),
});

const RecordDoseActionSchema = z.object({
  action: z.enum(['TAKEN', 'SKIPPED', 'SNOOZED']),
  notes: z.string().max(500).optional(),
  snoozeMinutes: z.number().int().min(5).max(120).optional(),
  actionTime: z.string().datetime().optional(),
});

const CorrectDoseActionSchema = z.object({
  action: z.enum(['TAKEN', 'SKIPPED', 'PENDING']),
  notes: z.string().max(500).optional(),
});

const CreateManualMedicationSchema = z.object({
  nameAsWritten: z.string().min(1, 'Medication name is required'),
  dosageForm: z.string().default('TABLET'),
  strength: z.string().optional(),
  route: z.string().default('ORAL'),
  prescribedInstructions: z.string().optional(),
  reminderTimes: z
    .array(z.string().regex(TIME_REGEX, 'Time must be in HH:mm 24-hour format'))
    .optional(),
  startDate: z.string().regex(DATE_REGEX, 'Start date must be in YYYY-MM-DD format').optional(),
  endDate: z.string().regex(DATE_REGEX, 'End date must be in YYYY-MM-DD format').optional(),
  notes: z.string().max(500).optional(),
});

export const createMedicationRouter = (medicationService: MedicationService): Router => {
  const router = Router();

  /**
   * POST /api/v1/medications
   * Creates a manual medication record with optional reminder schedule.
   */
  router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const parseResult = CreateManualMedicationSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid medication input',
            details: parseResult.error.format(),
          },
        });
        return;
      }

      const created = await medicationService.createManualMedication(
        patientProfileId,
        parseResult.data
      );

      res.status(201).json({
        data: created,
        message: 'Medication added successfully',
      });
    } catch (err: any) {
      if (err.statusCode === 400) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * GET /api/v1/medications
   * Lists medications for the authenticated patient.
   */
  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const status = req.query.status as MedicationStatusType | undefined;
      const validStatuses: MedicationStatusType[] = ['INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETED', 'DISCONTINUED'];
      if (status && !validStatuses.includes(status)) {
        res.status(400).json({
          error: { code: 'INVALID_STATUS', message: `Invalid status filter. Allowed: ${validStatuses.join(', ')}` },
        });
        return;
      }

      const list = await medicationService.listMedications(patientProfileId, status);
      res.status(200).json({ data: list });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/medications/doses
   * Retrieves scheduled dose occurrences within a time window.
   */
  router.get('/doses', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const now = new Date();
      let from = new Date(now);
      from.setUTCHours(0, 0, 0, 0);

      let to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
      to.setUTCHours(23, 59, 59, 999);

      if (req.query.from) {
        const parsedFrom = new Date(String(req.query.from));
        if (isNaN(parsedFrom.getTime())) {
          res.status(400).json({ error: { code: 'INVALID_DATE', message: 'Invalid "from" date parameter' } });
          return;
        }
        from = parsedFrom;
      }

      if (req.query.to) {
        const parsedTo = new Date(String(req.query.to));
        if (isNaN(parsedTo.getTime())) {
          res.status(400).json({ error: { code: 'INVALID_DATE', message: 'Invalid "to" date parameter' } });
          return;
        }
        to = parsedTo;
      }

      const doses = await medicationService.getDoseOccurrences(patientProfileId, from, to);
      res.status(200).json({ data: doses });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/v1/medications/doses/:doseId/action
   * Records explicit patient-reported action (TAKEN, SKIPPED, SNOOZED).
   */
  router.post('/doses/:doseId/action', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const doseId = String(req.params.doseId || '');
      if (!UUID_REGEX.test(doseId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Dose ID must be a valid UUID' } });
        return;
      }

      const parseResult = RecordDoseActionSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid dose action input',
            details: parseResult.error.format(),
          },
        });
        return;
      }

      const { action, notes, snoozeMinutes, actionTime } = parseResult.data;
      const updated = await medicationService.recordDoseAction(doseId, patientProfileId, action, {
        notes,
        snoozeMinutes,
        actionTime,
      });

      res.status(200).json({ data: updated, message: `Dose recorded as ${action}` });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * PATCH /api/v1/medications/doses/:doseId/action
   * Corrects a previous dose action.
   */
  router.patch('/doses/:doseId/action', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const doseId = String(req.params.doseId || '');
      if (!UUID_REGEX.test(doseId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Dose ID must be a valid UUID' } });
        return;
      }

      const parseResult = CorrectDoseActionSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid dose action correction input',
            details: parseResult.error.format(),
          },
        });
        return;
      }

      const { action, notes } = parseResult.data;
      const updated = await medicationService.correctDoseAction(doseId, patientProfileId, action, notes);

      res.status(200).json({ data: updated, message: 'Dose action corrected' });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * GET /api/v1/medications/:id
   * Retrieves full details and history for a medication.
   */
  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const id = String(req.params.id || '');
      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Medication ID must be a valid UUID' } });
        return;
      }

      const details = await medicationService.getMedicationDetails(id, patientProfileId);
      res.status(200).json({ data: details });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * GET /api/v1/medications/:id/document-url
   * Gets a pre-signed URL to view the original source document.
   */
  router.get('/:id/document-url', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const id = String(req.params.id || '');
      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Medication ID must be a valid UUID' } });
        return;
      }

      const urlData = await medicationService.getDocumentSignedUrl(id, patientProfileId);
      res.status(200).json({ data: urlData });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/v1/medications/:id/activate
   * Explicit patient activation of an eligible medication.
   */
  router.post('/:id/activate', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const id = String(req.params.id || '');
      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Medication ID must be a valid UUID' } });
        return;
      }

      const parseResult = ActivateMedicationSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid medication activation schedule input',
            details: parseResult.error.format(),
          },
        });
        return;
      }

      const { reminderTimes, startDate, endDate } = parseResult.data;
      const updated = await medicationService.activateMedication(
        id,
        patientProfileId,
        reminderTimes,
        startDate,
        endDate
      );

      res.status(200).json({
        data: updated,
        message: 'Medication activated successfully. Reminder occurrences scheduled.',
      });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      if (err.statusCode === 400) {
        res.status(400).json({ error: { code: 'INVALID_ACTION', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * PATCH /api/v1/medications/:id/schedule
   * Updates patient reminder preferences.
   */
  router.patch('/:id/schedule', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const id = String(req.params.id || '');
      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Medication ID must be a valid UUID' } });
        return;
      }

      const parseResult = UpdateScheduleSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid schedule preferences input',
            details: parseResult.error.format(),
          },
        });
        return;
      }

      const { reminderTimes, startDate, endDate } = parseResult.data;
      const updated = await medicationService.updateReminderPreferences(
        id,
        patientProfileId,
        reminderTimes,
        startDate,
        endDate
      );

      res.status(200).json({
        data: updated,
        message: 'Medication schedule preferences updated successfully.',
      });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      if (err.statusCode === 400) {
        res.status(400).json({ error: { code: 'INVALID_ACTION', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/v1/medications/:id/pause
   */
  router.post('/:id/pause', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const id = String(req.params.id || '');
      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Medication ID must be a valid UUID' } });
        return;
      }

      const updated = await medicationService.pauseMedication(id, patientProfileId);
      res.status(200).json({ data: updated, message: 'Medication paused. Future reminders cancelled.' });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      if (err.statusCode === 400) {
        res.status(400).json({ error: { code: 'INVALID_ACTION', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/v1/medications/:id/resume
   */
  router.post('/:id/resume', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const id = String(req.params.id || '');
      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Medication ID must be a valid UUID' } });
        return;
      }

      const updated = await medicationService.resumeMedication(id, patientProfileId);
      res.status(200).json({ data: updated, message: 'Medication resumed. Reminders rescheduled.' });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      if (err.statusCode === 400) {
        res.status(400).json({ error: { code: 'INVALID_ACTION', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/v1/medications/:id/complete
   */
  router.post('/:id/complete', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const id = String(req.params.id || '');
      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Medication ID must be a valid UUID' } });
        return;
      }

      const updated = await medicationService.completeMedication(id, patientProfileId);
      res.status(200).json({ data: updated, message: 'Medication marked as completed.' });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      if (err.statusCode === 400) {
        res.status(400).json({ error: { code: 'INVALID_ACTION', message: err.message } });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/v1/medications/:id/discontinue
   */
  router.post('/:id/discontinue', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const id = String(req.params.id || '');
      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Medication ID must be a valid UUID' } });
        return;
      }

      const parseResult = DiscontinueSchema.safeParse(req.body);
      const reason = parseResult.success ? parseResult.data.reason : undefined;

      const updated = await medicationService.discontinueMedication(id, patientProfileId, reason);
      res.status(200).json({ data: updated, message: 'Medication discontinued.' });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: err.message } });
        return;
      }
      if (err.statusCode === 400) {
        res.status(400).json({ error: { code: 'INVALID_ACTION', message: err.message } });
        return;
      }
      next(err);
    }
  });

  return router;
};
