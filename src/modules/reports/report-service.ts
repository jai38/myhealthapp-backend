import crypto from 'crypto';
import {
  TimelineRepository,
  MedicationRepository,
  TimelineEventDetailRecord,
  MedicationDetailRecord,
  DocumentRecord,
} from '../persistence/repositories.js';
import { DocumentService } from '../documents/document-service.js';
import {
  ExportDataPayload,
  generateMedicalReportPdf,
} from './pdf-generator.js';

export interface ExportReportOptions {
  title?: string;
  startDate?: string;
  endDate?: string;
  includeTimeline?: boolean;
  includeMedications?: boolean;
  selectedEventIds?: string[];
  selectedMedicationIds?: string[];
  allowEmpty?: boolean;
}

export interface GeneratedReportResult {
  reportId: string;
  title: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  pageCount: number;
  generatedAt: string;
  summary: {
    timelineEventsCount: number;
    medicationsCount: number;
    totalRecords: number;
  };
  downloadUrl: string;
  pdfBase64: string;
}

export class ReportService {
  constructor(
    private readonly timelineRepo: TimelineRepository,
    private readonly medicationRepo: MedicationRepository,
    private readonly documentService: DocumentService
  ) {}

  /**
   * Retrieves strictly authorized and filtered medical records for report generation or preview.
   * Enforces server-side patient ownership, explicit section selection, and validated date range.
   */
  async getExportData(
    patientProfileId: string,
    options: ExportReportOptions = {}
  ): Promise<ExportDataPayload> {
    if (!patientProfileId) {
      const err = new Error('Unauthorized: Patient profile ID is required');
      (err as any).statusCode = 401;
      throw err;
    }

    const {
      title,
      startDate,
      endDate,
      includeTimeline = true,
      includeMedications = true,
      selectedEventIds,
      selectedMedicationIds,
    } = options;

    // 1. Validate date range
    let startD: Date | null = null;
    let endD: Date | null = null;

    if (startDate) {
      startD = new Date(startDate);
      if (isNaN(startD.getTime())) {
        const err = new Error('Invalid start date format. Expected YYYY-MM-DD or ISO timestamp.');
        (err as any).statusCode = 400;
        throw err;
      }
    }

    if (endDate) {
      endD = new Date(endDate);
      if (isNaN(endD.getTime())) {
        const err = new Error('Invalid end date format. Expected YYYY-MM-DD or ISO timestamp.');
        (err as any).statusCode = 400;
        throw err;
      }
    }

    if (startD && endD && startD > endD) {
      const err = new Error('Invalid date range: Start date cannot be after end date.');
      (err as any).statusCode = 400;
      throw err;
    }

    // 2. Format human-readable date range label
    let dateRangeLabel = 'All Historical Records';
    if (startDate && endDate) {
      dateRangeLabel = `${startDate.split('T')[0]} to ${endDate.split('T')[0]}`;
    } else if (startDate) {
      dateRangeLabel = `From ${startDate.split('T')[0]}`;
    } else if (endDate) {
      dateRangeLabel = `Up to ${endDate.split('T')[0]}`;
    }

    // 3. Retrieve and filter timeline events
    let filteredEvents: TimelineEventDetailRecord[] = [];
    if (includeTimeline) {
      const { events } = await this.timelineRepo.listTimelineEvents(patientProfileId, {
        limit: 500,
        offset: 0,
      });

      filteredEvents = events.filter((ev) => {
        // Strict ownership verification
        if (ev.patientProfileId !== patientProfileId) return false;

        // Specific IDs filter
        if (selectedEventIds && selectedEventIds.length > 0) {
          if (!selectedEventIds.includes(ev.id)) return false;
        }

        // Date range filter
        const evDate = new Date(ev.eventDate);
        if (startD && evDate < new Date(startD.setUTCHours(0, 0, 0, 0))) {
          return false;
        }
        if (endD && evDate > new Date(endD.setUTCHours(23, 59, 59, 999))) {
          return false;
        }

        return true;
      });

      // Sort chronologically (oldest to newest for medical summary)
      filteredEvents.sort((a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime());
    }

    // 4. Retrieve and filter medications
    let filteredMeds: MedicationDetailRecord[] = [];
    if (includeMedications) {
      const medsList = await this.medicationRepo.listMedications(patientProfileId);

      const enrichedMeds: MedicationDetailRecord[] = [];
      for (const m of medsList) {
        if (m.patientProfileId !== patientProfileId) continue;
        const details = await this.medicationRepo.getMedicationById(m.id, patientProfileId);
        if (details) {
          enrichedMeds.push(details);
        }
      }

      filteredMeds = enrichedMeds.filter((med) => {
        // Specific IDs filter
        if (selectedMedicationIds && selectedMedicationIds.length > 0) {
          if (!selectedMedicationIds.includes(med.id)) return false;
        }

        // Date filter
        if (startD || endD) {
          const medStart = med.startDate ? new Date(med.startDate) : new Date(med.createdAt);
          const medEnd = med.endDate ? new Date(med.endDate) : null;

          if (startD && medEnd && medEnd < new Date(startD.setUTCHours(0, 0, 0, 0))) {
            return false;
          }
          if (endD && medStart > new Date(endD.setUTCHours(23, 59, 59, 999))) {
            return false;
          }
        }

        return true;
      });

      // Sort medications by active first, then name
      filteredMeds.sort((a, b) => {
        if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
        if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1;
        return a.nameAsWritten.localeCompare(b.nameAsWritten);
      });
    }

    const payload: ExportDataPayload = {
      patient: {
        patientProfileId,
        fullName: 'Test Patient',
      },
      reportTitle: title?.trim() || 'Medical Summary Report',
      generatedAt: new Date().toISOString(),
      dateRange: {
        startDate: startDate || null,
        endDate: endDate || null,
        label: dateRangeLabel,
      },
      summary: {
        timelineEventsCount: filteredEvents.length,
        medicationsCount: filteredMeds.length,
        totalRecords: filteredEvents.length + filteredMeds.length,
      },
      timelineEvents: filteredEvents,
      medications: filteredMeds,
    };

    return payload;
  }

  /**
   * Generates a confidential medical report PDF, saves it securely to private storage,
   * and returns signed preview URL and base64 payload.
   */
  async generateReport(
    patientProfileId: string,
    options: ExportReportOptions = {}
  ): Promise<GeneratedReportResult> {
    const exportData = await this.getExportData(patientProfileId, options);

    if (exportData.summary.totalRecords === 0 && !options.allowEmpty) {
      const err = new Error(
        'No eligible medical records found in the selected date range and criteria. Please adjust your date range or section selection.'
      );
      (err as any).statusCode = 400;
      throw err;
    }

    // Generate binary PDF
    const { pdfBytes, pageCount } = await generateMedicalReportPdf(exportData);

    const safeDate = new Date().toISOString().split('T')[0];
    const filename = `medical-report-${safeDate}-${crypto.randomUUID().slice(0, 8)}.pdf`;

    // Save to private document storage
    const docRecord = await this.documentService.saveGeneratedDocument(
      patientProfileId,
      filename,
      'application/pdf',
      Buffer.from(pdfBytes),
      pageCount
    );

    // Get private short-lived signed preview URL
    const signedUrl = await this.documentService.getSignedPreviewUrl(
      patientProfileId,
      docRecord.id
    );

    return {
      reportId: docRecord.id,
      title: exportData.reportTitle,
      filename: docRecord.originalFilename,
      mimeType: docRecord.mimeType,
      fileSizeBytes: docRecord.fileSizeBytes,
      pageCount,
      generatedAt: docRecord.uploadedAt.toISOString(),
      summary: exportData.summary,
      downloadUrl: signedUrl,
      pdfBase64: Buffer.from(pdfBytes).toString('base64'),
    };
  }

  /**
   * Retrieves raw PDF buffer for direct authenticated streaming or download.
   */
  async getReportBuffer(
    patientProfileId: string,
    documentId: string
  ): Promise<{ buffer: Buffer; doc: DocumentRecord }> {
    return this.documentService.getDocumentBuffer(patientProfileId, documentId);
  }
}
