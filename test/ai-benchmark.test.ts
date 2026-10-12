import { describe, it, expect } from 'vitest';
import {
  BenchmarkEvaluator,
} from '../src/modules/ai-extraction/benchmark/evaluator.js';
import {
  INDIAN_PRESCRIPTION_BENCHMARK_DATASET,
} from '../src/modules/ai-extraction/benchmark/dataset.js';
import {
  MockPrescriptionExtractionProvider,
  PrescriptionExtractionProvider,
  PrescriptionExtractionInput,
} from '../src/modules/ai-extraction/provider.js';
import { ExtractedPrescriptionPayload } from '../src/modules/prescriptions/schemas.js';

/**
 * Harness verification test double:
 * Feeds known reference payloads through BenchmarkEvaluator to verify
 * that the evaluator's mathematical scoring, safety rule checks, and negative control gates work accurately.
 *
 * NOTE: This is a test harness verification double. It tests the scoring engine,
 * NOT the clinical accuracy of a production AI model.
 */
class HarnessVerificationProvider implements PrescriptionExtractionProvider {
  readonly providerName = 'harness-verification-double';

  async extractPrescription(input: PrescriptionExtractionInput): Promise<ExtractedPrescriptionPayload> {
    const text = input.documentBuffer.toString('utf-8');
    const matched = INDIAN_PRESCRIPTION_BENCHMARK_DATASET.find((c) =>
      text.includes(c.syntheticDocumentText)
    );
    if (matched) return matched.expectedPayload;
    return INDIAN_PRESCRIPTION_BENCHMARK_DATASET[0]!.expectedPayload;
  }
}

describe('Indian Prescription Benchmark Dataset & Evaluator Harness', () => {
  it('documents provenance and permitted use for all 32 synthetic test fixtures', () => {
    expect(INDIAN_PRESCRIPTION_BENCHMARK_DATASET.length).toBe(32);

    for (const fixture of INDIAN_PRESCRIPTION_BENCHMARK_DATASET) {
      expect(fixture.provenance).toBeDefined();
      expect(fixture.provenance.origin).toBe('SYNTHETIC_CLINICAL_FIXTURE');
      expect(fixture.provenance.phiStatus).toBe('ZERO_PHI_SYNTHETIC');
      expect(fixture.provenance.permittedUse).toBe('BENCHMARK_EVALUATION_AND_HARNESS_TESTING_ONLY');
    }
  });

  it('covers critical clinical difficulty categories', () => {
    const categories = new Set(INDIAN_PRESCRIPTION_BENCHMARK_DATASET.map((c) => c.category));
    expect(categories.has('HANDWRITTEN_CLINIC_SLIP')).toBe(true);
    expect(categories.has('STANDARD_ABBREVIATIONS')).toBe(true);
    expect(categories.has('CHRONIC_CARE_REGIMEN')).toBe(true);
    expect(categories.has('PEDIATRIC_DOSAGE')).toBe(true);
    expect(categories.has('UNCERTAIN_HANDWRITING')).toBe(true);
    expect(categories.has('MISSING_METADATA')).toBe(true);
    expect(categories.has('MULTIPAGE_DISCHARGE_SUMMARY')).toBe(true);
    expect(categories.has('NEGATIVE_CONTROL')).toBe(true);
  });

  it('verifies that BenchmarkEvaluator scoring logic correctly computes metrics on known fixtures', async () => {
    const evaluator = new BenchmarkEvaluator();
    const harnessDouble = new HarnessVerificationProvider();

    const report = await evaluator.evaluate(harnessDouble, INDIAN_PRESCRIPTION_BENCHMARK_DATASET);

    expect(report.totalCases).toBe(32);
    expect(report.passedCases).toBe(32);
    expect(report.exactNamePreservationRate).toBe(100);
    expect(report.safetyComplianceRate).toBe(100);
    expect(report.providerName).toBe('harness-verification-double');
  });

  it('proves that BenchmarkEvaluator detects safety rule violations and flags them', async () => {
    const evaluator = new BenchmarkEvaluator();

    // Flawed provider that drops exact medicine names and fabricates missing dates
    const flawedProvider: PrescriptionExtractionProvider = {
      providerName: 'flawed-test-double',
      async extractPrescription(): Promise<ExtractedPrescriptionPayload> {
        return {
          prescription_date: '2026-10-12', // Fabricates date even when document had none!
          date_is_uncertain: false,
          medicines: [], // Dropped medicine names completely!
          validation_warnings: [],
        };
      },
    };

    const singleCase = [INDIAN_PRESCRIPTION_BENCHMARK_DATASET.find((c) => c.category === 'MISSING_METADATA')!];
    const report = await evaluator.evaluate(flawedProvider, singleCase);

    expect(report.passedCases).toBe(0);
    expect(report.exactNamePreservationRate).toBe(0);
    expect(report.safetyComplianceRate).toBe(0);
    expect(report.caseResults[0]!.safetyRulesPassed).toBe(false);
    expect(report.caseResults[0]!.warningsOrErrors.some((w) => w.includes('Safety violation'))).toBe(true);
  });

  it('verifies MockPrescriptionExtractionProvider contract in isolation (zero external network, deterministic)', async () => {
    const cleanProvider = new MockPrescriptionExtractionProvider({ mode: 'CLEAN' });
    const cleanResult = await cleanProvider.extractPrescription({
      documentBuffer: Buffer.from('%PDF-1.4 test', 'utf-8'),
      mimeType: 'application/pdf',
    });
    expect(cleanResult.medicines.length).toBeGreaterThan(0);
    expect(cleanResult.medicines[0]!.name_as_written).toBe('Glycomet 500 SR');

    const uncertainProvider = new MockPrescriptionExtractionProvider({ mode: 'UNCERTAIN' });
    const uncertainResult = await uncertainProvider.extractPrescription({
      documentBuffer: Buffer.from('%PDF-1.4 test', 'utf-8'),
      mimeType: 'application/pdf',
    });
    expect(uncertainResult.medicines.some((m) => m.confidence === 'UNCERTAIN')).toBe(true);

    const missingDateProvider = new MockPrescriptionExtractionProvider({ mode: 'MISSING_DATE' });
    const missingDateResult = await missingDateProvider.extractPrescription({
      documentBuffer: Buffer.from('%PDF-1.4 test', 'utf-8'),
      mimeType: 'application/pdf',
    });
    expect(missingDateResult.date_is_uncertain).toBe(true);
    expect(missingDateResult.prescription_date).toBeUndefined();
  });
});
