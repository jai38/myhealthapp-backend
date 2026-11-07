/**
 * Handwritten prescription templates. Each one is a single fictional prescription: the seed stores
 * exactly this content as the confirmed record, and docs/dev-data/handwritten-prescription-prompts.md
 * (built from this file by `npm run seed:prompts`) asks an image model to draw the same content.
 * After the owner generates the images, `npm run seed:attach-images` swaps them in for the
 * placeholders, so the picture a tester opens matches the record beside it.
 *
 * Every name, clinic and registration number here is invented.
 */

export interface HandwrittenLine {
  /** Catalog key (catalog.ts). */
  med: string;
  /** Exactly what is written on the paper for this line. */
  written: string;
  frequency: string;
  duration: string;
  instructions?: string;
  /** The line is hard to read: extraction should flag it, and the record keeps it uncertain. */
  uncertain?: boolean;
}

export interface HandwrittenTemplate {
  id: string;
  scenario: string;
  /** What this image tests in the app or in extraction. */
  tests: string;
  doctor: string | null;
  clinic: string | null;
  /** Printed letterhead, rubber stamp, or neither (plain paper / OPD slip). */
  header: 'letterhead' | 'stamp' | 'opd-slip' | 'plain';
  /** The date exactly as handwritten, or null when the paper has no date. */
  dateWritten: string | null;
  /** The true date in ISO form, or null when it cannot be known. */
  dateIso: string | null;
  dateUncertain: boolean;
  patientLine: string;
  diagnosisWritten: string | null;
  diagnosis: string | null;
  lines: readonly HandwrittenLine[];
  advice?: string;
  /** Handwriting and paper. */
  look: string;
  /** How the phone photo was taken. */
  capture: string;
  pages?: number;
}

export const HANDWRITTEN_TEMPLATES: readonly HandwrittenTemplate[] = [
  {
    id: 'HW-01', scenario: 'Clean, neat GP prescription', tests: 'Happy path: every field readable, three common medicines.',
    doctor: 'Dr. R. K. Sharma, MBBS, MD (Med)', clinic: 'City Care Clinic, Bengaluru', header: 'letterhead',
    dateWritten: '14/10/2026', dateIso: '2026-10-14', dateUncertain: false,
    patientLine: 'Mr. Rahul Verma  34/M', diagnosisWritten: 'Viral fever', diagnosis: 'Viral fever',
    lines: [
      { med: 'dolo650', written: 'Tab. Dolo 650', frequency: '1-1-1', duration: '3 days', instructions: 'after food' },
      { med: 'cetzine', written: 'Tab. Cetzine 10mg', frequency: '0-0-1', duration: '5 days' },
      { med: 'becosules', written: 'Cap. Becosules Z', frequency: '1-0-0', duration: '15 days' },
    ],
    advice: 'Plenty of fluids. Review if fever > 3 days.',
    look: 'Neat, upright blue ballpoint handwriting on a white A5 letterhead pad.',
    capture: 'Phone photo, flat on a wooden table, good daylight, slight shadow of the phone at the bottom.',
  },
  {
    id: 'HW-02', scenario: 'Classic doctor cursive', tests: 'Extraction under heavy cursive; at least one medicine should be flagged uncertain.',
    doctor: 'Dr. B. N. Ghosh, MBBS, MD', clinic: 'Ghosh Clinic, Salt Lake', header: 'letterhead',
    dateWritten: '3.9.26', dateIso: '2026-09-03', dateUncertain: false,
    patientLine: 'Smt. Rekha Das  52/F', diagnosisWritten: 'URTI', diagnosis: 'URTI',
    lines: [
      { med: 'azithral', written: 'Azithral 500', frequency: '1-0-0', duration: '3d', instructions: '1 hr before food' },
      { med: 'montairlc', written: 'Montair LC', frequency: '0-0-1', duration: '10d' },
      { med: 'ascorills', written: 'Ascoril LS syp', frequency: '10ml TDS', duration: '5d', uncertain: true },
    ],
    look: 'Fast, slanted, joined-up black ink cursive typical of a busy OPD; letters run together, the third line is barely legible.',
    capture: 'Handheld phone photo at a slight angle, indoor tube-light, faint glare at the top right.',
  },
  {
    id: 'HW-03', scenario: 'No date anywhere', tests: 'Missing date: record keeps date unknown and flags it; timeline must not invent one.',
    doctor: 'Dr. M. A. Qureshi, MBBS', clinic: 'Qureshi Dawakhana', header: 'stamp',
    dateWritten: null, dateIso: null, dateUncertain: true,
    patientLine: 'Farhan  28 yrs', diagnosisWritten: 'Acute gastroenteritis', diagnosis: 'Acute gastroenteritis',
    lines: [
      { med: 'norfloxtz', written: 'Tab Norflox-TZ', frequency: '1-0-1', duration: '5 days' },
      { med: 'electral', written: 'ORS', frequency: 'after each loose motion', duration: 'till better' },
      { med: 'ondem', written: 'Tab Ondem 4mg', frequency: 'SOS', duration: '3 days', instructions: 'for vomiting' },
    ],
    look: 'Plain white paper with a purple rubber stamp of the clinic name; blue ink; no date field filled.',
    capture: 'Photo on a bedsheet, warm yellow bulb light, paper slightly curled.',
  },
  {
    id: 'HW-04', scenario: 'Ambiguous date order', tests: 'Day-month vs month-day: 04/07/25 could be 4 July or 7 April; must be flagged uncertain.',
    doctor: 'Dr. Priya Nair, MBBS, DCH', clinic: 'Sunrise Children Hospital, Kochi', header: 'letterhead',
    dateWritten: '04/07/25', dateIso: '2025-07-04', dateUncertain: true,
    patientLine: 'Baby Aadhya Menon  3 yrs / 13 kg', diagnosisWritten: 'Fever with cold', diagnosis: 'Fever with cold',
    lines: [
      { med: 'calpol', written: 'Calpol (250) syp', frequency: '5 ml 6 hrly', duration: 'SOS fever', instructions: 'only if temp > 100' },
      { med: 'septilin', written: 'Septilin syp', frequency: '2.5 ml BD', duration: '15 days' },
    ],
    look: 'Paediatric letterhead with a small cartoon logo; neat but small handwriting in blue; weight written next to the name.',
    capture: 'Top-down photo, good light, a child\'s toy partly visible at one edge.',
  },
  {
    id: 'HW-05', scenario: 'Long chronic list, elderly', tests: 'Many medicines on one page (8 lines), chronic refills, insulin units, a weekly-only medicine.',
    doctor: 'Dr. Harleen Kaur, MD (Endo)', clinic: 'Fortis OPD, Mohali', header: 'letterhead',
    dateWritten: '21-08-2026', dateIso: '2026-08-21', dateUncertain: false,
    patientLine: 'Sardar Gurpreet Singh  78/M', diagnosisWritten: 'T2DM, HTN, CAD, Hypothyroid', diagnosis: 'Type 2 diabetes, hypertension, CAD, hypothyroidism',
    lines: [
      { med: 'glycometgp', written: 'Glycomet GP1', frequency: '1-0-1', duration: 'cont.' },
      { med: 'lantus', written: 'Inj Lantus', frequency: '14 U at bedtime', duration: 'cont.' },
      { med: 'telma40', written: 'Telma 40', frequency: '1-0-0', duration: 'cont.' },
      { med: 'ecosprin', written: 'Ecosprin 75', frequency: '0-1-0', duration: 'cont.' },
      { med: 'atorva', written: 'Atorva 20', frequency: '0-0-1', duration: 'cont.' },
      { med: 'thyronorm75', written: 'Thyronorm 75mcg', frequency: '1-0-0 empty stomach', duration: 'cont.' },
      { med: 'uprised3', written: 'Uprise D3 60K', frequency: 'once a week', duration: '8 weeks' },
      { med: 'shelcal', written: 'Shelcal 500', frequency: '0-1-0', duration: '3 months' },
    ],
    advice: 'FBS/PPBS, HbA1c after 3 months. Next visit with reports.',
    look: 'Hospital letterhead, two columns; tidy but compressed blue handwriting to fit 8 lines; ticks beside some lines.',
    capture: 'Scanned-looking photo, slightly overexposed, top edge cut off a little.',
  },
  {
    id: 'HW-06', scenario: 'Steroid taper', tests: 'One medicine whose dose changes over time; must not become a simple daily reminder.',
    doctor: 'Dr. Lata Kulkarni, MD (Chest)', clinic: 'Ruby Hall Clinic, Pune', header: 'letterhead',
    dateWritten: '2/11/2026', dateIso: '2026-11-02', dateUncertain: false,
    patientLine: 'Ms. Sneha Kulkarni  41/F', diagnosisWritten: 'Acute exacerbation of asthma', diagnosis: 'Asthma exacerbation',
    lines: [
      { med: 'wysolone', written: 'Tab Wysolone 20', frequency: '2-0-0 x5d, 1½-0-0 x5d, 1-0-0 x5d, ½-0-0 x5d', duration: '20 days', instructions: 'after breakfast' },
      { med: 'foracort', written: 'Foracort 200 inhaler', frequency: '2 puffs BD', duration: 'cont.', instructions: 'rinse mouth' },
      { med: 'asthalin', written: 'Asthalin inh', frequency: '2 puffs SOS', duration: 'SOS' },
    ],
    look: 'Blue ink; the taper is written as a small staircase diagram with arrows; one word crossed out and rewritten.',
    capture: 'Phone photo held in hand, thumb visible at the edge, mild motion blur.',
  },
  {
    id: 'HW-07', scenario: 'Hindi and English mixed', tests: 'Devanagari instructions next to English medicine names; names must be kept as written.',
    doctor: 'Dr. Ramesh', clinic: 'Shree Sai Polyclinic, Indore', header: 'stamp',
    dateWritten: '१२/६/२०२४ (12/6/2024)', dateIso: '2024-06-12', dateUncertain: false,
    patientLine: 'श्रीमती कमला देवी  65 वर्ष', diagnosisWritten: 'जोड़ों में दर्द (joint pain)', diagnosis: 'Joint pain',
    lines: [
      { med: 'zerodolsp', written: 'Zerodol-SP', frequency: '1-0-1', duration: '5 दिन', instructions: 'खाने के बाद' },
      { med: 'pan40', written: 'Pan 40', frequency: '1-0-0', duration: '5 दिन', instructions: 'खाली पेट' },
      { med: 'shelcal', written: 'Shelcal', frequency: '0-1-0', duration: '1 माह' },
    ],
    look: 'Plain paper with a blue stamp; instructions in Hindi (Devanagari), medicine names in English capitals.',
    capture: 'Photo on a steel plate tray, harsh overhead light, small water stain on the paper.',
  },
  {
    id: 'HW-08', scenario: 'Partly illegible line', tests: 'A medicine name nobody can read: normalized name must stay empty, never guessed.',
    doctor: 'Dr. S.K.', clinic: null, header: 'plain',
    dateWritten: '9/1/23', dateIso: '2023-01-09', dateUncertain: false,
    patientLine: 'Mohd. Imran  45', diagnosisWritten: 'c/o cough 1 wk', diagnosis: 'Cough for one week',
    lines: [
      { med: 'unknownsyp', written: 'Syp. ??? (illegible) 5ml', frequency: 'TDS', duration: '?', uncertain: true },
      { med: 'cetzine', written: 'Tab Cetzine', frequency: 'HS', duration: '5 days' },
    ],
    look: 'Torn half-sheet of a notepad, pencil, first medicine name is a scribble that cannot be read.',
    capture: 'Low-light phone photo, grainy, slightly out of focus.',
  },
  {
    id: 'HW-09', scenario: 'Eye clinic drops, both eyes', tests: 'Ophthalmic route, per-eye directions (RE/LE/BE), frequent drops.',
    doctor: 'Dr. Kavita Rao, MS (Ophth)', clinic: 'Lotus Eye Care, Chennai', header: 'letterhead',
    dateWritten: '29 Feb 2024', dateIso: '2024-02-29', dateUncertain: false,
    patientLine: 'Mr. Venkatesh Pillai  59/M', diagnosisWritten: 'Bacterial conjunctivitis BE', diagnosis: 'Bacterial conjunctivitis, both eyes',
    lines: [
      { med: 'moxicip', written: 'Moxicip e/d', frequency: '1 drop 4 times BE', duration: '7 days' },
      { med: 'refresh', written: 'Refresh Tears', frequency: '1 drop 6 times BE', duration: '1 month' },
    ],
    look: 'Eye-hospital letterhead with an eye diagram where the doctor marked both eyes; neat blue handwriting.',
    capture: 'Bright photo, slight perspective skew.',
  },
  {
    id: 'HW-10', scenario: 'Hospital discharge summary, two pages', tests: 'Multi-page document; IV and IM medicines given in hospital vs medicines to take home.',
    doctor: 'Dr. S. Venkataraman, MD, DM (Cardio)', clinic: 'Manipal Hospital, Old Airport Road', header: 'letterhead',
    dateWritten: 'DOA 12/03/2025  DOD 18/03/2025', dateIso: '2025-03-18', dateUncertain: false,
    patientLine: 'Mr. Ashok Rao  67/M  IP No. SAMPLE-0001', diagnosisWritten: 'NSTEMI, s/p PTCA to LAD', diagnosis: 'NSTEMI, after PTCA to LAD',
    lines: [
      { med: 'ecosprin', written: 'Tab Ecosprin 75', frequency: '0-1-0', duration: 'lifelong' },
      { med: 'clopilet', written: 'Tab Clopilet 75', frequency: '0-1-0', duration: '1 year' },
      { med: 'atorva', written: 'Tab Atorva 40', frequency: '0-0-1', duration: 'cont.' },
      { med: 'metolar', written: 'Tab Metolar XR 25', frequency: '1-0-0', duration: 'cont.' },
      { med: 'pan40', written: 'Tab Pan 40', frequency: '1-0-0', duration: '1 month' },
    ],
    advice: 'Cardiac rehab. Review in cardiology OPD after 1 week. Report chest pain immediately.',
    look: 'Two handwritten pages on hospital discharge forms with printed headings; page 1 history and in-hospital treatment, page 2 discharge medicines.',
    capture: 'Two separate photos (one per page) placed side by side, paper stapled at the corner.',
    pages: 2,
  },
  {
    id: 'HW-11', scenario: 'Old, faded prescription from 2003', tests: 'Very old date, faded ink, old brand (Rantac); timeline far in the past.',
    doctor: 'Dr. Anita Deshmukh, MBBS, DGO', clinic: 'Deshmukh Nursing Home, Nagpur', header: 'letterhead',
    dateWritten: '17-5-2003', dateIso: '2003-05-17', dateUncertain: false,
    patientLine: 'Mrs. Meera Joshi  29/F', diagnosisWritten: 'Acidity', diagnosis: 'Acidity',
    lines: [
      { med: 'rantac', written: 'Tab Rantac 150', frequency: '1-0-1', duration: '7 days' },
      { med: 'becosules', written: 'Cap Becosules', frequency: '1-0-0', duration: '1 month' },
    ],
    look: 'Yellowed paper with brown foxing spots, faded blue fountain-pen ink, folded into four with deep creases.',
    capture: 'Photo of the unfolded paper, creases casting shadows, one corner missing.',
  },
  {
    id: 'HW-12', scenario: 'Doctor wrote a future date', tests: 'Date after today (writing slip); must be flagged, not accepted as fact.',
    doctor: 'Dr. J. Fernandes, MS (Ortho)', clinic: 'Fernandes Ortho Clinic, Panaji', header: 'letterhead',
    dateWritten: '05/01/2027', dateIso: '2027-01-05', dateUncertain: true,
    patientLine: 'Mr. Joseph D\'Souza  47/M', diagnosisWritten: 'Low back pain', diagnosis: 'Low back pain',
    lines: [
      { med: 'zerodolsp', written: 'Zerodol SP', frequency: '1-0-1', duration: '5 days' },
      { med: 'pregabalin', written: 'Pregeb M 75', frequency: '0-0-1', duration: '1 month' },
      { med: 'pan40', written: 'Pan 40', frequency: '1-0-0', duration: '5 days' },
    ],
    look: 'Letterhead with a spine illustration; confident blue handwriting; the year is clearly 2027.',
    capture: 'Good photo, slight rotation.',
  },
  {
    id: 'HW-13', scenario: 'Government hospital OPD slip', tests: 'Tiny slip, printed form fields, generic names only, OPD number.',
    doctor: null, clinic: 'Govt. District Hospital, Nashik', header: 'opd-slip',
    dateWritten: '08/08/2022', dateIso: '2022-08-08', dateUncertain: false,
    patientLine: 'Ganesh Pawar  M/38  OPD No. SAMPLE-4471', diagnosisWritten: 'Fever', diagnosis: 'Fever',
    lines: [
      { med: 'pcm', written: 'T. PCM 500', frequency: '1-1-1', duration: '3 days' },
      { med: 'cetzine', written: 'T. CPM', frequency: '0-0-1', duration: '3 days', uncertain: true },
    ],
    look: 'Small grey recycled-paper OPD slip with printed Marathi and English form headings; doctor name field left blank; dispensary rubber stamp.',
    capture: 'Photo with the slip held between fingers against a dark background.',
  },
  {
    id: 'HW-14', scenario: 'Skin clinic, topical only', tests: 'Creams and ointments: topical route, "apply" frequencies, body-site directions.',
    doctor: 'Dr. Arvind Joshi, MD (Derm)', clinic: 'Kaya Skin Centre, Hyderabad', header: 'letterhead',
    dateWritten: '11/4/2026', dateIso: '2026-04-11', dateUncertain: false,
    patientLine: 'Ms. Ananya Reddy  23/F', diagnosisWritten: 'Tinea corporis', diagnosis: 'Tinea corporis',
    lines: [
      { med: 'luliconazole', written: 'Lulifin oint', frequency: 'LA OD', duration: '4 weeks', instructions: 'on rash + 2 cm around' },
      { med: 'candidb', written: 'Candid-B', frequency: 'LA BD', duration: '2 weeks', instructions: 'not on face' },
      { med: 'cetzine', written: 'Tab Cetzine', frequency: 'HS', duration: '10 days' },
    ],
    look: 'Modern minimalist letterhead, green ink, a small body outline with the rash area shaded.',
    capture: 'Clean, well-lit photo.',
  },
  {
    id: 'HW-15', scenario: 'Weekly methotrexate', tests: 'A weekly-only medicine next to daily ones; must never be scheduled daily.',
    doctor: 'Dr. T. Reddy, DM (Rheum)', clinic: 'Medanta, Gurugram', header: 'letterhead',
    dateWritten: '19.10.2026', dateIso: '2026-10-19', dateUncertain: false,
    patientLine: 'Mrs. Lakshmi Iyer  56/F', diagnosisWritten: 'Rheumatoid arthritis', diagnosis: 'Rheumatoid arthritis',
    lines: [
      { med: 'folitrax', written: 'Tab Folitrax 7.5', frequency: 'ONCE A WEEK - SUNDAY only', duration: 'cont.', instructions: 'NOT DAILY' },
      { med: 'folvite', written: 'Tab Folvite 5mg', frequency: 'Monday only', duration: 'cont.' },
      { med: 'hcqs', written: 'Tab HCQS 200', frequency: '1-0-1', duration: 'cont.' },
    ],
    look: 'Blue ink; the word WEEKLY underlined twice and boxed; neat handwriting.',
    capture: 'Photo with a pill strip lying on the paper, partly covering the bottom margin.',
  },
  {
    id: 'HW-16', scenario: 'Pregnancy (antenatal) visit', tests: 'Pregnancy context for later safety checks; vaginal route; "till 12 weeks" durations.',
    doctor: 'Dr. Anita Deshmukh, MBBS, DGO', clinic: 'Deshmukh Nursing Home, Nagpur', header: 'letterhead',
    dateWritten: '01-09-2026', dateIso: '2026-09-01', dateUncertain: false,
    patientLine: 'Mrs. Pooja Shah  29/F  G2P1, 8 wks', diagnosisWritten: 'Early pregnancy, threatened miscarriage', diagnosis: 'Early pregnancy',
    lines: [
      { med: 'susten', written: 'Susten 200', frequency: '0-0-1 PV', duration: 'till 12 wks' },
      { med: 'duphaston', written: 'Duphaston', frequency: '1-0-1', duration: 'till 12 wks' },
      { med: 'folvite', written: 'Folvite 5', frequency: '1-0-0', duration: '3 months' },
    ],
    advice: 'Bed rest. USG after 2 weeks.',
    look: 'Letterhead with a mother-and-child logo; blue ink.',
    capture: 'Photo with the paper on a hospital file folder.',
  },
  {
    id: 'HW-17', scenario: 'Crossed-out and corrected dose', tests: 'A dose changed by hand on the same page; the final dose must win.',
    doctor: 'Dr. Neha Agarwal, MD (Psych)', clinic: 'Mind Matters Clinic, Saket', header: 'letterhead',
    dateWritten: '07/07/2026', dateIso: '2026-07-07', dateUncertain: false,
    patientLine: 'Mr. Tarun Malhotra  31/M', diagnosisWritten: 'GAD', diagnosis: 'Generalised anxiety disorder',
    lines: [
      { med: 'nexito', written: 'Tab Nexito 10 (5 struck through)', frequency: '0-0-1', duration: '3 months' },
      { med: 'lonazep', written: 'Tab Lonazep 0.25', frequency: 'SOS, max 1/day', duration: '2 weeks' },
    ],
    look: 'The strength "5" is crossed out and "10" written above with the doctor\'s initials beside it.',
    capture: 'Photo under a desk lamp, warm tint.',
  },
  {
    id: 'HW-18', scenario: 'Carbon copy, very faint', tests: 'Low-contrast carbon-copy text; extraction may fail or flag everything.',
    doctor: 'Dr. P. Subramanian, MS (ENT)', clinic: 'Subramanian ENT Clinic, Madurai', header: 'letterhead',
    dateWritten: '22/12/2019', dateIso: '2019-12-22', dateUncertain: false,
    patientLine: 'Revathi S.  44/F', diagnosisWritten: 'Otitis externa LE', diagnosis: 'Otitis externa, left ear',
    lines: [
      { med: 'ciplox', written: 'Ciplox-D ear drops', frequency: '3 drops TDS LE', duration: '7 days', uncertain: true },
      { med: 'combiflam', written: 'Combiflam', frequency: 'SOS', duration: '3 days', uncertain: true },
    ],
    look: 'Thin pink carbon-copy paper; the writing is a faint blue-purple impression with smudges.',
    capture: 'Photo on a white surface, slightly blurred.',
  },
  {
    id: 'HW-19', scenario: 'Very short, two words', tests: 'Minimum content: one medicine, no diagnosis, no clinic.',
    doctor: null, clinic: null, header: 'plain',
    dateWritten: '2/2/21', dateIso: '2021-02-02', dateUncertain: false,
    patientLine: 'Arjun', diagnosisWritten: null, diagnosis: null,
    lines: [
      { med: 'fluconazole', written: 'Forcan 150 stat', frequency: 'stat', duration: 'single dose' },
    ],
    look: 'Back of a pharmacy bill; two lines of black ink.',
    capture: 'Quick, slightly tilted photo.',
  },
  {
    id: 'HW-20', scenario: 'Insulin and injection chart', tests: 'Sliding-scale style units and mixed insulin; units not milligrams.',
    doctor: 'Dr. Harleen Kaur, MD (Endo)', clinic: 'Fortis OPD, Mohali', header: 'letterhead',
    dateWritten: '15/05/2026', dateIso: '2026-05-15', dateUncertain: false,
    patientLine: 'Mr. Sanjay Gupta  61/M', diagnosisWritten: 'Uncontrolled T2DM', diagnosis: 'Uncontrolled type 2 diabetes',
    lines: [
      { med: 'mixtard', written: 'Inj Human Mixtard 30/70', frequency: '18 U before breakfast, 10 U before dinner', duration: 'cont.' },
      { med: 'glycomet', written: 'Glycomet 500', frequency: '1-0-1', duration: 'cont.' },
    ],
    advice: 'Check sugar before each insulin dose. If < 70, take 3 glucose tablets.',
    look: 'Letterhead with a hand-drawn table: columns Breakfast / Lunch / Dinner with unit numbers.',
    capture: 'Photo with a glucometer lying beside the paper.',
  },
];

export const TEMPLATE_BY_ID: ReadonlyMap<string, HandwrittenTemplate> = new Map(HANDWRITTEN_TEMPLATES.map((t) => [t.id, t]));
