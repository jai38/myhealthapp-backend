import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiPrescriptionExtractionProvider, DEFAULT_GEMINI_MODEL } from '../src/modules/ai-extraction/gemini-provider.js';

describe('GeminiPrescriptionExtractionProvider', () => {
  const fakeApiKey = 'AIzaSyFakeKeyForTesting123';
  let provider: GeminiPrescriptionExtractionProvider;

  beforeEach(() => {
    provider = new GeminiPrescriptionExtractionProvider(fakeApiKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('correctly formats request and parses successful Gemini response', async () => {
    const mockGeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  prescription_date: '2026-10-15',
                  date_is_uncertain: false,
                  doctor_name: 'Dr. Priya Nair',
                  clinic_hospital_name: 'Apollo Medical Centre',
                  documented_diagnosis: 'Type 2 Diabetes Mellitus',
                  medicines: [
                    {
                      name_as_written: 'Glycomet 500mg',
                      normalized_medicine_name: 'Metformin Hydrochloride',
                      strength: '500mg',
                      dosage_form: 'TABLET',
                      frequency_text: '1-0-1',
                      duration_text: '30 days',
                      route: 'ORAL',
                      instructions: 'Take after meals',
                      confidence: 'HIGH',
                      is_active_medication: true,
                    },
                  ],
                  unparsed_notes: 'Check HbA1c in 3 months',
                  validation_warnings: [],
                }),
              },
            ],
          },
        },
      ],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockGeminiResponse,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.extractPrescription({
      documentBuffer: Buffer.from('fake pdf data'),
      mimeType: 'application/pdf',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toContain('generativelanguage.googleapis.com');
    // The key travels in a header, never in the URL.
    expect(calledUrl).not.toContain(fakeApiKey);
    expect(calledInit.headers['x-goog-api-key']).toBe(fakeApiKey);

    const parsedBody = JSON.parse(calledInit.body);
    expect(parsedBody.contents[0].parts[0].inlineData.mimeType).toBe('application/pdf');

    expect(result.prescription_date).toBe('2026-10-15');
    expect(result.doctor_name).toBe('Dr. Priya Nair');
    expect(result.medicines.length).toBe(1);
    expect(result.medicines[0].name_as_written).toBe('Glycomet 500mg');
    expect(result.medicines[0].dosage_form).toBe('TABLET');
    expect(result.medicines[0].confidence).toBe('HIGH');
  });

  it('sanitizes non-standard date formats (e.g. DD/MM/YYYY) and enums gracefully', async () => {
    const mockGeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: '```json\n' + JSON.stringify({
                  prescription_date: '15/10/2026',
                  doctor_name: 'Dr. Kumar',
                  medicines: [
                    {
                      name_as_written: 'Syrup Benadryl',
                      dosage_form: 'syrup', // lowercase
                      route: 'oral', // lowercase
                      confidence: 'medium',
                    },
                  ],
                }) + '\n```',
              },
            ],
          },
        },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockGeminiResponse,
    }));

    const result = await provider.extractPrescription({
      documentBuffer: Buffer.from('fake image data'),
      mimeType: 'image/jpeg',
    });

    expect(result.prescription_date).toBe('2026-10-15');
    expect(result.medicines[0].dosage_form).toBe('SYRUP');
    expect(result.medicines[0].route).toBe('ORAL');
    expect(result.medicines[0].confidence).toBe('UNCERTAIN');
  });

  describe('request shape and model selection', () => {
    const okResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ medicines: [] }) }] } }],
      }),
    };
    const input = { documentBuffer: Buffer.from('synthetic'), mimeType: 'application/pdf' };
    let savedModel: string | undefined;

    beforeEach(() => {
      savedModel = process.env.GEMINI_MODEL;
    });

    afterEach(() => {
      if (savedModel === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = savedModel;
    });

    it('sends no sampling params and keeps JSON response mime type', async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse);
      vi.stubGlobal('fetch', fetchMock);

      await provider.extractPrescription(input);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      for (const key of ['temperature', 'topP', 'topK', 'candidateCount', 'top_p', 'top_k', 'candidate_count']) {
        expect(body.generationConfig).not.toHaveProperty(key);
      }
    });

    it('defaults to the default model when GEMINI_MODEL is unset', async () => {
      delete process.env.GEMINI_MODEL;
      const fetchMock = vi.fn().mockResolvedValue(okResponse);
      vi.stubGlobal('fetch', fetchMock);

      await new GeminiPrescriptionExtractionProvider(fakeApiKey).extractPrescription(input);

      expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
      expect(fetchMock.mock.calls[0][0]).toContain('/models/gemini-3.5-flash-lite:generateContent');
    });

    it('uses GEMINI_MODEL when set', async () => {
      process.env.GEMINI_MODEL = 'gemini-custom-test';
      const fetchMock = vi.fn().mockResolvedValue(okResponse);
      vi.stubGlobal('fetch', fetchMock);

      await new GeminiPrescriptionExtractionProvider(fakeApiKey).extractPrescription(input);

      expect(fetchMock.mock.calls[0][0]).toContain('/models/gemini-custom-test:generateContent');
    });
  });

  it('handles Gemini API rate limits (429) or errors with helpful messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: 'Resource exhausted: quota exceeded' } }),
    }));

    await expect(
      provider.extractPrescription({
        documentBuffer: Buffer.from('data'),
        mimeType: 'application/pdf',
      })
    ).rejects.toThrow('Gemini API Error: Resource exhausted: quota exceeded');
  });
});
