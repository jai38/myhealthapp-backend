import {
  PrescriptionExtractionProvider,
  PrescriptionExtractionInput,
} from './provider.js';
import {
  ExtractedPrescriptionPayload,
  ExtractedPrescriptionPayloadSchema,
} from '../prescriptions/schemas.js';

const VALID_DOSAGE_FORMS = new Set([
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

const VALID_ROUTES = new Set([
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

/**
 * Normalizes raw LLM output into strict schema-compliant format.
 */
function sanitizeExtraction(raw: any): any {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid extraction output from AI model');
  }

  // Normalize date
  let prescriptionDate: string | undefined = undefined;
  if (typeof raw.prescription_date === 'string' && raw.prescription_date.trim()) {
    const trimmed = raw.prescription_date.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      prescriptionDate = trimmed;
    } else {
      const dmy = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (dmy) {
        prescriptionDate = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
      }
    }
  }

  // Normalize medicines list
  const rawMeds = Array.isArray(raw.medicines) ? raw.medicines : [];
  const medicines = rawMeds
    .map((m: any) => {
      const name = String(m.name_as_written || m.name || '').trim();
      if (!name) return null;

      const upperForm = String(m.dosage_form || 'TABLET').toUpperCase().trim();
      const dosageForm = VALID_DOSAGE_FORMS.has(upperForm) ? upperForm : 'OTHER';

      const upperRoute = String(m.route || 'ORAL').toUpperCase().trim();
      const route = VALID_ROUTES.has(upperRoute) ? upperRoute : 'ORAL';

      const upperConf = String(m.confidence || 'HIGH').toUpperCase().trim();
      const confidence: 'HIGH' | 'UNCERTAIN' = upperConf === 'HIGH' ? 'HIGH' : 'UNCERTAIN';

      return {
        name_as_written: name,
        normalized_medicine_name: m.normalized_medicine_name?.trim() || undefined,
        strength: m.strength?.trim() || undefined,
        dosage_form: dosageForm,
        frequency_text: m.frequency_text?.trim() || undefined,
        duration_text: m.duration_text?.trim() || undefined,
        route,
        instructions: m.instructions?.trim() || undefined,
        confidence,
        source_page: typeof m.source_page === 'number' ? m.source_page : 1,
      };
    })
    .filter(Boolean);

  // If no medicines could be detected, supply an editable placeholder
  if (medicines.length === 0) {
    medicines.push({
      name_as_written: 'Unidentified Medicine (Please specify name)',
      dosage_form: 'TABLET',
      route: 'ORAL',
      confidence: 'UNCERTAIN',
      source_page: 1,
    });
  }

  return {
    prescription_date: prescriptionDate,
    date_is_uncertain: Boolean(raw.date_is_uncertain || !prescriptionDate),
    doctor_name: raw.doctor_name?.trim() || undefined,
    clinic_hospital_name: raw.clinic_hospital_name?.trim() || undefined,
    documented_diagnosis: raw.documented_diagnosis?.trim() || undefined,
    medicines,
    unparsed_notes: raw.unparsed_notes?.trim() || undefined,
    validation_warnings: Array.isArray(raw.validation_warnings) ? raw.validation_warnings : [],
  };
}

/**
 * Production Gemini AI Extraction Provider for Real Prescription Documents.
 * Uses Google Gemini multimodal API for OCR and structured clinical extraction.
 */
export class GeminiPrescriptionExtractionProvider implements PrescriptionExtractionProvider {
  readonly providerName: string;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'gemini-1.5-flash') {
    this.apiKey = apiKey.trim();
    this.model = model;
    this.providerName = `gemini-${model}`;
  }

  async extractPrescription(input: PrescriptionExtractionInput): Promise<ExtractedPrescriptionPayload> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const promptText = `You are an expert clinical prescription parser and medical OCR system.
Analyze the provided medical prescription document (handwritten or typed, clinic slip, hospital letterhead, discharge summary, or e-prescription) and extract all clinical details accurately.

Extract into a JSON object matching this exact structure:
{
  "prescription_date": "YYYY-MM-DD" or null if unstated,
  "date_is_uncertain": boolean,
  "doctor_name": "Full name of prescribing doctor" or null,
  "clinic_hospital_name": "Name of clinic or hospital" or null,
  "documented_diagnosis": "Diagnosis, chief complaint, or indication" or null,
  "medicines": [
    {
      "name_as_written": "Exact medicine name written on the prescription",
      "normalized_medicine_name": "Generic or scientific drug name if known",
      "strength": "e.g. 500mg, 10ml, 625mg",
      "dosage_form": "TABLET, CAPSULE, SYRUP, INJECTION, CREAM, DROPS, INHALER, POWDER, OINTMENT, or OTHER",
      "frequency_text": "e.g. 1-0-1, OD, BD, TDS pc, Once daily, Twice daily",
      "duration_text": "e.g. 5 days, 1 month, 2 weeks",
      "route": "ORAL, TOPICAL, INTRAVENOUS, INTRAMUSCULAR, SUBCUTANEOUS, INHALATION, OPHTHALMIC, NASAL, OTIC, RECTAL, or OTHER",
      "instructions": "e.g. Take after food, Before breakfast",
      "confidence": "HIGH, MEDIUM, or LOW",
      "is_active_medication": true
    }
  ],
  "unparsed_notes": "Any other clinical notes on the page",
  "validation_warnings": ["Warnings about handwriting legibility or missing fields"]
}

Important:
- Return ONLY a valid JSON object matching the schema above.
- Make sure every medicine has "name_as_written", "dosage_form", and "route".`;

    const requestBody = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: input.mimeType,
                data: input.documentBuffer.toString('base64'),
              },
            },
            {
              text: promptText,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errBody = await res.text();
      let errorMsg = `Gemini extraction failed (HTTP ${res.status})`;
      try {
        const errJson = JSON.parse(errBody);
        if (errJson.error?.message) {
          errorMsg = `Gemini API Error: ${errJson.error.message}`;
        }
      } catch {
        errorMsg = `Gemini API Error: ${errBody.slice(0, 200)}`;
      }
      throw new Error(errorMsg);
    }

    const resJson = (await res.json()) as any;
    const textOutput = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textOutput) {
      throw new Error('Gemini API returned empty extraction text output.');
    }

    const cleanJson = textOutput
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();

    const parsedJson = JSON.parse(cleanJson);
    const sanitized = sanitizeExtraction(parsedJson);

    return ExtractedPrescriptionPayloadSchema.parse(sanitized);
  }
}
