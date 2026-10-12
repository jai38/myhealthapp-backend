import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { TimelineService } from './timeline-service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TimelineQuerySchema = z.object({
  search: z.string().optional(),
  year: z
    .string()
    .optional()
    .refine((val) => !val || (!isNaN(Number(val)) && Number(val) >= 1900 && Number(val) <= 2100), {
      message: 'Year must be a valid 4-digit number between 1900 and 2100',
    }),
  category: z.string().optional(),
  limit: z
    .string()
    .optional()
    .refine((val) => !val || (!isNaN(Number(val)) && Number(val) >= 1 && Number(val) <= 50), {
      message: 'Limit must be a number between 1 and 50',
    }),
  offset: z
    .string()
    .optional()
    .refine((val) => !val || (!isNaN(Number(val)) && Number(val) >= 0), {
      message: 'Offset must be a non-negative number',
    }),
});

export const createTimelineRouter = (timelineService: TimelineService): Router => {
  const router = Router();

  /**
   * GET /api/v1/timeline
   * Retrieves paginated, sorted, and filtered medical timeline events for the authenticated patient.
   */
  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const parseResult = TimelineQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        res.status(400).json({
          error: {
            code: 'INVALID_QUERY_PARAMETERS',
            message: 'Invalid timeline filter parameters',
            details: parseResult.error.format(),
          },
        });
        return;
      }

      const { search, year, category, limit, offset } = parseResult.data;

      const result = await timelineService.listTimelineEvents(patientProfileId, {
        search: search?.trim(),
        year: year ? parseInt(year, 10) : undefined,
        category: category?.trim() || undefined,
        limit: limit ? parseInt(limit, 10) : 20,
        offset: offset ? parseInt(offset, 10) : 0,
      });

      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/v1/timeline/:id
   * Retrieves full clinical details and provenance for a single timeline event.
   */
  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext?.patientProfileId;
      if (!patientProfileId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }

      const eventId = String(req.params.id || '');
      if (!UUID_REGEX.test(eventId)) {
        res.status(400).json({
          error: { code: 'INVALID_ID', message: 'Medical event ID must be a valid UUID' },
        });
        return;
      }

      const event = await timelineService.getTimelineEventDetails(eventId, patientProfileId);
      res.status(200).json({ data: event });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({
          error: { code: 'EVENT_NOT_FOUND', message: err.message || 'Medical timeline event not found' },
        });
        return;
      }
      next(err);
    }
  });

  /**
   * GET /api/v1/timeline/:id/document-url
   * Generates a short-lived, pre-signed URL to securely access the event's source document.
   */
  router.get(
    '/:id/document-url',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const patientProfileId = req.authContext?.patientProfileId;
        if (!patientProfileId) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
          return;
        }

        const eventId = String(req.params.id || '');
        if (!UUID_REGEX.test(eventId)) {
          res.status(400).json({
            error: { code: 'INVALID_ID', message: 'Medical event ID must be a valid UUID' },
          });
          return;
        }

        const result = await timelineService.getDocumentSignedUrl(eventId, patientProfileId);
        res.status(200).json({ data: result });
      } catch (err: any) {
        if (err.statusCode === 404) {
          res.status(404).json({
            error: {
              code: 'DOCUMENT_NOT_FOUND',
              message: err.message || 'Source document not found or unavailable',
            },
          });
          return;
        }
        next(err);
      }
    }
  );

  return router;
};
