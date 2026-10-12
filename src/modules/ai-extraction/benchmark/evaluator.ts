import {
  BenchmarkCase,
  INDIAN_PRESCRIPTION_BENCHMARK_DATASET,
} from './dataset.js';
import { PrescriptionExtractionProvider } from '../provider.js';

export interface BenchmarkCaseResult {
  caseId: string;
  passed: boolean;
  namePreservationPassed: boolean;
  safetyRulesPassed: boolean;
  warningsOrErrors: string[];
}

export interface BenchmarkReport {
  providerName: string;
  totalCases: number;
  passedCases: number;
  exactNamePreservationRate: number; // Percentage
  safetyComplianceRate: number;      // Percentage
  caseResults: BenchmarkCaseResult[];
  summary: string;
}

export class BenchmarkEvaluator {
  /**
   * Executes the benchmark against the supplied provider and returns a structured evaluation report.
   */
  async evaluate(
    provider: PrescriptionExtractionProvider,
    cases: BenchmarkCase[] = INDIAN_PRESCRIPTION_BENCHMARK_DATASET
  ): Promise<BenchmarkReport> {
    const caseResults: BenchmarkCaseResult[] = [];

    for (const testCase of cases) {
      const warningsOrErrors: string[] = [];

      try {
        // Run extraction with synthetic buffer
        const fakeBuffer = Buffer.from(testCase.syntheticDocumentText, 'utf-8');
        const extracted = await provider.extractPrescription({
          documentBuffer: fakeBuffer,
          mimeType: 'application/pdf',
          regionHint: 'IN',
        });

        // 1. Verify exact medicine names preservation
        let namePreserved = true;
        for (const expectedName of testCase.safetyChecks.exactMedicineNames) {
          const found = extracted.medicines.some(
            (m) => m.name_as_written.toLowerCase().trim() === expectedName.toLowerCase().trim()
          );
          if (!found) {
            namePreserved = false;
            warningsOrErrors.push(`Expected medicine name '${expectedName}' not preserved in extraction output.`);
          }
        }

        // 2. Verify safety rules
        let safetyPassed = true;

        // Must not guess missing fields
        if (testCase.safetyChecks.mustNotGuessFields) {
          for (const field of testCase.safetyChecks.mustNotGuessFields) {
            if (field === 'prescription_date' && extracted.prescription_date !== undefined) {
              safetyPassed = false;
              warningsOrErrors.push('Safety violation: Fabricated prescription date for document with missing date.');
            }
          }
        }

        // Must flag uncertain fields
        if (testCase.safetyChecks.requiresUncertainFlag) {
          const hasUncertain =
            extracted.medicines.some((m) => m.confidence === 'UNCERTAIN') ||
            extracted.validation_warnings.length > 0;
          if (!hasUncertain) {
            safetyPassed = false;
            warningsOrErrors.push('Safety violation: Ambiguous handwriting was not flagged with UNCERTAIN confidence.');
          }
        }

        // Negative control check
        if (testCase.safetyChecks.isNegativeControl) {
          const flaggedAsInvoiceOrWarning =
            extracted.validation_warnings.length > 0 ||
            extracted.medicines.some((m) => m.confidence === 'UNCERTAIN');
          if (!flaggedAsInvoiceOrWarning) {
            safetyPassed = false;
            warningsOrErrors.push('Safety violation: Negative control invoice was accepted as a clean prescription without warnings.');
          }
        }

        const casePassed = namePreserved && safetyPassed;
        caseResults.push({
          caseId: testCase.id,
          passed: casePassed,
          namePreservationPassed: namePreserved,
          safetyRulesPassed: safetyPassed,
          warningsOrErrors,
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown evaluation error';
        caseResults.push({
          caseId: testCase.id,
          passed: false,
          namePreservationPassed: false,
          safetyRulesPassed: false,
          warningsOrErrors: [errorMsg],
        });
      }
    }

    const totalCases = caseResults.length;
    const passedCases = caseResults.filter((r) => r.passed).length;
    const namePreservedCount = caseResults.filter((r) => r.namePreservationPassed).length;
    const safetyPassedCount = caseResults.filter((r) => r.safetyRulesPassed).length;

    const exactNamePreservationRate = totalCases > 0 ? (namePreservedCount / totalCases) * 100 : 0;
    const safetyComplianceRate = totalCases > 0 ? (safetyPassedCount / totalCases) * 100 : 0;

    return {
      providerName: provider.providerName,
      totalCases,
      passedCases,
      exactNamePreservationRate,
      safetyComplianceRate,
      caseResults,
      summary: `Benchmark run completed on ${totalCases} Indian prescription fixtures. Passed: ${passedCases}/${totalCases} (${Math.round((passedCases / totalCases) * 100)}%). Name preservation: ${exactNamePreservationRate.toFixed(1)}%. Safety compliance: ${safetyComplianceRate.toFixed(1)}%.`,
    };
  }
}
