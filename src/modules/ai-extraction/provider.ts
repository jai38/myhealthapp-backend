import {
  ExtractedPrescriptionPayload,
  ExtractedPrescriptionPayloadSchema,
} from '../prescriptions/schemas.js';

export interface PrescriptionExtractionInput {
  documentBuffer: Buffer;
  mimeType: string;
  pageCount?: number;
  regionHint?: 'IN' | 'GLOBAL';
  options?: {
    targetLanguage?: string;
    regionHint?: 'IN' | 'GLOBAL';
  };
}

export interface PrescriptionExtractionProvider {
  readonly providerName: string;
  extractPrescription(input: PrescriptionExtractionInput): Promise<ExtractedPrescriptionPayload>;
}

export interface MockProviderConfig {
  mode?: 'CLEAN' | 'UNCERTAIN' | 'MISSING_DATE' | 'TIMEOUT' | 'RATE_LIMIT' | 'PROVIDER_ERROR';
  customPayload?: ExtractedPrescriptionPayload;
  simulatedDelayMs?: number;
}

/**
 * Deterministic Mock Provider for Local Development, CI, and Automated Testing.
 * Zero external network calls. Zero third-party patient data exposure.
 */
export class MockPrescriptionExtractionProvider implements PrescriptionExtractionProvider {
  readonly providerName = 'mock-indian-rx-v1';
  private config: MockProviderConfig;

  constructor(config: MockProviderConfig = { mode: 'CLEAN' }) {
    this.config = config;
  }

  setMode(mode: MockProviderConfig['mode']) {
    this.config.mode = mode;
  }

  setCustomPayload(payload: ExtractedPrescriptionPayload) {
    this.config.customPayload = payload;
  }

  async extractPrescription(_input: PrescriptionExtractionInput): Promise<ExtractedPrescriptionPayload> {
    if (this.config.simulatedDelayMs && this.config.simulatedDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.simulatedDelayMs));
    }

    if (this.config.mode === 'TIMEOUT') {
      throw new Error('AI extraction provider request timed out (simulated 504)');
    }

    if (this.config.mode === 'RATE_LIMIT') {
      throw new Error('AI extraction provider rate limit exceeded (simulated 429)');
    }

    if (this.config.mode === 'PROVIDER_ERROR') {
      throw new Error('AI extraction provider internal failure (simulated 500)');
    }

    if (this.config.customPayload) {
      // Validate schema before returning to guarantee deterministic compliance
      return ExtractedPrescriptionPayloadSchema.parse(this.config.customPayload);
    }

    let payload: ExtractedPrescriptionPayload;

    switch (this.config.mode) {
      case 'UNCERTAIN':
        payload = {
          prescription_date: '2026-10-10',
          date_is_uncertain: false,
          doctor_name: 'Dr. R. Sharma, MD',
          clinic_hospital_name: 'City Care Clinic, Bengaluru',
          documented_diagnosis: 'Acute Bronchitis & Cough',
          medicines: [
            {
              name_as_written: 'Augmentin 625',
              normalized_medicine_name: 'Amoxicillin and Clavulanate Potassium 625mg',
              strength: '625 mg',
              dosage_form: 'TABLET',
              frequency_text: '1-0-1',
              duration_text: '5 days',
              route: 'ORAL',
              instructions: 'Take after food',
              confidence: 'HIGH',
              source_page: 1,
            },
            {
              name_as_written: 'Cough Syr (Ascoril?)',
              normalized_medicine_name: undefined,
              strength: undefined,
              dosage_form: 'SYRUP',
              frequency_text: 'TDS pc (unclear handwriting)',
              duration_text: '3-5 days',
              route: 'ORAL',
              instructions: '5ml as directed',
              confidence: 'UNCERTAIN',
              source_page: 1,
            },
          ],
          unparsed_notes: 'Hydration advised. Review in 5 days if fever persists.',
          validation_warnings: [
            'Medicine 2 has ambiguous cursive handwriting and unclear strength. Explicit review required.',
          ],
        };
        break;

      case 'MISSING_DATE':
        payload = {
          prescription_date: undefined,
          date_is_uncertain: true,
          doctor_name: 'Dr. V. Kulkarni, MBBS',
          clinic_hospital_name: 'Community Health Centre',
          documented_diagnosis: 'Gastritis / Reflux',
          medicines: [
            {
              name_as_written: 'Pantocid 40',
              normalized_medicine_name: 'Pantoprazole 40mg',
              strength: '40 mg',
              dosage_form: 'TABLET',
              frequency_text: '1-0-0',
              duration_text: '14 days',
              route: 'ORAL',
              instructions: 'Empty stomach in morning',
              confidence: 'HIGH',
              source_page: 1,
            },
          ],
          unparsed_notes: 'Avoid spicy food.',
          validation_warnings: ['Prescription date is missing from document header.'],
        };
        break;

      case 'CLEAN':
      default:
        payload = {
          prescription_date: '2026-10-12',
          date_is_uncertain: false,
          doctor_name: 'Dr. A. Verma, MD (Gen Med)',
          clinic_hospital_name: 'Apollo Clinic, Indiranagar',
          documented_diagnosis: 'Type 2 Diabetes Mellitus & Hypertension',
          medicines: [
            {
              name_as_written: 'Glycomet 500 SR',
              normalized_medicine_name: 'Metformin Hydrochloride 500mg Sustained Release',
              strength: '500 mg',
              dosage_form: 'TABLET',
              frequency_text: '1-0-1',
              duration_text: '30 days',
              route: 'ORAL',
              instructions: 'Take with breakfast and dinner',
              confidence: 'HIGH',
              source_page: 1,
            },
            {
              name_as_written: 'Telma 40',
              normalized_medicine_name: 'Telmisartan 40mg',
              strength: '40 mg',
              dosage_form: 'TABLET',
              frequency_text: '1-0-0',
              duration_text: '30 days',
              route: 'ORAL',
              instructions: 'Take in morning',
              confidence: 'HIGH',
              source_page: 1,
            },
          ],
          unparsed_notes: 'Routine FBS/PPBS in 1 month.',
          validation_warnings: [],
        };
        break;
    }

    return ExtractedPrescriptionPayloadSchema.parse(payload);
  }
}
