/**
 * Synthetic reference data for the dev seed. Brands are common Indian trade names so the data looks
 * like what testers will photograph; every person, doctor and clinic name is invented.
 * Nothing here is clinical advice, and nothing here is real patient data.
 */

export type DosageForm =
  | 'TABLET' | 'CAPSULE' | 'SYRUP' | 'INJECTION' | 'CREAM' | 'DROPS' | 'INHALER' | 'POWDER' | 'OINTMENT' | 'OTHER';
export type Route =
  | 'ORAL' | 'TOPICAL' | 'INTRAVENOUS' | 'INTRAMUSCULAR' | 'SUBCUTANEOUS' | 'INHALATION' | 'OPHTHALMIC'
  | 'NASAL' | 'OTIC' | 'RECTAL' | 'OTHER';

export interface CatalogMedicine {
  /** Short key used by personas and templates. */
  key: string;
  /** How a doctor typically writes it. */
  written: string;
  /** Generic name, or null where no reliable normalisation exists (Ayurvedic, homeopathic, unclear). */
  generic: string | null;
  strength: string | null;
  form: DosageForm;
  route: Route;
  /** Typical frequency strings as written on Indian prescriptions. */
  frequencies: readonly string[];
  durations: readonly string[];
  instructions: readonly string[];
  /** Long-term medicine: refilled for years. */
  chronic?: boolean;
  /** Needs extra care in later phases (narrow margin, weekly dosing, sedatives). */
  highAlert?: boolean;
  /** Antibiotic family, for allergy-conflict tests in Phase 16. */
  allergyClass?: 'PENICILLIN' | 'SULFA' | 'NSAID' | 'CEPHALOSPORIN' | 'MACROLIDE' | 'FLUOROQUINOLONE';
}

const SHORT = ['3 days', '5 days', '5d', 'x 5 days', '7 days', '1 week', '10 days'] as const;
const LONG = ['1 month', '30 days', '3 months', 'continue', 'Cont.', 'till next visit', 'lifelong'] as const;

export const MEDICINES: readonly CatalogMedicine[] = [
  // Fever, pain, inflammation
  { key: 'dolo650', written: 'Tab. Dolo 650', generic: 'Paracetamol', strength: '650 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-1-1', 'TDS', 'SOS', '1-0-1'], durations: SHORT, instructions: ['After food', 'If fever > 100°F', 'Max 4 tabs/day'] },
  { key: 'crocin', written: 'Crocin Advance', generic: 'Paracetamol', strength: '500 mg', form: 'TABLET', route: 'ORAL', frequencies: ['SOS', '1-0-1'], durations: SHORT, instructions: ['For fever'] },
  { key: 'pcm', written: 'Tab PCM 500', generic: 'Paracetamol', strength: '500 mg', form: 'TABLET', route: 'ORAL', frequencies: ['TDS', 'SOS'], durations: SHORT, instructions: ['After meals'] },
  { key: 'calpol', written: 'Calpol syp', generic: 'Paracetamol', strength: '250 mg/5 ml', form: 'SYRUP', route: 'ORAL', frequencies: ['5 ml TDS', '2.5 ml SOS', '4 ml 6 hourly'], durations: SHORT, instructions: ['Shake well', 'Weight-based dose'] },
  { key: 'combiflam', written: 'Combiflam', generic: 'Ibuprofen + Paracetamol', strength: '400 mg + 325 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1', 'BD'], durations: SHORT, instructions: ['After food'], allergyClass: 'NSAID' },
  { key: 'zerodolsp', written: 'Zerodol-SP', generic: 'Aceclofenac + Paracetamol + Serratiopeptidase', strength: null, form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1'], durations: SHORT, instructions: ['After food'], allergyClass: 'NSAID' },
  { key: 'voveran', written: 'Voveran SR 100', generic: 'Diclofenac', strength: '100 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-0-1', 'OD'], durations: SHORT, instructions: ['After dinner'], allergyClass: 'NSAID' },
  { key: 'meftalspas', written: 'Meftal Spas', generic: 'Mefenamic acid + Dicyclomine', strength: '250 mg + 10 mg', form: 'TABLET', route: 'ORAL', frequencies: ['SOS', '1-1-1'], durations: ['3 days', 'during periods'], instructions: ['For cramps'], allergyClass: 'NSAID' },
  { key: 'ultracet', written: 'Ultracet', generic: 'Tramadol + Paracetamol', strength: '37.5 mg + 325 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1', 'SOS'], durations: SHORT, instructions: ['May cause drowsiness'], highAlert: true },
  { key: 'wysolone', written: 'Wysolone 20', generic: 'Prednisolone', strength: '20 mg', form: 'TABLET', route: 'ORAL', frequencies: ['2-0-0 x5d, 1½-0-0 x5d, 1-0-0 x5d, ½-0-0 x5d', '1-0-0'], durations: ['20 days (taper)', '5 days'], instructions: ['Taper as written', 'Do not stop suddenly'], highAlert: true },

  // Antibiotics and anti-infectives
  { key: 'augmentin', written: 'Augmentin 625 Duo', generic: 'Amoxicillin + Clavulanic acid', strength: '625 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1', 'BD'], durations: ['5 days', '7 days'], instructions: ['After food', 'Complete the course'], allergyClass: 'PENICILLIN' },
  { key: 'mox', written: 'Cap Mox 500', generic: 'Amoxicillin', strength: '500 mg', form: 'CAPSULE', route: 'ORAL', frequencies: ['1-1-1', 'TDS'], durations: ['5 days'], instructions: ['Complete the course'], allergyClass: 'PENICILLIN' },
  { key: 'azithral', written: 'Azithral 500', generic: 'Azithromycin', strength: '500 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0', 'OD'], durations: ['3 days', '5 days'], instructions: ['1 hr before food'], allergyClass: 'MACROLIDE' },
  { key: 'zifi', written: 'Zifi 200', generic: 'Cefixime', strength: '200 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1'], durations: ['5 days', '7 days'], instructions: ['After food'], allergyClass: 'CEPHALOSPORIN' },
  { key: 'ceftum', written: 'Ceftum 500', generic: 'Cefuroxime', strength: '500 mg', form: 'TABLET', route: 'ORAL', frequencies: ['BD'], durations: ['7 days'], instructions: ['After food'], allergyClass: 'CEPHALOSPORIN' },
  { key: 'norfloxtz', written: 'Norflox-TZ', generic: 'Norfloxacin + Tinidazole', strength: '400 mg + 600 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1'], durations: ['3 days', '5 days'], instructions: ['Avoid alcohol'], allergyClass: 'FLUOROQUINOLONE' },
  { key: 'metrogyl', written: 'Metrogyl 400', generic: 'Metronidazole', strength: '400 mg', form: 'TABLET', route: 'ORAL', frequencies: ['TDS'], durations: ['5 days', '7 days'], instructions: ['Avoid alcohol'] },
  { key: 'doxy', written: 'Doxy-1 L-DR Forte', generic: 'Doxycycline + Lactic acid bacillus', strength: '100 mg', form: 'CAPSULE', route: 'ORAL', frequencies: ['1-0-1'], durations: ['7 days', '14 days'], instructions: ['Do not lie down for 30 min'] },
  { key: 'septran', written: 'Septran DS', generic: 'Sulfamethoxazole + Trimethoprim', strength: '800 mg + 160 mg', form: 'TABLET', route: 'ORAL', frequencies: ['BD'], durations: ['5 days'], instructions: ['Drink plenty of water'], allergyClass: 'SULFA' },
  { key: 'fluconazole', written: 'Forcan 150', generic: 'Fluconazole', strength: '150 mg', form: 'TABLET', route: 'ORAL', frequencies: ['stat', 'once a week x 4'], durations: ['single dose', '4 weeks'], instructions: [] },
  { key: 'monocef', written: 'Inj. Monocef 1 g IV', generic: 'Ceftriaxone', strength: '1 g', form: 'INJECTION', route: 'INTRAVENOUS', frequencies: ['BD', 'OD'], durations: ['3 days', '5 days'], instructions: ['After test dose', 'In hospital'], allergyClass: 'CEPHALOSPORIN' },
  { key: 'hcqs', written: 'HCQS 200', generic: 'Hydroxychloroquine', strength: '200 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1', '0-0-1'], durations: LONG, instructions: ['Annual eye check'], chronic: true },

  // Stomach
  { key: 'pan40', written: 'Pan 40', generic: 'Pantoprazole', strength: '40 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0', 'OD BBF', '1-0-1'], durations: ['5 days', '14 days', '1 month'], instructions: ['Empty stomach', '30 min before breakfast'] },
  { key: 'pand', written: 'Pan-D', generic: 'Pantoprazole + Domperidone', strength: '40 mg + 30 mg', form: 'CAPSULE', route: 'ORAL', frequencies: ['1-0-0'], durations: ['7 days', '14 days'], instructions: ['Before breakfast'] },
  { key: 'rantac', written: 'Rantac 150', generic: 'Ranitidine', strength: '150 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1'], durations: ['7 days'], instructions: [] },
  { key: 'omez', written: 'Omez 20', generic: 'Omeprazole', strength: '20 mg', form: 'CAPSULE', route: 'ORAL', frequencies: ['1-0-0'], durations: ['14 days'], instructions: ['Before food'] },
  { key: 'ondem', written: 'Ondem 4', generic: 'Ondansetron', strength: '4 mg', form: 'TABLET', route: 'ORAL', frequencies: ['SOS', 'TDS'], durations: ['3 days'], instructions: ['For vomiting', 'Dissolve on tongue'] },
  { key: 'cyclopam', written: 'Cyclopam', generic: 'Dicyclomine + Paracetamol', strength: null, form: 'TABLET', route: 'ORAL', frequencies: ['SOS'], durations: ['3 days'], instructions: ['For stomach pain'] },
  { key: 'electral', written: 'ORS (Electral) sachet', generic: 'Oral rehydration salts', strength: '21.8 g', form: 'POWDER', route: 'ORAL', frequencies: ['after each loose stool', 'sip frequently'], durations: ['till diarrhoea stops'], instructions: ['1 sachet in 1 litre boiled cooled water'] },
  { key: 'dulcolax', written: 'Dulcolax supp.', generic: 'Bisacodyl', strength: '10 mg', form: 'OTHER', route: 'RECTAL', frequencies: ['SOS', 'HS'], durations: ['2 days'], instructions: ['Insert rectally'] },

  // Diabetes, heart, thyroid (chronic)
  { key: 'glycomet', written: 'Glycomet 500', generic: 'Metformin', strength: '500 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1', '1-1-1', '0-1-0'], durations: LONG, instructions: ['With meals'], chronic: true },
  { key: 'glycometgp', written: 'Glycomet-GP 1', generic: 'Metformin + Glimepiride', strength: '500 mg + 1 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0', '1-0-1'], durations: LONG, instructions: ['Before breakfast', 'Watch for low sugar'], chronic: true, highAlert: true },
  { key: 'janumet', written: 'Janumet 50/500', generic: 'Sitagliptin + Metformin', strength: '50 mg + 500 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1'], durations: LONG, instructions: ['With meals'], chronic: true },
  { key: 'lantus', written: 'Inj. Lantus', generic: 'Insulin glargine', strength: '100 IU/ml', form: 'INJECTION', route: 'SUBCUTANEOUS', frequencies: ['10 units at bedtime', '14 U HS', '0-0-12 U'], durations: LONG, instructions: ['Rotate injection site', 'Check sugar before'], chronic: true, highAlert: true },
  { key: 'mixtard', written: 'Inj. Human Mixtard 30/70', generic: 'Insulin isophane + regular (30/70)', strength: '40 IU/ml', form: 'INJECTION', route: 'SUBCUTANEOUS', frequencies: ['18-0-10 U', '20 U BBF, 12 U BD'], durations: LONG, instructions: ['30 min before meals'], chronic: true, highAlert: true },
  { key: 'amlong', written: 'Amlong 5', generic: 'Amlodipine', strength: '5 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0', '0-0-1'], durations: LONG, instructions: [], chronic: true },
  { key: 'telma40', written: 'Telma 40', generic: 'Telmisartan', strength: '40 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0'], durations: LONG, instructions: ['Same time daily'], chronic: true },
  { key: 'telmah', written: 'Telma-H', generic: 'Telmisartan + Hydrochlorothiazide', strength: '40 mg + 12.5 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0'], durations: LONG, instructions: ['Morning'], chronic: true },
  { key: 'metolar', written: 'Metolar XR 50', generic: 'Metoprolol succinate', strength: '50 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0', '1-0-1'], durations: LONG, instructions: ['Do not stop suddenly'], chronic: true },
  { key: 'ecosprin', written: 'Ecosprin 75', generic: 'Aspirin', strength: '75 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-1-0', '0-0-1'], durations: LONG, instructions: ['After lunch'], chronic: true, allergyClass: 'NSAID' },
  { key: 'clopilet', written: 'Clopilet 75', generic: 'Clopidogrel', strength: '75 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-1-0'], durations: LONG, instructions: [], chronic: true },
  { key: 'atorva', written: 'Atorva 20', generic: 'Atorvastatin', strength: '20 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-0-1', 'HS'], durations: LONG, instructions: ['At night'], chronic: true },
  { key: 'rosuvas', written: 'Rosuvas 10', generic: 'Rosuvastatin', strength: '10 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-0-1'], durations: LONG, instructions: [], chronic: true },
  { key: 'warf', written: 'Warf 5', generic: 'Warfarin', strength: '5 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-0-1 (Mon-Sat), ½ on Sun', '0-0-1'], durations: LONG, instructions: ['INR every 2 weeks', 'Avoid leafy-green swings'], chronic: true, highAlert: true },
  { key: 'lasix', written: 'Lasix 40', generic: 'Furosemide', strength: '40 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0', '1-1-0'], durations: LONG, instructions: ['Morning only'], chronic: true },
  { key: 'aldactone', written: 'Aldactone 25', generic: 'Spironolactone', strength: '25 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0'], durations: LONG, instructions: [], chronic: true },
  { key: 'thyronorm50', written: 'Thyronorm 50 mcg', generic: 'Levothyroxine', strength: '50 mcg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0', 'OD empty stomach'], durations: LONG, instructions: ['Empty stomach, 30 min before breakfast'], chronic: true },
  { key: 'thyronorm75', written: 'Thyronorm 75', generic: 'Levothyroxine', strength: '75 mcg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0'], durations: LONG, instructions: ['Empty stomach'], chronic: true },
  { key: 'eltroxin', written: 'Eltroxin 100', generic: 'Levothyroxine', strength: '100 mcg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0'], durations: LONG, instructions: ['Empty stomach'], chronic: true },
  { key: 'folitrax', written: 'Folitrax 7.5', generic: 'Methotrexate', strength: '7.5 mg', form: 'TABLET', route: 'ORAL', frequencies: ['Once a WEEK (Sunday)', 'weekly - Sun'], durations: LONG, instructions: ['WEEKLY ONLY, not daily', 'Folic acid next day'], chronic: true, highAlert: true },
  { key: 'folvite', written: 'Folvite 5', generic: 'Folic acid', strength: '5 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0', 'Monday only'], durations: LONG, instructions: [] },

  // Respiratory and allergy
  { key: 'montairlc', written: 'Montair LC', generic: 'Montelukast + Levocetirizine', strength: '10 mg + 5 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-0-1', 'HS'], durations: ['10 days', '1 month'], instructions: ['At bedtime'] },
  { key: 'allegra', written: 'Allegra 120', generic: 'Fexofenadine', strength: '120 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-0', 'SOS'], durations: ['7 days'], instructions: [] },
  { key: 'cetzine', written: 'Cetzine', generic: 'Cetirizine', strength: '10 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-0-1', 'HS'], durations: ['5 days'], instructions: ['May cause sleepiness'] },
  { key: 'ascorills', written: 'Ascoril LS syp', generic: 'Ambroxol + Levosalbutamol + Guaifenesin', strength: null, form: 'SYRUP', route: 'ORAL', frequencies: ['10 ml TDS', '5 ml TDS', '2 tsp TDS'], durations: ['5 days'], instructions: ['Shake well'] },
  { key: 'asthalin', written: 'Asthalin inhaler', generic: 'Salbutamol', strength: '100 mcg/puff', form: 'INHALER', route: 'INHALATION', frequencies: ['2 puffs SOS', '2 puffs QID'], durations: ['SOS', 'continue'], instructions: ['Use spacer', 'Shake before use'] },
  { key: 'foracort', written: 'Foracort 200 Inhaler', generic: 'Formoterol + Budesonide', strength: '6 mcg + 200 mcg', form: 'INHALER', route: 'INHALATION', frequencies: ['2 puffs BD'], durations: LONG, instructions: ['Rinse mouth after use'], chronic: true },
  { key: 'budecort', written: 'Budecort respules', generic: 'Budesonide', strength: '0.5 mg/2 ml', form: 'OTHER', route: 'INHALATION', frequencies: ['nebulise BD'], durations: ['5 days'], instructions: ['Via nebuliser'] },
  { key: 'deriphyllin', written: 'Deriphyllin retard 150', generic: 'Etofylline + Theophylline', strength: '150 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1'], durations: ['1 month'], instructions: [] },
  { key: 'otrivin', written: 'Otrivin nasal drops', generic: 'Xylometazoline', strength: '0.1%', form: 'DROPS', route: 'NASAL', frequencies: ['2 drops each nostril TDS'], durations: ['5 days max'], instructions: ['Not more than 5 days'] },

  // Eye, ear, skin
  { key: 'moxicip', written: 'Moxicip eye drops', generic: 'Moxifloxacin', strength: '0.5%', form: 'DROPS', route: 'OPHTHALMIC', frequencies: ['1 drop QID both eyes', '1 drop 2 hourly RE'], durations: ['7 days'], instructions: ['Wash hands first'], allergyClass: 'FLUOROQUINOLONE' },
  { key: 'refresh', written: 'Refresh Tears', generic: 'Carboxymethylcellulose', strength: '0.5%', form: 'DROPS', route: 'OPHTHALMIC', frequencies: ['1 drop 4-6 times a day'], durations: ['1 month', 'continue'], instructions: [] },
  { key: 'timolol', written: 'Iotim 0.5% e/d', generic: 'Timolol', strength: '0.5%', form: 'DROPS', route: 'OPHTHALMIC', frequencies: ['1 drop BD both eyes'], durations: LONG, instructions: ['Press inner corner after drop'], chronic: true },
  { key: 'ciplox', written: 'Ciplox-D ear drops', generic: 'Ciprofloxacin + Dexamethasone', strength: null, form: 'DROPS', route: 'OTIC', frequencies: ['3 drops TDS LE'], durations: ['7 days'], instructions: ['Left ear only'], allergyClass: 'FLUOROQUINOLONE' },
  { key: 'betnovatec', written: 'Betnovate-C cream', generic: 'Betamethasone + Clioquinol', strength: null, form: 'CREAM', route: 'TOPICAL', frequencies: ['apply BD', 'LA BD'], durations: ['7 days', '2 weeks'], instructions: ['Thin layer', 'Not on face'] },
  { key: 'candidb', written: 'Candid-B', generic: 'Clotrimazole + Beclomethasone', strength: null, form: 'CREAM', route: 'TOPICAL', frequencies: ['LA twice daily'], durations: ['2 weeks'], instructions: [] },
  { key: 'soframycin', written: 'Soframycin skin cream', generic: 'Framycetin', strength: '1%', form: 'CREAM', route: 'TOPICAL', frequencies: ['apply on wound BD'], durations: ['5 days'], instructions: ['Clean the wound first'] },
  { key: 'luliconazole', written: 'Lulifin oint.', generic: 'Luliconazole', strength: '1%', form: 'OINTMENT', route: 'TOPICAL', frequencies: ['OD'], durations: ['2 weeks', '4 weeks'], instructions: ['Continue 1 week after rash clears'] },

  // Women's health, pregnancy, supplements
  { key: 'duphaston', written: 'Duphaston', generic: 'Dydrogesterone', strength: '10 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1'], durations: ['10 days', 'till 12 weeks'], instructions: [] },
  { key: 'susten', written: 'Susten 200', generic: 'Progesterone', strength: '200 mg', form: 'CAPSULE', route: 'OTHER', frequencies: ['0-0-1 PV', 'HS'], durations: ['till 12 weeks'], instructions: ['Vaginal use as advised'] },
  { key: 'shelcal', written: 'Shelcal 500', generic: 'Calcium carbonate + Vitamin D3', strength: '500 mg + 250 IU', form: 'TABLET', route: 'ORAL', frequencies: ['0-1-0', '1-0-1'], durations: LONG, instructions: ['After lunch'] },
  { key: 'orofer', written: 'Orofer XT', generic: 'Ferrous ascorbate + Folic acid', strength: '100 mg + 1.5 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-1-0'], durations: ['3 months'], instructions: ['Not with milk or tea'] },
  { key: 'uprised3', written: 'Uprise-D3 60K', generic: 'Cholecalciferol', strength: '60000 IU', form: 'CAPSULE', route: 'ORAL', frequencies: ['once a week x 8 weeks', 'weekly'], durations: ['8 weeks', '2 months'], instructions: ['With milk'] },
  { key: 'becosules', written: 'Becosules Z', generic: 'Vitamin B-complex + Zinc', strength: null, form: 'CAPSULE', route: 'ORAL', frequencies: ['1-0-0', 'OD'], durations: ['1 month'], instructions: [] },
  { key: 'neurobionforte', written: 'Neurobion Forte', generic: 'Vitamin B1 + B6 + B12', strength: null, form: 'TABLET', route: 'ORAL', frequencies: ['0-1-0'], durations: ['1 month'], instructions: [] },
  { key: 'b12inj', written: 'Inj. Neurobion IM', generic: 'Cyanocobalamin', strength: '1000 mcg', form: 'INJECTION', route: 'INTRAMUSCULAR', frequencies: ['alternate days x 5', 'weekly'], durations: ['10 days', '1 month'], instructions: ['At clinic'] },
  { key: 'tt', written: 'Inj. TT 0.5 ml IM', generic: 'Tetanus toxoid', strength: '0.5 ml', form: 'INJECTION', route: 'INTRAMUSCULAR', frequencies: ['stat'], durations: ['single dose'], instructions: ['Given at clinic'] },
  { key: 'clexane', written: 'Inj. Clexane 40', generic: 'Enoxaparin', strength: '40 mg/0.4 ml', form: 'INJECTION', route: 'SUBCUTANEOUS', frequencies: ['OD SC'], durations: ['10 days'], instructions: ['Abdomen, rotate site'], highAlert: true },

  // Mental health, neuro
  { key: 'nexito', written: 'Nexito 10', generic: 'Escitalopram', strength: '10 mg', form: 'TABLET', route: 'ORAL', frequencies: ['0-0-1', '1-0-0'], durations: ['3 months', 'continue'], instructions: ['Do not stop on your own'], chronic: true },
  { key: 'lonazep', written: 'Lonazep 0.25', generic: 'Clonazepam', strength: '0.25 mg', form: 'TABLET', route: 'ORAL', frequencies: ['HS', 'SOS'], durations: ['2 weeks'], instructions: ['May cause drowsiness'], highAlert: true },
  { key: 'pregabalin', written: 'Pregeb M 75', generic: 'Pregabalin + Methylcobalamin', strength: '75 mg + 750 mcg', form: 'CAPSULE', route: 'ORAL', frequencies: ['0-0-1'], durations: ['1 month'], instructions: ['At bedtime'] },
  { key: 'levipil', written: 'Levipil 500', generic: 'Levetiracetam', strength: '500 mg', form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1'], durations: LONG, instructions: ['Never miss a dose'], chronic: true, highAlert: true },

  // Traditional and unclear: generic stays null on purpose (rule 12, 13)
  { key: 'liv52', written: 'Liv. 52', generic: null, strength: null, form: 'TABLET', route: 'ORAL', frequencies: ['2-2-2', '1-1-1'], durations: ['1 month'], instructions: ['Ayurvedic'] },
  { key: 'chyawanprash', written: 'Chyawanprash', generic: null, strength: null, form: 'OTHER', route: 'ORAL', frequencies: ['1 tsp with milk morning'], durations: ['continue'], instructions: [] },
  { key: 'arnica', written: 'Arnica Montana 30', generic: null, strength: '30C', form: 'DROPS', route: 'ORAL', frequencies: ['4 drops TDS'], durations: ['7 days'], instructions: ['Homeopathic', 'Keep 15 min gap from food'] },
  { key: 'septilin', written: 'Septilin syp', generic: null, strength: null, form: 'SYRUP', route: 'ORAL', frequencies: ['2 tsp BD'], durations: ['15 days'], instructions: ['Ayurvedic'] },
  { key: 'unknownsyp', written: 'Syp. ??? (illegible) 5ml', generic: null, strength: null, form: 'SYRUP', route: 'ORAL', frequencies: ['TDS ?'], durations: ['?'], instructions: [] },
  { key: 'unknowntab', written: 'Tab R---x 1-0-1', generic: null, strength: null, form: 'TABLET', route: 'ORAL', frequencies: ['1-0-1'], durations: [], instructions: [] },
];

export const MEDICINE_BY_KEY: ReadonlyMap<string, CatalogMedicine> = new Map(MEDICINES.map((m) => [m.key, m]));

export function med(key: string): CatalogMedicine {
  const found = MEDICINE_BY_KEY.get(key);
  if (!found) throw new Error(`Unknown catalog medicine: ${key}`);
  return found;
}

/** Short-course medicines grouped by the illness they treat, for random acute visits. */
export const ACUTE_VISITS: ReadonlyArray<{ diagnosis: string | null; meds: readonly string[] }> = [
  { diagnosis: 'Viral fever', meds: ['dolo650', 'cetzine', 'becosules'] },
  { diagnosis: 'URTI', meds: ['azithral', 'dolo650', 'montairlc', 'ascorills'] },
  { diagnosis: 'Acute pharyngitis', meds: ['augmentin', 'pcm', 'allegra'] },
  { diagnosis: 'Acute gastroenteritis', meds: ['norfloxtz', 'electral', 'ondem', 'pan40'] },
  { diagnosis: 'Gastritis / GERD', meds: ['pand', 'rantac'] },
  { diagnosis: 'UTI', meds: ['zifi', 'pcm'] },
  { diagnosis: 'Low back pain', meds: ['zerodolsp', 'pan40', 'pregabalin'] },
  { diagnosis: 'Conjunctivitis', meds: ['moxicip', 'refresh'] },
  { diagnosis: 'Otitis externa', meds: ['ciplox', 'combiflam'] },
  { diagnosis: 'Fungal skin infection', meds: ['candidb', 'luliconazole', 'cetzine'] },
  { diagnosis: 'Allergic rhinitis', meds: ['montairlc', 'otrivin', 'allegra'] },
  { diagnosis: 'Acute bronchitis', meds: ['ceftum', 'ascorills', 'deriphyllin'] },
  { diagnosis: 'Dysmenorrhoea', meds: ['meftalspas'] },
  { diagnosis: 'Dengue fever (NS1+)', meds: ['dolo650', 'electral'] },
  { diagnosis: 'Typhoid fever', meds: ['zifi', 'dolo650', 'pan40'] },
  { diagnosis: 'Amoebic dysentery', meds: ['metrogyl', 'electral'] },
  { diagnosis: 'Minor cut, left hand', meds: ['tt', 'soframycin', 'pcm'] },
  { diagnosis: 'Asthma exacerbation', meds: ['wysolone', 'asthalin', 'budecort'] },
  { diagnosis: 'Vitamin D deficiency', meds: ['uprised3', 'shelcal'] },
  { diagnosis: 'Iron deficiency anaemia', meds: ['orofer', 'folvite'] },
  { diagnosis: null, meds: ['dolo650', 'pan40'] },
  { diagnosis: 'Constipation', meds: ['dulcolax'] },
];

/** Long-term conditions with the medicines refilled for them. */
export const CHRONIC_PLANS: ReadonlyArray<{ condition: string; meds: readonly string[] }> = [
  { condition: 'Type 2 diabetes mellitus', meds: ['glycomet', 'janumet'] },
  { condition: 'Type 2 diabetes on insulin', meds: ['glycometgp', 'lantus'] },
  { condition: 'Essential hypertension', meds: ['amlong', 'telma40'] },
  { condition: 'Hypertension with fluid retention', meds: ['telmah', 'lasix'] },
  { condition: 'Hypothyroidism', meds: ['thyronorm50'] },
  { condition: 'Coronary artery disease, post PTCA', meds: ['ecosprin', 'clopilet', 'atorva', 'metolar'] },
  { condition: 'Dyslipidaemia', meds: ['rosuvas'] },
  { condition: 'Bronchial asthma', meds: ['foracort', 'asthalin', 'montairlc'] },
  { condition: 'Rheumatoid arthritis', meds: ['folitrax', 'folvite', 'hcqs'] },
  { condition: 'Atrial fibrillation', meds: ['warf', 'metolar'] },
  { condition: 'Generalised anxiety disorder', meds: ['nexito'] },
  { condition: 'Epilepsy', meds: ['levipil'] },
  { condition: 'Primary open-angle glaucoma', meds: ['timolol'] },
  { condition: 'Heart failure', meds: ['lasix', 'aldactone', 'metolar'] },
];

export const FIRST_NAMES_F = [
  'Aarti', 'Ananya', 'Bhavna', 'Chitra', 'Deepika', 'Divya', 'Farah', 'Gauri', 'Harpreet', 'Isha', 'Jyoti', 'Kavya',
  'Lakshmi', 'Meera', 'Nandini', 'Pooja', 'Priya', 'Rekha', 'Sakshi', 'Sneha', 'Tanvi', 'Uma', 'Vaishnavi', 'Zoya',
  'Fatima', 'Mary', 'Gurleen', 'Anjali', 'Revathi', 'Shabnam',
] as const;
export const FIRST_NAMES_M = [
  'Aarav', 'Abhishek', 'Arjun', 'Bharat', 'Chetan', 'Deepak', 'Farhan', 'Ganesh', 'Harish', 'Imran', 'Jatin', 'Karthik',
  'Manoj', 'Naveen', 'Om', 'Pranav', 'Rahul', 'Rohit', 'Sandeep', 'Suresh', 'Tarun', 'Vikram', 'Yusuf', 'Zubin',
  'Joseph', 'Gurpreet', 'Sanjay', 'Venkatesh', 'Ashok', 'Mohammed',
] as const;
export const SURNAMES = [
  'Sharma', 'Verma', 'Iyer', 'Nair', 'Reddy', 'Rao', 'Patel', 'Shah', 'Mehta', 'Gupta', 'Agarwal', 'Banerjee',
  'Chatterjee', 'Das', 'Ghosh', 'Mukherjee', 'Kulkarni', 'Deshpande', 'Joshi', 'Pillai', 'Menon', 'Singh', 'Gill',
  'Khan', 'Qureshi', 'Fernandes', "D'Souza", 'Thomas', 'Kaur', 'Naidu', 'Hegde', 'Bhat', 'Saxena', 'Malhotra',
] as const;

export const DOCTORS = [
  'Dr. R. K. Sharma, MBBS, MD (Med)', 'Dr. Anita Deshmukh, MBBS, DGO', 'Dr. S. Venkataraman, MD, DM (Cardio)',
  'Dr. Priya Nair, MBBS, DCH', 'Dr. M. A. Qureshi, MBBS', 'Dr. Kavita Rao, MS (Ophth)', 'Dr. Arvind Joshi, MD (Derm)',
  'Dr. B. N. Ghosh, MBBS, MD', 'Dr. Harleen Kaur, MD (Endo)', 'Dr. J. Fernandes, MS (Ortho)', 'Dr. P. Subramanian, MS (ENT)',
  'Dr. Neha Agarwal, MD (Psych)', 'Dr. T. Reddy, DM (Neuro)', 'Dr. Ramesh', 'Dr. S.K.', 'Dr. Lata Kulkarni, MD (Chest)',
] as const;

export const CLINICS = [
  'City Care Clinic, Bengaluru', 'Shree Sai Polyclinic, Pune', 'Apollo Clinic, Indiranagar', 'Fortis OPD, Mohali',
  'Govt. District Hospital, Nashik', 'PHC Kothrud', 'Sunrise Children Hospital, Kochi', 'Lotus Eye Care, Chennai',
  'Kaya Skin Centre, Hyderabad', 'Max Healthcare, Saket', 'AIIMS OPD, New Delhi', 'Ruby Hall Clinic, Pune',
  'Family Clinic (no address)', 'Manipal Hospital, Old Airport Road', 'Medanta, Gurugram', 'CMC Vellore OPD',
] as const;

export const TIMEZONES_COMMON = ['Asia/Kolkata'] as const;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'] as const;
