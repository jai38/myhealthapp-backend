import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib';
import { TimelineEventDetailRecord, MedicationDetailRecord } from '../persistence/repositories.js';

export interface ExportDataPayload {
  patient: {
    patientProfileId: string;
    fullName: string;
  };
  reportTitle: string;
  generatedAt: string;
  dateRange: {
    startDate?: string | null;
    endDate?: string | null;
    label: string;
  };
  summary: {
    timelineEventsCount: number;
    medicationsCount: number;
    totalRecords: number;
  };
  timelineEvents: TimelineEventDetailRecord[];
  medications: MedicationDetailRecord[];
}

/**
 * Sanitizes input string to WinAnsi/ASCII printable range.
 * Replaces common unicode typography with safe ASCII equivalents.
 */
function sanitizeAscii(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/[\u2014\u2015]/g, '--') // em dash
    .replace(/[\u2012\u2013]/g, '-')  // en dash
    .replace(/[\u2018\u2019]/g, "'")  // curly single quotes
    .replace(/[\u201c\u201d]/g, '"')  // curly double quotes
    .replace(/\u2022/g, '-')          // bullet
    .replace(/\u2026/g, '...')        // ellipsis
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ') // replace other non-ascii with space
    .trim();
}

/**
 * Wraps text into lines that do not exceed maxWidth at fontSize with given font.
 */
function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const sanitized = sanitizeAscii(text);
  if (!sanitized) return [''];

  const words = sanitized.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const width = font.widthOfTextAtSize(testLine, fontSize);
    if (width <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Formats a medical date preserving precision and uncertainty.
 */
function formatEventDate(dateStr: string, precision?: string, isUncertain?: boolean): string {
  if (!dateStr) return 'Date not documented';

  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    return isUncertain ? `${dateStr} [Approximate]` : dateStr;
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();

  let formatted = '';
  if (precision === 'YEAR') {
    formatted = `${year} (Year Precision)`;
  } else if (precision === 'MONTH') {
    formatted = `${month} ${year} (Month Precision)`;
  } else {
    formatted = `${day} ${month} ${year}`;
  }

  if (isUncertain) {
    formatted += ' [Approximate Date]';
  }

  return formatted;
}

/**
 * Formats an ISO timestamp into a clean, human-readable date and time.
 */
function formatTimestamp(isoStr: string | undefined): string {
  if (!isoStr) return 'Not documented';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = d.getUTCDate();
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  let hours = d.getUTCHours();
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${day} ${month} ${year}, ${hours}:${minutes} ${ampm} (UTC)`;
}

/**
 * Cleans internal storage keys / hashes into doctor-friendly document references.
 */
function formatSourceFilename(filename: string | null | undefined): string {
  if (!filename) return 'Verified Clinical Record';
  const base = filename.replace(/\.[^/.]+$/, '');
  if (/^[a-f0-9]{20,}$/i.test(base) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)) {
    return 'Prescription Document (Verified)';
  }
  return filename;
}

/**
 * Converts raw database event type enums into natural medical descriptions.
 */
function formatEventType(type: string | undefined): string {
  if (!type) return 'Medical Record';
  switch (type.toUpperCase()) {
    case 'PRESCRIPTION_RECORDED':
      return 'Prescription Record';
    case 'LAB_RESULT':
      return 'Lab & Diagnostic Report';
    case 'CLINICAL_NOTE':
      return 'Clinical Consultation Note';
    case 'DISCHARGE_SUMMARY':
      return 'Discharge Summary';
    case 'VACCINATION':
      return 'Immunization Record';
    default:
      return type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/**
 * Converts 24-hr time strings to 12-hour AM/PM.
 */
function formatReminderTimeString(timeStr: string): string {
  if (!timeStr) return '';
  const parts = timeStr.trim().split(':');
  const hStr = parts[0];
  if (!hStr) return timeStr;
  const h = parseInt(hStr, 10);
  if (isNaN(h)) return timeStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const m = parts[1] ? parts[1].padStart(2, '0') : '00';
  return `${h12}:${m} ${ampm}`;
}

/**
 * Color definitions for clean clinical document styling.
 */
const C_TEAL = rgb(0.06, 0.46, 0.43);       // #0f766e Primary Teal
const C_SLATE = rgb(0.12, 0.16, 0.23);      // #1e293b Dark Heading
const C_BODY = rgb(0.20, 0.25, 0.33);       // #334155 Body Text
const C_MUTED = rgb(0.45, 0.50, 0.60);      // #718096 Muted Text
const C_BORDER = rgb(0.85, 0.88, 0.92);     // #d9e2ec Card / Divider line
const C_BG_CARD = rgb(0.96, 0.98, 0.99);    // #f4f7f9 Subtle Card Fill
const C_ACTIVE_GREEN = rgb(0.09, 0.64, 0.29);// #16a34a Active Status
const C_WARN_AMBER = rgb(0.85, 0.45, 0.08); // #d97706 Warning Status

/**
 * Multi-page layout coordinator.
 */
class PdfPageManager {
  doc: PDFDocument;
  fontRegular: PDFFont;
  fontBold: PDFFont;
  fontItalic: PDFFont;
  pages: PDFPage[] = [];
  currentPage: PDFPage;
  currentY: number;

  readonly margin = 40;
  readonly pageWidth = 595.28;  // A4 width in pt
  readonly pageHeight = 841.89; // A4 height in pt
  readonly contentWidth: number;
  readonly bottomLimit = 55;   // Leave 55pt for footer & disclaimers
  readonly headerTitle: string;

  constructor(
    doc: PDFDocument,
    fontRegular: PDFFont,
    fontBold: PDFFont,
    fontItalic: PDFFont,
    headerTitle: string
  ) {
    this.doc = doc;
    this.fontRegular = fontRegular;
    this.fontBold = fontBold;
    this.fontItalic = fontItalic;
    this.headerTitle = headerTitle;
    this.contentWidth = this.pageWidth - this.margin * 2;

    this.currentPage = this.addNewPage(true);
    this.currentY = this.pageHeight - this.margin;
  }

  addNewPage(isFirstPage = false): PDFPage {
    const page = this.doc.addPage([this.pageWidth, this.pageHeight]);
    this.pages.push(page);
    this.currentPage = page;
    this.currentY = this.pageHeight - this.margin;

    // Running Header for subsequent pages
    if (!isFirstPage) {
      page.drawText('MY HEALTH APP -- ' + sanitizeAscii(this.headerTitle).toUpperCase(), {
        x: this.margin,
        y: this.pageHeight - 25,
        size: 8,
        font: this.fontBold,
        color: C_MUTED,
      });

      page.drawText('CONFIDENTIAL PATIENT RECORD', {
        x: this.pageWidth - this.margin - 140,
        y: this.pageHeight - 25,
        size: 8,
        font: this.fontRegular,
        color: C_MUTED,
      });

      page.drawLine({
        start: { x: this.margin, y: this.pageHeight - 30 },
        end: { x: this.pageWidth - this.margin, y: this.pageHeight - 30 },
        thickness: 0.5,
        color: C_BORDER,
      });

      this.currentY = this.pageHeight - 45;
    }

    return page;
  }

  ensureSpace(neededHeight: number): void {
    if (this.currentY - neededHeight < this.bottomLimit) {
      this.addNewPage(false);
    }
  }

  drawText(
    text: string,
    x: number,
    fontSize: number,
    options?: { font?: PDFFont; color?: any; maxWidth?: number }
  ): void {
    const font = options?.font || this.fontRegular;
    const color = options?.color || C_BODY;
    const maxWidth = options?.maxWidth || (this.pageWidth - this.margin - x);

    const lines = wrapText(text, font, fontSize, maxWidth);
    const lineHeight = fontSize + 3;

    for (const line of lines) {
      this.ensureSpace(lineHeight);
      this.currentPage.drawText(line, {
        x,
        y: this.currentY,
        size: fontSize,
        font,
        color,
      });
      this.currentY -= lineHeight;
    }
  }

  drawDivider(thickness = 0.5, color = C_BORDER): void {
    this.ensureSpace(10);
    this.currentY -= 4;
    this.currentPage.drawLine({
      start: { x: this.margin, y: this.currentY },
      end: { x: this.pageWidth - this.margin, y: this.currentY },
      thickness,
      color,
    });
    this.currentY -= 6;
  }

  applyFooters(): void {
    const totalPages = this.pages.length;
    const disclaimer =
      'Notice: This document is an export of patient-verified personal health records compiled using My Health App. ' +
      'It is provided for informational and clinical reference purposes only and does not constitute a new medical ' +
      'prescription or clinical diagnosis. Please verify against original clinical source documentation.';

    this.pages.forEach((page, i) => {
      // Divider above footer
      page.drawLine({
        start: { x: this.margin, y: 38 },
        end: { x: this.pageWidth - this.margin, y: 38 },
        thickness: 0.5,
        color: C_BORDER,
      });

      // Page numbers (right aligned)
      const pageStr = `Page ${i + 1} of ${totalPages}`;
      const pageStrWidth = this.fontRegular.widthOfTextAtSize(pageStr, 7.5);
      page.drawText(pageStr, {
        x: this.pageWidth - this.margin - pageStrWidth,
        y: 28,
        size: 7.5,
        font: this.fontRegular,
        color: C_MUTED,
      });

      // Medical & Legal Disclaimer text (2 lines)
      const disclaimerLines = wrapText(disclaimer, this.fontItalic, 6.5, this.contentWidth - pageStrWidth - 20);
      let footerY = 28;
      for (const line of disclaimerLines) {
        page.drawText(line, {
          x: this.margin,
          y: footerY,
          size: 6.5,
          font: this.fontItalic,
          color: C_MUTED,
        });
        footerY -= 8;
      }
    });
  }
}

/**
 * Generates a complete, multi-page medical summary report in PDF format.
 */
export async function generateMedicalReportPdf(
  data: ExportDataPayload
): Promise<{ pdfBytes: Uint8Array; pageCount: number }> {
  const doc = await PDFDocument.create();

  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const mgr = new PdfPageManager(doc, fontRegular, fontBold, fontItalic, data.reportTitle);

  // 1. TOP BRAND ACCENT BAR
  mgr.currentPage.drawRectangle({
    x: 0,
    y: mgr.pageHeight - 6,
    width: mgr.pageWidth,
    height: 6,
    color: C_TEAL,
  });

  // 2. HEADER
  mgr.currentY -= 10;
  mgr.drawText('MY HEALTH APP', mgr.margin, 15, { font: fontBold, color: C_TEAL });
  mgr.currentY += 2;
  mgr.drawText(sanitizeAscii(data.reportTitle).toUpperCase(), mgr.margin, 12, {
    font: fontBold,
    color: C_SLATE,
  });
  mgr.currentY -= 2;

  // 3. PATIENT & REPORT METADATA CARD
  mgr.ensureSpace(70);
  const cardHeight = 62;
  const cardY = mgr.currentY - cardHeight;

  mgr.currentPage.drawRectangle({
    x: mgr.margin,
    y: cardY,
    width: mgr.contentWidth,
    height: cardHeight,
    color: C_BG_CARD,
    borderColor: C_BORDER,
    borderWidth: 1,
  });

  const col1X = mgr.margin + 12;
  const col2X = mgr.margin + mgr.contentWidth / 2 + 10;
  let textY = mgr.currentY - 14;

  // Col 1: Patient details & verification
  mgr.currentPage.drawText('Patient Name:', { x: col1X, y: textY, size: 8, font: fontBold, color: C_MUTED });
  mgr.currentPage.drawText(sanitizeAscii(data.patient.fullName || 'Verified Patient'), {
    x: col1X + 70,
    y: textY,
    size: 9.5,
    font: fontBold,
    color: C_SLATE,
  });

  textY -= 14;
  mgr.currentPage.drawText('Record Status:', { x: col1X, y: textY, size: 8, font: fontBold, color: C_MUTED });
  mgr.currentPage.drawText('Verified Patient Health Record', {
    x: col1X + 70,
    y: textY,
    size: 8,
    font: fontBold,
    color: C_TEAL,
  });

  textY -= 14;
  mgr.currentPage.drawText('Reporting Period:', { x: col1X, y: textY, size: 8, font: fontBold, color: C_MUTED });
  mgr.currentPage.drawText(sanitizeAscii(data.dateRange.label || 'All Historical Records'), {
    x: col1X + 70,
    y: textY,
    size: 8,
    font: fontRegular,
    color: C_BODY,
  });

  // Col 2: Generation stats & Clean Reference Code
  textY = mgr.currentY - 14;
  const cleanRefCode = `MSR-${new Date(data.generatedAt || Date.now()).getFullYear()}-${(data.patient.patientProfileId || 'PAT').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase()}`;
  mgr.currentPage.drawText('Reference No:', { x: col2X, y: textY, size: 8, font: fontBold, color: C_MUTED });
  mgr.currentPage.drawText(cleanRefCode, {
    x: col2X + 70,
    y: textY,
    size: 8,
    font: fontBold,
    color: C_SLATE,
  });

  textY -= 14;
  mgr.currentPage.drawText('Generated On:', { x: col2X, y: textY, size: 8, font: fontBold, color: C_MUTED });
  mgr.currentPage.drawText(formatTimestamp(data.generatedAt), {
    x: col2X + 70,
    y: textY,
    size: 8,
    font: fontRegular,
    color: C_BODY,
  });

  textY -= 14;
  mgr.currentPage.drawText('Clinical Counts:', { x: col2X, y: textY, size: 8, font: fontBold, color: C_MUTED });
  mgr.currentPage.drawText(`${data.summary.timelineEventsCount} Event(s)  •  ${data.summary.medicationsCount} Medication(s)`, {
    x: col2X + 70,
    y: textY,
    size: 8,
    font: fontRegular,
    color: C_BODY,
  });

  mgr.currentY = cardY - 14;

  // 4. SECTION 1: VERIFIED MEDICAL TIMELINE
  if (data.timelineEvents && data.timelineEvents.length > 0) {
    mgr.ensureSpace(35);

    // Section Header Banner
    mgr.currentPage.drawRectangle({
      x: mgr.margin,
      y: mgr.currentY - 18,
      width: mgr.contentWidth,
      height: 18,
      color: C_BG_CARD,
    });
    mgr.currentPage.drawText('1. VERIFIED MEDICAL TIMELINE', {
      x: mgr.margin + 8,
      y: mgr.currentY - 13,
      size: 9.5,
      font: fontBold,
      color: C_TEAL,
    });
    mgr.currentY -= 26;

    mgr.drawText(
      'Chronological history of patient-reviewed clinical encounters, prescriptions, and verified documents.',
      mgr.margin + 4,
      7.5,
      { font: fontItalic, color: C_MUTED }
    );
    mgr.currentY -= 4;

    for (const event of data.timelineEvents) {
      if (!event) continue;
      mgr.ensureSpace(50);

      // Event Date Badge & Title
      const dateFormatted = formatEventDate(event.eventDate, event.datePrecision, event.dateIsUncertain);
      mgr.drawText(`[${dateFormatted}]  ${event.title}`, mgr.margin + 4, 9, {
        font: fontBold,
        color: C_SLATE,
      });

      // Category & Status (Cleaned up from raw enums)
      const metaLine = `Record Type: ${formatEventType(event.eventType)}  •  Status: Verified Clinical Record`;
      mgr.drawText(metaLine, mgr.margin + 4, 7.5, { font: fontRegular, color: C_TEAL });

      // Summary
      if (event.summary) {
        mgr.drawText(event.summary, mgr.margin + 4, 8, {
          font: fontRegular,
          color: C_BODY,
          maxWidth: mgr.contentWidth - 8,
        });
      }

      // Provenance attribution (Cleaned up from raw hashes)
      const provItems: string[] = [];
      if (event.prescription?.doctorName) {
        provItems.push(`Clinician: Dr. ${event.prescription.doctorName.replace(/^dr\.?\s+/i, '')}`);
      }
      if (event.prescription?.clinicHospitalName) {
        provItems.push(`Facility: ${event.prescription.clinicHospitalName}`);
      }
      if (event.prescription?.diagnosis) {
        provItems.push(`Diagnosis: ${event.prescription.diagnosis}`);
      }
      if (event.sourceDocument?.originalFilename) {
        provItems.push(`Source: ${formatSourceFilename(event.sourceDocument.originalFilename)}`);
      }

      if (provItems.length > 0) {
        mgr.drawText(provItems.join('  •  '), mgr.margin + 4, 7, {
          font: fontItalic,
          color: C_MUTED,
        });
      }

      mgr.drawDivider(0.5);
    }
  }

  // 5. SECTION 2: MEDICATIONS & REGIMENS
  if (data.medications && data.medications.length > 0) {
    mgr.ensureSpace(35);

    // Section Header Banner
    mgr.currentPage.drawRectangle({
      x: mgr.margin,
      y: mgr.currentY - 18,
      width: mgr.contentWidth,
      height: 18,
      color: C_BG_CARD,
    });
    mgr.currentPage.drawText('2. MEDICATIONS & REGIMENS', {
      x: mgr.margin + 8,
      y: mgr.currentY - 13,
      size: 9.5,
      font: fontBold,
      color: C_TEAL,
    });
    mgr.currentY -= 26;

    mgr.drawText(
      'Medications extracted from confirmed prescriptions, with patient-selected reminder schedules clearly separated.',
      mgr.margin + 4,
      7.5,
      { font: fontItalic, color: C_MUTED }
    );
    mgr.currentY -= 4;

    for (const med of data.medications) {
      if (!med) continue;
      mgr.ensureSpace(60);

      // Status label and color
      let statusColor = C_MUTED;
      let statusLabel = `[${med.status}]`;
      if (med.status === 'ACTIVE') {
        statusColor = C_ACTIVE_GREEN;
        statusLabel = '[ACTIVE REGIMEN]';
      } else if (med.status === 'INACTIVE') {
        statusLabel = '[PRESCRIBED - NOT ACTIVATED]';
      } else if (med.status === 'DISCONTINUED') {
        statusColor = C_WARN_AMBER;
        statusLabel = '[DISCONTINUED]';
      } else if (med.status === 'COMPLETED') {
        statusLabel = '[COMPLETED COURSE]';
      }

      // Medicine Name (as written) + status badge
      const nameText = `${med.nameAsWritten}${med.normalizedMedicineName && med.normalizedMedicineName !== med.nameAsWritten ? ` (${med.normalizedMedicineName})` : ''}  ${statusLabel}`;
      mgr.drawText(nameText, mgr.margin + 4, 9, { font: fontBold, color: statusColor });

      // Strength, Form, Route - only display strength if documented
      const medDetails: string[] = [];
      if (med.dosageForm && med.dosageForm.toLowerCase() !== 'other') {
        medDetails.push(`Form: ${med.dosageForm.charAt(0).toUpperCase() + med.dosageForm.slice(1).toLowerCase()}`);
      }
      if (med.strength && med.strength.toLowerCase() !== 'not documented' && med.strength.trim() !== '') {
        medDetails.push(`Strength: ${med.strength}`);
      }
      if (med.route) {
        medDetails.push(`Route: ${med.route.charAt(0).toUpperCase() + med.route.slice(1).toLowerCase()}`);
      }
      if (medDetails.length > 0) {
        mgr.drawText(medDetails.join('  •  '), mgr.margin + 4, 7.5, { font: fontRegular, color: C_BODY });
      }

      // Prescribed Instructions (exact verbatim text)
      if (med.prescribedInstructions && med.prescribedInstructions.trim() !== '') {
        mgr.drawText(`Prescribed Instructions: "${med.prescribedInstructions}"`, mgr.margin + 4, 8, {
          font: fontBold,
          color: C_SLATE,
          maxWidth: mgr.contentWidth - 8,
        });
      } else {
        mgr.drawText('Prescribed Instructions: None specified on source document', mgr.margin + 4, 7.5, {
          font: fontItalic,
          color: C_MUTED,
        });
      }

      // Patient-Selected Reminder Schedule (12-hour AM/PM format)
      if (med.reminderTimes && Array.isArray(med.reminderTimes) && med.reminderTimes.length > 0) {
        const formattedTimes = med.reminderTimes.map(formatReminderTimeString).join(', ');
        mgr.drawText(
          `Patient Reminder Preference: ${formattedTimes} (Patient-configured, not clinician order)`,
          mgr.margin + 4,
          7.5,
          { font: fontRegular, color: C_TEAL }
        );
      } else {
        mgr.drawText('Reminder Schedule: No active reminder times configured by patient', mgr.margin + 4, 7, {
          font: fontItalic,
          color: C_MUTED,
        });
      }

      // Dates (start / end)
      const dateParts: string[] = [];
      if (med.startDate) dateParts.push(`Start: ${med.startDate}`);
      if (med.endDate) dateParts.push(`End: ${med.endDate}`);
      if (med.completedAt) dateParts.push(`Completed: ${new Date(med.completedAt).toISOString().split('T')[0]}`);
      if (med.discontinuedAt) {
        dateParts.push(
          `Discontinued: ${new Date(med.discontinuedAt).toISOString().split('T')[0]}${med.discontinuedReason ? ` (${med.discontinuedReason})` : ''}`
        );
      }

      if (dateParts.length > 0) {
        mgr.drawText(`Regimen Dates: ${dateParts.join('  •  ')}`, mgr.margin + 4, 7, {
          font: fontRegular,
          color: C_BODY,
        });
      }

      // Provenance (Cleaned up from raw hashes)
      const medProv: string[] = [];
      if (med.prescription?.doctorName) medProv.push(`Prescribed by: Dr. ${med.prescription.doctorName.replace(/^dr\.?\s+/i, '')}`);
      if (med.prescription?.clinicHospitalName) medProv.push(`Clinic: ${med.prescription.clinicHospitalName}`);
      if (med.sourceDocument?.originalFilename) medProv.push(`Source: ${formatSourceFilename(med.sourceDocument.originalFilename)}`);

      if (medProv.length > 0) {
        mgr.drawText(medProv.join('  •  '), mgr.margin + 4, 7, {
          font: fontItalic,
          color: C_MUTED,
        });
      }

      mgr.drawDivider(0.5);
    }
  }

  // 6. IF NO RECORDS IN REPORT
  if ((!data.timelineEvents || data.timelineEvents.length === 0) && (!data.medications || data.medications.length === 0)) {
    mgr.ensureSpace(40);
    mgr.drawText('No eligible medical records were found for the selected date range and criteria.', mgr.margin + 4, 9, {
      font: fontItalic,
      color: C_MUTED,
    });
  }

  // 7. APPLY RUNNING FOOTERS WITH LEGAL/CLINICAL DISCLAIMER AND PAGE NUMBERS
  mgr.applyFooters();

  const pdfBytes = await doc.save();
  return { pdfBytes, pageCount: mgr.pages.length };
}
