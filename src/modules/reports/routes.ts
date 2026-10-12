import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ReportService } from './report-service.js';
import { generateMedicalReportPdf } from './pdf-generator.js';

const exportConfigSchema = z.object({
  title: z.string().max(100).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  includeTimeline: z.boolean().optional(),
  includeMedications: z.boolean().optional(),
  selectedEventIds: z.array(z.string().uuid()).optional(),
  selectedMedicationIds: z.array(z.string().uuid()).optional(),
  allowEmpty: z.boolean().optional(),
});

export const createReportRouter = (reportService: ReportService): Router => {
  const router = Router();

  /**
   * POST /api/v1/reports/export-data
   * Retrieves preview data and counts of eligible records for report configuration.
   */
  router.post(
    '/export-data',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const patientProfileId = req.authContext?.patientProfileId;
        if (!patientProfileId) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
          return;
        }

        const validation = exportConfigSchema.safeParse(req.body);
        if (!validation.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid export options',
              details: validation.error.errors,
            },
          });
          return;
        }

        const data = await reportService.getExportData(
          patientProfileId,
          validation.data
        );

        res.status(200).json({ data });
      } catch (err: any) {
        if (err.statusCode === 400) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: err.message,
            },
          });
          return;
        }
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/reports/generate
   * Generates a confidential medical report PDF, saves it securely to private storage,
   * and returns signed preview URL and base64 representation.
   */
  router.post(
    '/generate',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const patientProfileId = req.authContext?.patientProfileId;
        if (!patientProfileId) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
          return;
        }

        const validation = exportConfigSchema.safeParse(req.body);
        if (!validation.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid report configuration options',
              details: validation.error.errors,
            },
          });
          return;
        }

        const report = await reportService.generateReport(
          patientProfileId,
          validation.data
        );

        res.status(201).json({ data: report });
      } catch (err: any) {
        if (err.statusCode === 400 || err.message?.includes('No eligible medical records')) {
          res.status(400).json({
            error: {
              code: 'EMPTY_REPORT_ERROR',
              message: err.message,
            },
          });
          return;
        }
        next(err);
      }
    }
  );

  /**
   * POST /api/v1/reports/generate-pdf
   * Directly generates and streams the raw PDF binary.
   */
  router.post(
    '/generate-pdf',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const patientProfileId = req.authContext?.patientProfileId;
        if (!patientProfileId) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
          return;
        }

        const validation = exportConfigSchema.safeParse(req.body);
        if (!validation.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid report configuration options',
              details: validation.error.errors,
            },
          });
          return;
        }

        const exportData = await reportService.getExportData(
          patientProfileId,
          validation.data
        );

        if (exportData.summary.totalRecords === 0 && !validation.data.allowEmpty) {
          res.status(400).json({
            error: {
              code: 'EMPTY_REPORT_ERROR',
              message: 'No eligible medical records found in the selected date range and criteria.',
            },
          });
          return;
        }

        const { pdfBytes } = await generateMedicalReportPdf(exportData);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="medical-report.pdf"');
        res.status(200).send(Buffer.from(pdfBytes));
      } catch (err: any) {
        if (err.statusCode === 400) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: err.message,
            },
          });
          return;
        }
        next(err);
      }
    }
  );

  /**
   * GET /api/v1/reports/:id/download
   * Securely streams the stored report PDF after verifying authenticated patient ownership.
   */
  router.get(
    '/:id/download',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const patientProfileId = req.authContext?.patientProfileId;
        if (!patientProfileId) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
          return;
        }

        const reportId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!reportId || !uuidRegex.test(reportId)) {
          res.status(400).json({
            error: {
              code: 'INVALID_ID',
              message: 'Invalid report ID format',
            },
          });
          return;
        }

        const { buffer, doc } = await reportService.getReportBuffer(
          patientProfileId,
          reportId
        );

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${doc.originalFilename}"`
        );
        res.status(200).send(buffer);
      } catch (err: any) {
        if (err.message?.includes('not found') || err.message?.includes('Document not found')) {
          res.status(404).json({
            error: {
              code: 'NOT_FOUND',
              message: 'Report not found or access denied',
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
