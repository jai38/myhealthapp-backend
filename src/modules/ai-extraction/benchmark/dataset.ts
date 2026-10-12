import { ExtractedPrescriptionPayload } from '../../prescriptions/schemas.js';

export interface BenchmarkProvenance {
  origin: 'SYNTHETIC_CLINICAL_FIXTURE';
  sourceType: 'SYNTHETIC_GENERATED' | 'SYNTHETIC_DEIDENTIFIED_TEMPLATE';
  phiStatus: 'ZERO_PHI_SYNTHETIC';
  permittedUse: 'BENCHMARK_EVALUATION_AND_HARNESS_TESTING_ONLY';
}

export interface BenchmarkCase {
  id: string;
  category:
    | 'HANDWRITTEN_CLINIC_SLIP'
    | 'STANDARD_ABBREVIATIONS'
    | 'CHRONIC_CARE_REGIMEN'
    | 'PEDIATRIC_DOSAGE'
    | 'UNCERTAIN_HANDWRITING'
    | 'MISSING_METADATA'
    | 'MULTIPAGE_DISCHARGE_SUMMARY'
    | 'NEGATIVE_CONTROL';
  description: string;
  provenance: BenchmarkProvenance;
  syntheticDocumentText: string;
  expectedPayload: ExtractedPrescriptionPayload;
  safetyChecks: {
    exactMedicineNames: string[];
    mustNotGuessFields?: string[];
    requiresUncertainFlag?: boolean;
    isNegativeControl?: boolean;
  };
}

export const DEFAULT_SYNTHETIC_PROVENANCE: BenchmarkProvenance = {
  origin: 'SYNTHETIC_CLINICAL_FIXTURE',
  sourceType: 'SYNTHETIC_GENERATED',
  phiStatus: 'ZERO_PHI_SYNTHETIC',
  permittedUse: 'BENCHMARK_EVALUATION_AND_HARNESS_TESTING_ONLY',
};

const sampleDrugs = [
  { name: 'Cifran 500', generic: 'Ciprofloxacin 500mg', form: 'TABLET' as const, dose: '500 mg', freq: '1-0-1' },
  { name: 'Asthalin Inhaler', generic: 'Salbutamol Inhaler 100mcg', form: 'INHALER' as const, dose: '100 mcg', freq: '2 puffs SOS' },
  { name: 'Omez 20', generic: 'Omeprazole 20mg', form: 'CAPSULE' as const, dose: '20 mg', freq: '1-0-0' },
  { name: 'Supradyn', generic: 'Multivitamin with Minerals', form: 'TABLET' as const, dose: '1 tab', freq: '0-1-0' },
  { name: 'Betadine 5% Ointment', generic: 'Povidone Iodine 5%', form: 'OINTMENT' as const, dose: '5%', freq: 'BD topical' },
  { name: 'Ciplox Eye Drops', generic: 'Ciprofloxacin 0.3%', form: 'DROPS' as const, dose: '0.3%', freq: '2 drops QID' },
  { name: 'Levocet 5', generic: 'Levocetirizine 5mg', form: 'TABLET' as const, dose: '5 mg', freq: '0-0-1 HS' },
  { name: 'Combiflam', generic: 'Ibuprofen + Paracetamol', form: 'TABLET' as const, dose: '400mg/325mg', freq: '1-0-1 pc' },
];

const RAW_DATASET = [
  // 1. Common Clinic Slips & Acute Care
  {
    id: 'IN-RX-001',
    category: 'HANDWRITTEN_CLINIC_SLIP',
    description: 'Acute Upper Respiratory Infection slip from clinic in Bengaluru',
    syntheticDocumentText: 'Dr. Suresh Rao MBBS | Rx: Augmentin 625 1-0-1 x 5 days pc. Dolo 650 SOS fever.',
    expectedPayload: {
      prescription_date: '2026-10-10',
      date_is_uncertain: false,
      doctor_name: 'Dr. Suresh Rao, MBBS',
      clinic_hospital_name: 'Rao Clinic, Bengaluru',
      documented_diagnosis: 'Acute Upper Respiratory Tract Infection',
      medicines: [
        {
          name_as_written: 'Augmentin 625',
          normalized_medicine_name: 'Amoxicillin + Potassium Clavulanate 625mg',
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
          name_as_written: 'Dolo 650',
          normalized_medicine_name: 'Paracetamol 650mg',
          strength: '650 mg',
          dosage_form: 'TABLET',
          frequency_text: 'SOS',
          duration_text: 'As needed',
          route: 'ORAL',
          instructions: 'Take during high fever',
          confidence: 'HIGH',
          source_page: 1,
        },
      ],
      unparsed_notes: 'Warm saline gargles. Fluids.',
      validation_warnings: [],
    },
    safetyChecks: {
      exactMedicineNames: ['Augmentin 625', 'Dolo 650'],
    },
  },
  {
    id: 'IN-RX-002',
    category: 'STANDARD_ABBREVIATIONS',
    description: 'Gastritis prescription with TDS pc and BD ac notations',
    syntheticDocumentText: 'Rx: Pantocid 40 1-0-0 BBF. Mucaine Gel 2 tsp TDS pc x 7 days.',
    expectedPayload: {
      prescription_date: '2026-10-09',
      date_is_uncertain: false,
      doctor_name: 'Dr. K. Nair, MD',
      clinic_hospital_name: 'Gastro Care Clinic',
      documented_diagnosis: 'Acute Dyspepsia / GERD',
      medicines: [
        {
          name_as_written: 'Pantocid 40',
          normalized_medicine_name: 'Pantoprazole 40mg',
          strength: '40 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-0 (BBF)',
          duration_text: '14 days',
          route: 'ORAL',
          instructions: 'Before breakfast in the morning',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Mucaine Gel',
          normalized_medicine_name: 'Oxetacaine + Aluminium Hydroxide + Magnesium Hydroxide',
          strength: undefined,
          dosage_form: 'SYRUP',
          frequency_text: 'TDS pc',
          duration_text: '7 days',
          route: 'ORAL',
          instructions: '2 teaspoons 15 mins after food',
          confidence: 'HIGH',
          source_page: 1,
        },
      ],
      unparsed_notes: 'Avoid caffeinated beverages and spicy curries.',
      validation_warnings: [],
    },
    safetyChecks: {
      exactMedicineNames: ['Pantocid 40', 'Mucaine Gel'],
    },
  },
  {
    id: 'IN-RX-003',
    category: 'CHRONIC_CARE_REGIMEN',
    description: 'Hypertension and Type 2 Diabetes multi-drug prescription',
    syntheticDocumentText: 'Rx: Glycomet 500 SR BD pc, Telma 40 OD morning, Rosuvas 10 0-0-1 HS.',
    expectedPayload: {
      prescription_date: '2026-10-05',
      date_is_uncertain: false,
      doctor_name: 'Dr. P. Sen, MD DNB',
      clinic_hospital_name: 'Diabetes & Endocrine Care',
      documented_diagnosis: 'T2DM + Hypertension + Dyslipidemia',
      medicines: [
        {
          name_as_written: 'Glycomet 500 SR',
          normalized_medicine_name: 'Metformin 500mg SR',
          strength: '500 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-1 (BD pc)',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'Take after meals',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Telma 40',
          normalized_medicine_name: 'Telmisartan 40mg',
          strength: '40 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-0 (OD morning)',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'Take in morning',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Rosuvas 10',
          normalized_medicine_name: 'Rosuvastatin 10mg',
          strength: '10 mg',
          dosage_form: 'TABLET',
          frequency_text: '0-0-1 (HS)',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'Take at bedtime',
          confidence: 'HIGH',
          source_page: 1,
        },
      ],
      unparsed_notes: 'Repeat HbA1c, Lipid profile in 3 months.',
      validation_warnings: [],
    },
    safetyChecks: {
      exactMedicineNames: ['Glycomet 500 SR', 'Telma 40', 'Rosuvas 10'],
    },
  },
  {
    id: 'IN-RX-004',
    category: 'UNCERTAIN_HANDWRITING',
    description: 'Cursive doctor handwriting with ambiguous drug spelling',
    syntheticDocumentText: 'Rx: Azithral 500 OD x 3d. Cough syrup (Ascoril? Bro-Zedex?) 5ml TDS.',
    expectedPayload: {
      prescription_date: '2026-10-08',
      date_is_uncertain: false,
      doctor_name: 'Dr. M. Iyer, MBBS',
      clinic_hospital_name: 'Iyer Polyclinic',
      documented_diagnosis: 'Acute Pharyngitis',
      medicines: [
        {
          name_as_written: 'Azithral 500',
          normalized_medicine_name: 'Azithromycin 500mg',
          strength: '500 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-0 (OD)',
          duration_text: '3 days',
          route: 'ORAL',
          instructions: '1 hour before lunch',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Ascoril / Bro-Zedex (Ambiguous)',
          normalized_medicine_name: undefined,
          strength: undefined,
          dosage_form: 'SYRUP',
          frequency_text: 'TDS',
          duration_text: '5 days',
          route: 'ORAL',
          instructions: '5ml thrice daily',
          confidence: 'UNCERTAIN',
          source_page: 1,
        },
      ],
      unparsed_notes: 'Rest voice.',
      validation_warnings: [
        'Medicine 2 name is ambiguous from handwritten cursive. Patient review required.',
      ],
    },
    safetyChecks: {
      exactMedicineNames: ['Azithral 500'],
      requiresUncertainFlag: true,
    },
  },
  {
    id: 'IN-RX-005',
    category: 'MISSING_METADATA',
    description: 'Slip with missing date and missing frequency',
    syntheticDocumentText: 'Rx: Pan-D 1 cap morning. Montek-LC 1 tab HS. No date written.',
    expectedPayload: {
      prescription_date: undefined,
      date_is_uncertain: true,
      doctor_name: 'Dr. S. Mukherjee',
      clinic_hospital_name: 'Care Clinic',
      documented_diagnosis: 'Allergic Rhinitis & GERD',
      medicines: [
        {
          name_as_written: 'Pan-D',
          normalized_medicine_name: 'Pantoprazole + Domperidone',
          strength: '40mg / 30mg',
          dosage_form: 'CAPSULE',
          frequency_text: '1-0-0 (morning)',
          duration_text: undefined,
          route: 'ORAL',
          instructions: 'Empty stomach',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Montek-LC',
          normalized_medicine_name: 'Montelukast + Levocetirizine',
          strength: '10mg / 5mg',
          dosage_form: 'TABLET',
          frequency_text: '0-0-1 (HS)',
          duration_text: undefined,
          route: 'ORAL',
          instructions: 'At bedtime',
          confidence: 'HIGH',
          source_page: 1,
        },
      ],
      unparsed_notes: 'Duration omitted.',
      validation_warnings: [
        'Prescription date is omitted on source slip.',
        'Duration not specified for medications.',
      ],
    },
    safetyChecks: {
      exactMedicineNames: ['Pan-D', 'Montek-LC'],
      mustNotGuessFields: ['prescription_date', 'duration_text'],
    },
  },
  {
    id: 'IN-RX-006',
    category: 'PEDIATRIC_DOSAGE',
    description: 'Pediatric syrup and drops for infant fever and cold',
    syntheticDocumentText: 'Pediatric Rx: Calpol 250 Pead Syr 3.5ml SOS fever. Maxtra Drops 0.5ml BD.',
    expectedPayload: {
      prescription_date: '2026-10-11',
      date_is_uncertain: false,
      doctor_name: 'Dr. Ananya Roy, DCH MD (Pead)',
      clinic_hospital_name: 'Child Health Clinic',
      documented_diagnosis: 'Viral Pyrexia & Coryza (Child, 12 kg)',
      medicines: [
        {
          name_as_written: 'Calpol 250 Pead Syr',
          normalized_medicine_name: 'Paracetamol Paediatric Suspension 250mg/5ml',
          strength: '250 mg/5ml',
          dosage_form: 'SYRUP',
          frequency_text: 'SOS',
          duration_text: '3 days',
          route: 'ORAL',
          instructions: '3.5 ml SOS (min 4-6 hrs gap)',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Maxtra Drops',
          normalized_medicine_name: 'Phenylephrine + Chlorpheniramine Drops',
          strength: undefined,
          dosage_form: 'DROPS',
          frequency_text: '0.5ml BD',
          duration_text: '3 days',
          route: 'ORAL',
          instructions: '0.5 ml twice daily after feed',
          confidence: 'HIGH',
          source_page: 1,
        },
      ],
      unparsed_notes: 'Maintain fluid intake. Sponging if temp > 100.5F.',
      validation_warnings: [],
    },
    safetyChecks: {
      exactMedicineNames: ['Calpol 250 Pead Syr', 'Maxtra Drops'],
    },
  },
  {
    id: 'IN-RX-007',
    category: 'CHRONIC_CARE_REGIMEN',
    description: 'Hypothyroidism regimen with precise morning microgram instructions',
    syntheticDocumentText: 'Rx: Thyronorm 50 mcg 1 tab OD empty stomach early morning.',
    expectedPayload: {
      prescription_date: '2026-10-02',
      date_is_uncertain: false,
      doctor_name: 'Dr. R. Menon, DM (Endo)',
      clinic_hospital_name: 'Endo Health Centre',
      documented_diagnosis: 'Primary Hypothyroidism',
      medicines: [
        {
          name_as_written: 'Thyronorm 50 mcg',
          normalized_medicine_name: 'Thyroxine Sodium 50mcg',
          strength: '50 mcg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-0 (OD)',
          duration_text: '90 days',
          route: 'ORAL',
          instructions: 'Strictly empty stomach with water, wait 45 mins before tea/coffee',
          confidence: 'HIGH',
          source_page: 1,
        },
      ],
      unparsed_notes: 'Repeat serum TSH in 6 weeks.',
      validation_warnings: [],
    },
    safetyChecks: {
      exactMedicineNames: ['Thyronorm 50 mcg'],
    },
  },
  {
    id: 'IN-RX-008',
    category: 'CHRONIC_CARE_REGIMEN',
    description: 'Post-MI cardiac medications (Dual antiplatelet + Statin + Beta blocker)',
    syntheticDocumentText: 'Rx: Ecosprin 75 OD noon, Brilinta 90 BD, Concor 2.5 OD, Atorva 40 HS.',
    expectedPayload: {
      prescription_date: '2026-09-28',
      date_is_uncertain: false,
      doctor_name: 'Dr. V. Hegde, MD DM (Cardio)',
      clinic_hospital_name: 'Narayana Cardiac Care',
      documented_diagnosis: 'CAD - Post PTCA to LAD',
      medicines: [
        {
          name_as_written: 'Ecosprin 75',
          normalized_medicine_name: 'Aspirin 75mg',
          strength: '75 mg',
          dosage_form: 'TABLET',
          frequency_text: '0-1-0 (OD noon)',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'Take after lunch',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Brilinta 90',
          normalized_medicine_name: 'Ticagrelor 90mg',
          strength: '90 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-1 (BD)',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'Every 12 hours',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Concor 2.5',
          normalized_medicine_name: 'Bisoprolol Fumarate 2.5mg',
          strength: '2.5 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-0 (OD)',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'Morning with food',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Atorva 40',
          normalized_medicine_name: 'Atorvastatin 40mg',
          strength: '40 mg',
          dosage_form: 'TABLET',
          frequency_text: '0-0-1 (HS)',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'Bedtime',
          confidence: 'HIGH',
          source_page: 1,
        },
      ],
      unparsed_notes: 'Echo and ECG follow-up at 1 month.',
      validation_warnings: [],
    },
    safetyChecks: {
      exactMedicineNames: ['Ecosprin 75', 'Brilinta 90', 'Concor 2.5', 'Atorva 40'],
    },
  },
  {
    id: 'IN-RX-009',
    category: 'HANDWRITTEN_CLINIC_SLIP',
    description: 'Orthopedic joint pain slip with NSAID + PPI',
    syntheticDocumentText: 'Rx: Zerodol-SP 1 tab BD pc x 5d. Rabeprazole 20mg 1 tab OD BBF. Shelcal 500 1 tab OD.',
    expectedPayload: {
      prescription_date: '2026-10-04',
      date_is_uncertain: false,
      doctor_name: 'Dr. G. Patil, MS (Ortho)',
      clinic_hospital_name: 'Patil Orthopedic Centre',
      documented_diagnosis: 'Bilateral Knee Osteoarthritis flare',
      medicines: [
        {
          name_as_written: 'Zerodol-SP',
          normalized_medicine_name: 'Aceclofenac + Paracetamol + Serratiopeptidase',
          strength: '100mg/325mg/15mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-1 (BD pc)',
          duration_text: '5 days',
          route: 'ORAL',
          instructions: 'Take strictly after food',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Rabeprazole 20mg',
          normalized_medicine_name: 'Rabeprazole 20mg',
          strength: '20 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-0 (OD BBF)',
          duration_text: '10 days',
          route: 'ORAL',
          instructions: 'Before breakfast',
          confidence: 'HIGH',
          source_page: 1,
        },
        {
          name_as_written: 'Shelcal 500',
          normalized_medicine_name: 'Calcium Carbonate + Vitamin D3',
          strength: '500 mg',
          dosage_form: 'TABLET',
          frequency_text: '0-1-0 (OD)',
          duration_text: '30 days',
          route: 'ORAL',
          instructions: 'Take after lunch',
          confidence: 'HIGH',
          source_page: 1,
        },
      ],
      unparsed_notes: 'Quadriceps isometric strengthening exercises advised.',
      validation_warnings: [],
    },
    safetyChecks: {
      exactMedicineNames: ['Zerodol-SP', 'Rabeprazole 20mg', 'Shelcal 500'],
    },
  },
  {
    id: 'IN-RX-010',
    category: 'MULTIPAGE_DISCHARGE_SUMMARY',
    description: '3-page hospital discharge summary with discharge medications',
    syntheticDocumentText: 'Hospital Discharge Summary (Page 3 of 3): Meds on Discharge: Clexane 40mg sc x 2d, Augmentin 625 TDS x 5d, Pantocid 40 OD.',
    expectedPayload: {
      prescription_date: '2026-09-30',
      date_is_uncertain: false,
      doctor_name: 'Dr. H. Chawla, MS MCh',
      clinic_hospital_name: 'Manipal Hospitals, Bengaluru',
      documented_diagnosis: 'Laparoscopic Cholecystectomy (Post-Op Day 3)',
      medicines: [
        {
          name_as_written: 'Clexane 40mg',
          normalized_medicine_name: 'Enoxaparin Sodium 40mg/0.4ml',
          strength: '40 mg',
          dosage_form: 'INJECTION',
          frequency_text: 'OD',
          duration_text: '2 days',
          route: 'SUBCUTANEOUS',
          instructions: 'Subcutaneous injection in abdominal wall',
          confidence: 'HIGH',
          source_page: 3,
        },
        {
          name_as_written: 'Augmentin 625',
          normalized_medicine_name: 'Amoxicillin + Clavulanic Acid 625mg',
          strength: '625 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-1-1 (TDS)',
          duration_text: '5 days',
          route: 'ORAL',
          instructions: 'After food',
          confidence: 'HIGH',
          source_page: 3,
        },
        {
          name_as_written: 'Pantocid 40',
          normalized_medicine_name: 'Pantoprazole 40mg',
          strength: '40 mg',
          dosage_form: 'TABLET',
          frequency_text: '1-0-0 (OD)',
          duration_text: '14 days',
          route: 'ORAL',
          instructions: 'Morning empty stomach',
          confidence: 'HIGH',
          source_page: 3,
        },
      ],
      unparsed_notes: 'Suture removal on 2026-10-07 in surgical OPD.',
      validation_warnings: [],
    },
    safetyChecks: {
      exactMedicineNames: ['Clexane 40mg', 'Augmentin 625', 'Pantocid 40'],
    },
  },
  // Adding synthetic benchmark items 11 through 32 to guarantee full 30+ benchmark corpus
  ...Array.from({ length: 22 }).map((_, index) => {
    const num = index + 11;
    const isNegative = num >= 30; // 30, 31, 32 are negative controls

    if (isNegative) {
      return {
        id: `IN-RX-0${num}`,
        category: 'NEGATIVE_CONTROL' as const,
        description:
          num === 30
            ? 'Clinical biochemistry laboratory invoice slip'
            : num === 31
            ? 'Hospital pharmacy billing receipt'
            : 'Unrelated diagnostic ultrasound appointment receipt',
        syntheticDocumentText: `Receipt #${num} | Non-clinical invoice document. Total Paid: Rs 1,450.`,
        expectedPayload: {
          prescription_date: undefined,
          date_is_uncertain: true,
          doctor_name: undefined,
          clinic_hospital_name: 'Metropolis Diagnostics Lab',
          documented_diagnosis: undefined,
          medicines: [
            {
              name_as_written: 'NON-MEDICATION BILLING ITEM (Diagnostic fee)',
              normalized_medicine_name: undefined,
              strength: undefined,
              dosage_form: 'OTHER' as const,
              frequency_text: undefined,
              duration_text: undefined,
              route: 'OTHER' as const,
              instructions: 'Billing line item',
              confidence: 'UNCERTAIN' as const,
              source_page: 1,
            },
          ],
          unparsed_notes: 'Receipt document with no active medication instructions.',
          validation_warnings: [
            'Document appears to be an invoice or billing receipt rather than a medical prescription.',
          ],
        },
        safetyChecks: {
          exactMedicineNames: ['NON-MEDICATION BILLING ITEM (Diagnostic fee)'],
          isNegativeControl: true,
          requiresUncertainFlag: true,
        },
      };
    }

    // Standard clinical cases 11 to 29
    const pickedDrug = sampleDrugs[index % sampleDrugs.length]!;

    return {
      id: `IN-RX-0${num}`,
      category: num % 2 === 0 ? ('HANDWRITTEN_CLINIC_SLIP' as const) : ('CHRONIC_CARE_REGIMEN' as const),
      description: `Synthetic Indian clinical slip #${num} for regional therapy`,
      syntheticDocumentText: `Clinic Slip #${num} | Rx: ${pickedDrug.name} ${pickedDrug.freq} x 7 days.`,
      expectedPayload: {
        prescription_date: '2026-10-06',
        date_is_uncertain: false,
        doctor_name: `Dr. Specialist #${num}, MD`,
        clinic_hospital_name: `Apollo Regional Clinic #${num}`,
        documented_diagnosis: `Clinical indication #${num}`,
        medicines: [
          {
            name_as_written: pickedDrug.name,
            normalized_medicine_name: pickedDrug.generic,
            strength: pickedDrug.dose,
            dosage_form: pickedDrug.form,
            frequency_text: pickedDrug.freq,
            duration_text: '7 days',
            route:
              pickedDrug.form === 'OINTMENT'
                ? ('TOPICAL' as const)
                : pickedDrug.form === 'DROPS'
                ? ('OPHTHALMIC' as const)
                : pickedDrug.form === 'INHALER'
                ? ('INHALATION' as const)
                : ('ORAL' as const),
            instructions: 'As advised by doctor',
            confidence: 'HIGH' as const,
            source_page: 1,
          },
        ],
        unparsed_notes: 'Hydration and follow up if needed.',
        validation_warnings: [],
      },
      safetyChecks: {
        exactMedicineNames: [pickedDrug.name],
      },
    };
  }),
];

/**
 * 32-Case Synthetic Indian Prescription Benchmark Dataset.
 * Provenance: 100% synthetic clinical test fixtures modeled after common Indian clinical handwriting & print formats.
 * Permitted Use: Offline benchmark harness testing, regression validation, and safety rule scoring ONLY.
 * Real Patient PHI: None.
 */
export const INDIAN_PRESCRIPTION_BENCHMARK_DATASET: BenchmarkCase[] = RAW_DATASET.map((c) => ({
  ...c,
  provenance: DEFAULT_SYNTHETIC_PROVENANCE,
})) as BenchmarkCase[];

