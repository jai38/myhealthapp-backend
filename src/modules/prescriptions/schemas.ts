import { z } from 'zod';

export const DosageFormEnum = z.enum([
  'TABLET',
  'CAPSULE',
  'SYRUP',
  'INJECTION',
  'CREAM',
  'DROPS',
  'INHALER',
  'POWDER',
  'OINTMENT',
  'OTHER',
]);

export const RouteEnum = z.enum([
  'ORAL',
  'TOPICAL',
  'INTRAVENOUS',
  'INTRAMUSCULAR',
  'SUBCUTANEOUS',
  'INHALATION',
  'OPHTHALMIC',
  'NASAL',
  'OTIC',
  'RECTAL',
  'OTHER',
]);

export const ConfidenceLevelEnum = z.enum(['HIGH', 'UNCERTAIN']);

/**
 * Individual extracted medicine item.
 * Preserves the exact name as written alongside any normalized interpretation.
 */
export const ExtractedMedicineSchema = z.object({
  name_as_written: z.string().min(1, 'Medicine name as written is required'),
  normalized_medicine_name: z.string().optional(),
  strength: z.string().optional(), // e.g., "500 mg", "625 mg"
  dosage_form: DosageFormEnum.default('TABLET'),
  frequency_text: z.string().optional(), // e.g., "1-0-1", "TDS pc", "Once daily at night"
  duration_text: z.string().optional(),  // e.g., "5 days", "1 month"
  route: RouteEnum.default('ORAL'),
  instructions: z.string().optional(),   // e.g., "Take after food with warm water"
  confidence: ConfidenceLevelEnum.default('HIGH'),
  source_page: z.number().int().min(1).default(1),
});

export type ExtractedMedicine = z.infer<typeof ExtractedMedicineSchema>;

/**
 * Top-level extraction output schema.
 * Represents missing and uncertain fields explicitly without guessing.
 */
export const ExtractedPrescriptionPayloadSchema = z.object({
  prescription_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Prescription date must be in YYYY-MM-DD format')
    .optional(),
  date_is_uncertain: z.boolean().default(false),
  doctor_name: z.string().optional(),
  clinic_hospital_name: z.string().optional(),
  documented_diagnosis: z.string().optional(),
  medicines: z.array(ExtractedMedicineSchema).min(1, 'At least one medicine must be identified'),
  unparsed_notes: z.string().optional(),
  validation_warnings: z.array(z.string()).default([]),
});

export type ExtractedPrescriptionPayload = z.infer<typeof ExtractedPrescriptionPayloadSchema>;

/**
 * Patient Correction & Edit Schema
 * Allows patient to adjust any extracted field during the mandatory review step.
 */
export const PatientMedicineCorrectionSchema = z.object({
  id: z.string().optional(),
  name_as_written: z.string().min(1),
  normalized_medicine_name: z.string().optional(),
  strength: z.string().optional(),
  dosage_form: DosageFormEnum,
  frequency_text: z.string().optional(),
  duration_text: z.string().optional(),
  route: RouteEnum,
  instructions: z.string().optional(),
  is_active_medication: z.boolean().default(false), // Historical prescriptions do NOT automatically activate
});

export const PatientPrescriptionReviewSchema = z.object({
  documentId: z.string().optional(),
  document_id: z.string().optional(),
  prescription_date: z
    .string()
    .optional()
    .transform((val) => {
      if (!val || !val.trim()) return undefined;
      const trimmed = val.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
      const dmy = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (dmy && dmy[1] && dmy[2] && dmy[3]) {
        const d = dmy[1].padStart(2, '0');
        const m = dmy[2].padStart(2, '0');
        const y = dmy[3];
        return `${y}-${m}-${d}`;
      }
      return undefined;
    }),
  date_is_uncertain: z.boolean().default(false),
  doctor_name: z.string().optional(),
  clinic_hospital_name: z.string().optional(),
  documented_diagnosis: z.string().optional(),
  medicines: z.array(PatientMedicineCorrectionSchema).min(1, 'At least one medicine is required'),
});

export type PatientPrescriptionReview = z.infer<typeof PatientPrescriptionReviewSchema>;
