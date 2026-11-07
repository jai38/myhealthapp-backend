import { WorldBuilder, Patient, RxLine, Adherence, reminderTimesFor } from './builder.js';
import { ACUTE_VISITS, BLOOD_GROUPS, CHRONIC_PLANS, DOCTORS, CLINICS, FIRST_NAMES_F, FIRST_NAMES_M, SURNAMES, MEDICINES, med } from './catalog.js';
import { HANDWRITTEN_TEMPLATES, TEMPLATE_BY_ID } from './handwritten-templates.js';
import { emergencyContacts, emptyFuture, FutureData, labPanels, measurementSeries } from './future.js';
import { HOUR, addDays, isoDay, startOfUtcDay, utcDate } from './time.js';

/** Earliest record date for ordinary data. A few personas go earlier on purpose (see `historical`). */
export const DATA_START = utcDate(2000, 1, 1);

const line = (key: string, extra: Partial<RxLine> = {}): RxLine => {
  const m = med(key);
  return { med: m, frequency: m.frequencies[0], duration: m.durations[0], instructions: m.instructions[0], ...extra };
};

function template(id: string) {
  const t = TEMPLATE_BY_ID.get(id);
  if (!t) throw new Error(`Unknown template ${id}`);
  return t;
}

function setFuture(b: WorldBuilder, p: Patient, fill: (f: FutureData) => void): void {
  const f = emptyFuture();
  fill(f);
  b.world.future[p.info.email] = f;
}

/** Chronic refills every `everyDays` from `from` to now; the latest one is current (active medicines). */
function chronicRefills(
  b: WorldBuilder,
  p: Patient,
  keys: string[],
  from: Date,
  everyDays: number,
  opts: { doctor?: string; clinic?: string; diagnosis?: string; max?: number } = {},
): void {
  const dates: Date[] = [];
  for (let d = from; d < b.now; d = addDays(d, Math.max(7, everyDays + b.rng.int(-5, 5)))) dates.push(d);
  const kept = opts.max && dates.length > opts.max ? dates.slice(dates.length - opts.max) : dates;
  const doseWindowStart = addDays(b.now, -b.opts.doseHistoryDays - 45);
  kept.forEach((date, i) => {
    const latest = i === kept.length - 1;
    const next = kept[i + 1];
    // Refills inside the dose-history window were current when confirmed and were later replaced by the
    // next refill: COMPLETED, with the doses taken (or not) while they ran. Older refills stay INACTIVE.
    const recentPast = !latest && next !== undefined && date >= doseWindowStart;
    p.addRx({
      date,
      doctor: opts.doctor ?? b.rng.pick(DOCTORS),
      clinic: opts.clinic ?? b.rng.pick(CLINICS),
      diagnosis: opts.diagnosis ?? null,
      lines: keys.map((k) => {
        const base = line(k, { duration: latest ? 'continue' : '1 month' });
        return recentPast ? { ...base, status: 'COMPLETED' as const, endedAt: next, reminderTimes: reminderTimesFor(base.frequency) } : base;
      }),
      current: latest || recentPast,
    });
  });
}

function acuteVisit(b: WorldBuilder, p: Patient, date: Date, current: boolean): void {
  const v = b.rng.pick(ACUTE_VISITS);
  p.addRx({
    date,
    doctor: b.rng.pick(DOCTORS),
    clinic: b.rng.bool(0.9) ? b.rng.pick(CLINICS) : null,
    diagnosis: v.diagnosis,
    lines: v.meds.map((k) => {
      const m = med(k);
      return line(k, { frequency: b.rng.pick(m.frequencies), duration: m.durations.length ? b.rng.pick(m.durations) : undefined });
    }),
    current,
  });
}

export function buildPersonas(b: WorldBuilder): void {
  const rng = b.rng;
  const now = b.now;
  const today = startOfUtcDay(now);
  const ago = (days: number) => addDays(today, -days);
  const yearsAgo = (y: number) => utcDate(today.getUTCFullYear() - y, today.getUTCMonth() + 1, Math.min(28, today.getUTCDate()));

  // 1. Brand-new account: every empty state.
  b.addUser({ slug: 'empty', persona: 'Brand-new user, nothing uploaded', covers: ['Empty Today, Records, Medicines and Timeline', 'First-run onboarding'], fullName: 'Nisha Empty', dob: utcDate(1995, 6, 15), gender: 'Female', bloodGroup: null, createdAt: new Date(now.getTime() - HOUR) });

  // 2. Signed up but never finished onboarding: no PatientProfile row at all.
  b.addUser({ slug: 'no-profile', persona: 'Account with no patient profile', covers: ['Profile missing: screens must not crash', 'Profile-scoped API calls'], fullName: '', dob: null, gender: null, bloodGroup: null, createdAt: ago(3), noProfile: true });

  // 3. Unverified email, password changed, notifications off.
  b.addUser({ slug: 'unverified', persona: 'Email not verified, notifications off', covers: ['Sign-in refused with EMAIL_NOT_VERIFIED (403): the verify-email message', 'notificationsEnabled=false, no daily summary', 'passwordChangedAt set'], fullName: 'Kiran Unverified', dob: utcDate(1988, 2, 2), gender: 'Male', bloodGroup: 'B+', createdAt: ago(10), isVerified: false, notificationsEnabled: false, dailySummaryTime: null, passwordChangedAt: ago(2) });

  // 4. Legacy third-party provider row with no password.
  b.addUser({ slug: 'google-provider', persona: 'GOOGLE auth provider, no password hash', covers: ['Password sign-in must fail cleanly', 'Legacy auth provider values'], fullName: 'Gaurav Google', dob: utcDate(1990, 9, 9), gender: 'Male', bloodGroup: 'O+', createdAt: ago(400), authProvider: 'GOOGLE', noPassword: true });

  // 5. Minimal happy path.
  {
    const p = b.addUser({ slug: 'minimal', persona: 'One prescription, one medicine', covers: ['Smallest non-empty state', 'One active medicine with two reminders'], fullName: 'Om Minimal', dob: utcDate(1992, 1, 1), gender: 'Male', bloodGroup: 'A+', createdAt: ago(5) });
    p.addRx({ date: ago(2), doctor: DOCTORS[0], clinic: CLINICS[0], diagnosis: 'Viral fever', lines: [line('dolo650', { frequency: '1-0-1', duration: '5 days' })], current: true, docKind: 'pdf' });
  }

  // 6. Every handwritten template once: compare image and record side by side.
  {
    const p = b.addUser({ slug: 'handwritten', persona: 'All 20 handwritten prescriptions (HW-01 to HW-20)', covers: ['Document viewer with generated images (after attach-images)', 'Cursive, Hindi, faded, carbon copy, two pages, missing and future dates'], fullName: 'Harini Handwritten', dob: utcDate(1979, 11, 30), gender: 'Female', bloodGroup: 'AB+', createdAt: yearsAgo(24) });
    for (const t of HANDWRITTEN_TEMPLATES) {
      const d = t.dateIso ? new Date(`${t.dateIso}T00:00:00Z`) : null;
      const recent = d !== null && d > ago(45) && d <= today;
      p.addRxFromTemplate(t, { current: recent, uploadedAt: d && d <= today ? new Date(d.getTime() + 10 * HOUR) : ago(rng.int(1, 30)) });
    }
  }

  // 7. Worst-case volume: 25 years, hundreds of prescriptions, long lists.
  {
    const p = b.addUser({ slug: 'heavy', persona: 'Worst-case volume: 25 years of records', covers: ['Timeline and list pagination', 'Search across hundreds of records', 'Report PDF size', 'Slow devices'], fullName: 'Venkataramanan Subramaniam Iyer', dob: utcDate(1958, 3, 21), gender: 'Male', bloodGroup: 'O+', createdAt: yearsAgo(25), adherence: 'good' });
    chronicRefills(b, p, ['glycomet', 'amlong', 'telma40', 'atorva'], utcDate(2001, 4, 10), 30, { diagnosis: 'T2DM with hypertension', max: 300 });
    for (let i = 0; i < 120; i++) acuteVisit(b, p, rng.dateBetween(utcDate(2000, 1, 1), ago(60)), false);
    p.addRx({ date: ago(3), doctor: DOCTORS[2], clinic: CLINICS[13], diagnosis: 'Worst-case list: 25 medicines on one prescription', lines: rng.pickN(MEDICINES.filter((m) => m.form === 'TABLET'), 25).map((m) => line(m.key)), current: false, docKind: 'pdf', pages: 4 });
  }

  // 8. Elderly polypharmacy: 15 active medicines, many reminders a day.
  {
    const p = b.addUser({ slug: 'elderly-polypharmacy', persona: '86-year-old on 15 active medicines', covers: ['Today screen with 30+ doses a day', 'High-alert medicines (warfarin, insulin)', 'Large-text layouts'], fullName: 'Kamala Devi Ramaswamy', dob: utcDate(1940, 8, 12), gender: 'Female', bloodGroup: 'A-', createdAt: yearsAgo(6), adherence: 'patchy' });
    chronicRefills(b, p, ['glycometgp', 'lantus', 'telmah', 'lasix', 'aldactone', 'metolar', 'warf', 'atorva', 'thyronorm50', 'shelcal'], yearsAgo(5), 30, { doctor: DOCTORS[2], clinic: CLINICS[13], diagnosis: 'Heart failure, AF, T2DM, hypothyroidism', max: 60 });
    p.addRx({ date: ago(10), doctor: DOCTORS[5], clinic: CLINICS[7], diagnosis: 'Glaucoma and dry eye', lines: [line('timolol'), line('refresh')], current: true });
    p.addRx({ date: ago(6), doctor: DOCTORS[0], clinic: CLINICS[0], diagnosis: 'Constipation, vitamin deficiency', lines: [line('dulcolax'), line('neurobionforte'), line('becosules')], current: true });
    setFuture(b, p, (f) => {
      f.conditions.push({ name: 'Heart failure', onset: '2019', onsetPrecision: 'YEAR', status: 'ACTIVE' }, { name: 'Atrial fibrillation', onset: '2020-03', onsetPrecision: 'MONTH', status: 'ACTIVE' }, { name: 'Type 2 diabetes', onset: null, onsetPrecision: 'UNKNOWN', status: 'ACTIVE' });
      f.allergies.push({ substance: 'Sulfa drugs', class: 'SULFA', reaction: 'Rash', severity: 'MODERATE', recordedOn: '2010-01-01', status: 'ACTIVE' });
      f.measurements = measurementSeries(rng, now, { days: 365, diabetic: true, hypertensive: true, deviceShare: 0.6 });
      f.labResults = labPanels(rng, now, 5, true);
      f.emergency = { contacts: [{ name: 'Ravi Ramaswamy', relation: 'Son', phone: '+91 99999 01001' }], organDonor: false, notes: 'Hard of hearing. On warfarin.' };
      f.family.push({ relation: 'Son (caregiver)', seedEmail: `caregiver@seed.ayoreni.test`, name: 'Ravi Ramaswamy', role: 'CAREGIVER' });
    });
  }

  // 9. Newborn and toddler: tiny age, syrups and drops, weight-based doses.
  {
    const p = b.addUser({ slug: 'newborn', persona: '4-month-old baby (parent-managed)', covers: ['Age in months, not years', 'Syrups and drops in ml', 'Vaccination schedule (later phases)'], fullName: 'Baby of Pooja Shah', dob: addDays(today, -122), gender: 'Male', bloodGroup: null, createdAt: addDays(today, -120) });
    p.addRx({ date: ago(20), doctor: DOCTORS[3], clinic: CLINICS[6], diagnosis: 'Cold and cough', lines: [line('calpol', { frequency: '1.2 ml SOS', duration: '3 days', instructions: '15 mg/kg' }), line('otrivin', { written: 'Nasivion paediatric drops', frequency: '1 drop each nostril TDS', duration: '3 days' })] });
    p.addRx({ date: ago(1), doctor: DOCTORS[3], clinic: CLINICS[6], diagnosis: 'Vitamin D supplementation', lines: [line('uprised3', { written: 'D-Rise drops 400 IU', frequency: '1 ml OD', duration: '6 months' })], current: true });
    setFuture(b, p, (f) => {
      f.vaccinations.push({ vaccine: 'BCG', dose: 'Birth', date: isoDay(addDays(today, -122)), datePrecision: 'EXACT' }, { vaccine: 'OPV', dose: '0', date: isoDay(addDays(today, -122)), datePrecision: 'EXACT' }, { vaccine: 'Pentavalent', dose: '1', date: isoDay(addDays(today, -80)), datePrecision: 'EXACT' }, { vaccine: 'Pentavalent', dose: '2', date: isoDay(addDays(today, -52)), datePrecision: 'EXACT' }, { vaccine: 'Pentavalent', dose: '3', date: null, datePrecision: 'UNKNOWN' });
      f.measurements.push({ type: 'WEIGHT', value: '6.4', unit: 'kg', takenAt: ago(20).toISOString(), source: 'MANUAL' }, { type: 'HEIGHT', value: '62', unit: 'cm', takenAt: ago(20).toISOString(), source: 'MANUAL' });
    });
  }

  // 10. Missing optional profile fields and odd values.
  b.addUser({ slug: 'sparse-profile', persona: 'No date of birth, gender or blood group', covers: ['Null profile fields everywhere', 'Age cannot be shown'], fullName: 'X', dob: null, gender: null, bloodGroup: null, createdAt: ago(30) }).addRx({ date: ago(25), lines: [line('pcm')], doctor: null, clinic: null, diagnosis: null });
  b.addUser({ slug: 'odd-profile', persona: 'Unusual profile values', covers: ['Gender "Other" and free text', 'Blood group "Unknown" and Bombay (hh)', 'Born 29 Feb', 'Age 105'], fullName: 'Ā Ñ Ö Ümlaut-Test', dob: utcDate(1920, 2, 29), gender: 'Prefer not to say', bloodGroup: 'Bombay (hh)', createdAt: ago(200) }).addRx({ date: utcDate(2024, 2, 29), lines: [line('shelcal')], doctor: DOCTORS[13], clinic: CLINICS[12] });

  // 11. Long text and non-Latin scripts everywhere.
  {
    const long = 'Dr. Venkatanarasimharajuvaripeta Subrahmanya Lakshminarayana Sastry, MBBS, MD (General Medicine), DNB, FRCP (London), FACP, Consultant Physician & Diabetologist';
    const p = b.addUser({ slug: 'long-text', persona: 'Very long names and Indian scripts', covers: ['Text overflow and truncation', 'Devanagari, Tamil, Bengali, Urdu rendering', 'Emoji in free text'], fullName: 'श्रीमती अन्नपूर्णा वेंकटलक्ष्मी सुब्रमण्यम चक्रवर्ती राजगोपालाचारी', dob: utcDate(1966, 7, 4), gender: 'Female', bloodGroup: 'B-', createdAt: ago(90) });
    p.addRx({ date: ago(60), doctor: long, clinic: 'Sri Venkateswara Multi-Speciality Super-Speciality Hospital & Research Institute, 4th Cross, 11th Main, Jayanagar 9th Block, Bengaluru 560069', diagnosis: 'Type 2 diabetes mellitus with diabetic peripheral neuropathy, diabetic nephropathy (CKD stage 3a), essential hypertension, dyslipidaemia, and grade 1 fatty liver on ultrasound', lines: [line('pregabalin', { written: 'Tab. Pregabalin 75 mg + Methylcobalamin 750 mcg (Pregeb-M 75) — take one tablet at bedtime after dinner with a full glass of water', instructions: 'रात को खाने के बाद। இரவு உணவுக்குப் பிறகு. রাতে খাবারের পরে। رات کے کھانے کے بعد 🌙' })], current: true });
    p.addRx({ date: ago(30), doctor: 'டாக்டர் ரா. கிருஷ்ணன்', clinic: 'சென்னை மருத்துவமனை', diagnosis: 'காய்ச்சல்', lines: [line('dolo650', { written: 'டோலோ 650' })] });
    p.addRx({ date: ago(15), doctor: 'ডাঃ সুব্রত ব্যানার্জি', clinic: 'কলকাতা ক্লিনিক', diagnosis: 'জ্বর', lines: [line('pcm', { written: 'প্যারাসিটামল ৫০০' })] });
  }

  // 12. Uncertain and missing dates in every form.
  {
    const p = b.addUser({ slug: 'uncertain-dates', persona: 'Every kind of uncertain or missing date', covers: ['Undated prescriptions', 'Dates flagged uncertain', 'Future-dated prescription', 'Month and year precision on the timeline', 'Leap days and year boundaries'], fullName: 'Uma Uncertain', dob: utcDate(1975, 12, 31), gender: 'Female', bloodGroup: 'O-', createdAt: yearsAgo(8) });
    p.addRx({ date: null, doctor: DOCTORS[4], diagnosis: 'Undated: date missing on paper', lines: [line('pan40')] });
    p.addRx({ date: null, dateUncertain: true, diagnosis: 'Undated and uncertain medicine', lines: [line('unknowntab', { uncertain: true })] });
    p.addRx({ date: utcDate(2025, 7, 4), dateUncertain: true, diagnosis: '04/07/25: day-month order unclear', lines: [line('calpol')] });
    p.addRx({ date: addDays(today, 59), dateUncertain: true, diagnosis: 'Doctor wrote a future date', lines: [line('zerodolsp')] });
    p.addRx({ date: utcDate(2000, 2, 29), diagnosis: 'Leap day 2000', lines: [line('becosules')] });
    p.addRx({ date: utcDate(2023, 12, 31), diagnosis: 'Last day of 2023', lines: [line('cetzine')] });
    p.addRx({ date: utcDate(2024, 1, 1), diagnosis: 'First day of 2024', lines: [line('cetzine')] });
    p.addRx({ date: today, diagnosis: 'Dated today', lines: [line('dolo650', { duration: '3 days' })], current: true });
    p.addOtherTimelineEvent('LAB_REPORT', utcDate(2018, 6, 1), 'Blood test (month only)', 'Report says "June 2018"', 'MONTH');
    p.addOtherTimelineEvent('VACCINATION', utcDate(1990, 1, 1), 'Childhood vaccinations', 'Year only, from an old card', 'YEAR');
  }

  // 13. Extraction pipeline in every state.
  {
    const p = b.addUser({ slug: 'pipeline', persona: 'Documents in every processing state', covers: ['Uploaded, extracting, stuck, ready for review, failed, cancelled', 'Review drafts with uncertain fields', 'Upload intents: fresh, expired, stuck, rejected', 'Duplicate upload (same SHA-256)'], fullName: 'Pranav Pipeline', dob: utcDate(1985, 5, 5), gender: 'Male', bloodGroup: 'A+', createdAt: ago(60) });
    const base = p.addRx({ date: ago(40), doctor: DOCTORS[1], diagnosis: 'Confirmed baseline', lines: [line('augmentin')] });
    p.addRx({ date: ago(40), doctor: DOCTORS[1], diagnosis: 'Same file uploaded again', lines: [line('augmentin')], sameBytesAs: base.documentId, pipeline: 'READY_FOR_REVIEW', uploadedAt: ago(1) });
    p.addRx({ date: ago(1), lines: [line('pcm')], pipeline: 'UPLOADED', uploadedAt: new Date(now.getTime() - 30_000) });
    p.addRx({ date: ago(1), lines: [line('pcm')], pipeline: 'EXTRACTING', uploadedAt: new Date(now.getTime() - 90_000) });
    p.addRx({ date: ago(5), lines: [line('pcm')], pipeline: 'EXTRACTING_STUCK', uploadedAt: new Date(now.getTime() - 3 * HOUR) });
    p.addRxFromTemplate(template('HW-02'), { pipeline: 'READY_FOR_REVIEW', uploadedAt: ago(2) });
    p.addRxFromTemplate(template('HW-08'), { pipeline: 'READY_FOR_REVIEW', uploadedAt: ago(1) });
    p.addRxFromTemplate(template('HW-12'), { pipeline: 'READY_FOR_REVIEW', uploadedAt: new Date(now.getTime() - 4 * HOUR) });
    p.addRx({ date: ago(3), doctor: DOCTORS[2], diagnosis: 'Draft with 25 medicines to review', lines: rng.pickN(MEDICINES, 25).map((m) => line(m.key, { uncertain: rng.bool(0.3) })), pipeline: 'READY_FOR_REVIEW', docKind: 'pdf', pages: 6 });
    p.addRx({ date: ago(8), lines: [line('pcm')], pipeline: 'FAILED', failure: 'PROVIDER_TIMEOUT' });
    p.addRx({ date: ago(9), lines: [line('pcm')], pipeline: 'FAILED', failure: 'PROVIDER_RATE_LIMITED' });
    p.addRx({ date: ago(9), lines: [line('pcm')], pipeline: 'FAILED', failure: 'NO_MEDICINES_FOUND' });
    p.addRx({ date: ago(11), lines: [line('pcm')], pipeline: 'FAILED', failure: 'UNREADABLE_IMAGE', docKind: 'photo' });
    p.addRx({ date: ago(12), lines: [line('pcm')], pipeline: 'CANCELLED' });
    p.addUploadIntent('PENDING_FRESH');
    p.addUploadIntent('PENDING_EXPIRED');
    p.addUploadIntent('VERIFYING_STUCK');
    p.addUploadIntent('REJECTED', 'MAGIC_BYTES_MISMATCH');
    p.addUploadIntent('REJECTED', 'FILE_TOO_LARGE');
    p.addUploadIntent('REJECTED', 'TOO_MANY_PAGES');
    p.addUploadIntent('VERIFIED_CONSUMED');
  }

  // 14. Prescription rows in review states the current code never writes.
  {
    const p = b.addUser({ slug: 'review-states', persona: 'Prescriptions in DRAFT and DISCARDED review states', covers: ['Screens must hide or label non-confirmed prescriptions', 'No medicines or timeline from drafts'], fullName: 'Rhea Review', dob: utcDate(1999, 3, 3), gender: 'Female', bloodGroup: 'B+', createdAt: ago(20) });
    p.addRx({ date: ago(10), lines: [line('pan40'), line('ondem')], reviewStatus: 'DRAFT', diagnosis: 'Draft prescription' });
    p.addRx({ date: ago(9), lines: [line('azithral')], reviewStatus: 'DISCARDED', diagnosis: 'Discarded prescription' });
    p.addRx({ date: ago(8), lines: [line('cetzine')], diagnosis: 'Confirmed one, for contrast' });
  }

  // 15. Medicine lifecycle in every status and boundary.
  {
    const p = b.addUser({ slug: 'med-lifecycle', persona: 'Medicines in every status and boundary', covers: ['ACTIVE, PAUSED, COMPLETED, DISCONTINUED, INACTIVE', 'Active without reminders', 'Ends today, ended yesterday, starts tomorrow', 'Reminders at 00:00 and 23:59', 'Six reminders a day', 'Weekly and SOS medicines (no daily reminders)', 'User-added medicine with no prescription'], fullName: 'Meera Lifecycle', dob: utcDate(1983, 10, 10), gender: 'Female', bloodGroup: 'A+', createdAt: ago(200), adherence: 'good' });
    p.addRx({ date: ago(30), doctor: DOCTORS[0], diagnosis: 'Mixed statuses', current: true, lines: [
      line('telma40', { duration: 'continue' }),
      line('nexito', { status: 'PAUSED', duration: 'continue', notes: 'Paused before surgery' }),
      line('augmentin', { status: 'COMPLETED', duration: '7 days', reminderTimes: ['08:00', '20:00'] }),
      line('combiflam', { status: 'DISCONTINUED', discontinuedReason: 'Stomach pain', reminderTimes: ['09:00'] }),
      line('montairlc', { status: 'INACTIVE' }),
    ] });
    p.addRx({ date: ago(4), diagnosis: 'Ends today', current: true, lines: [line('cetzine', { duration: '5 days' })] });
    p.addRx({ date: ago(5), diagnosis: 'Ended yesterday, never marked complete', current: true, lines: [line('pand', { duration: '5 days' })] });
    p.addRx({ date: addDays(today, 1), diagnosis: 'Starts tomorrow', current: true, lines: [line('orofer', { duration: '3 months' })] });
    p.addRx({ date: ago(2), diagnosis: 'Midnight edges', current: true, lines: [line('pcm', { reminderTimes: ['00:00', '23:59'], duration: '10 days' })] });
    p.addRx({ date: ago(2), diagnosis: 'Six times a day', current: true, lines: [line('moxicip', { reminderTimes: ['06:00', '09:00', '12:00', '15:00', '18:00', '21:00'], duration: '7 days' })] });
    p.addRx({ date: ago(14), diagnosis: 'Weekly and SOS', current: true, lines: [line('folitrax', { duration: 'continue' }), line('uprised3'), line('asthalin', { frequency: '2 puffs SOS' })] });
    p.addRx({ date: ago(3), diagnosis: 'Active with reminders turned off', current: true, lines: [line('shelcal', { reminderTimes: [] })] });
    p.addRx({ date: ago(20), diagnosis: 'Tapering steroid', current: true, lines: [line('wysolone')] });
    p.addManualMedication({ med: med('chyawanprash'), written: 'Chyawanprash (added by me)', frequency: '1 tsp morning', start: ago(60), status: 'ACTIVE', reminderTimes: ['07:30'] });
    p.addManualMedication({ med: med('liv52'), start: null, status: 'INACTIVE', reminderTimes: null });
  }

  // 16. Adherence: every dose status and the Rule 15 case of never recording anything.
  for (const [slug, adherence, name] of [
    ['adherence-perfect', 'perfect', 'Aditi Perfect'],
    ['adherence-poor', 'poor', 'Ashok Poor'],
    ['adherence-never-records', 'never-records', 'Neel Never'],
  ] as const) {
    const p = b.addUser({ slug, persona: `Adherence: ${adherence}`, covers: adherence === 'never-records' ? ['Past doses stay unrecorded (PENDING): never shown as Taken or Missed (Rule 15)'] : ['Taken on time, late, skipped, missed, snoozed', 'Adherence summaries'], fullName: name, dob: utcDate(1970, 4, 4), gender: adherence === 'perfect' ? 'Female' : 'Male', bloodGroup: 'O+', createdAt: ago(150), adherence: adherence as Adherence });
    chronicRefills(b, p, ['glycomet', 'amlong', 'thyronorm50'], ago(140), 30, { diagnosis: 'T2DM, HTN, hypothyroid' });
  }

  // 17. Time zones and DST.
  for (const [slug, tz, name, times] of [
    ['tz-new-york', 'America/New_York', 'Nikhil NRI', ['02:30', '08:00', '20:00']],
    ['tz-chatham', 'Pacific/Chatham', 'Chaitali Chatham', ['00:15', '12:45']],
    ['tz-dubai', 'Asia/Dubai', 'Danish Dubai', ['08:00', '21:00']],
    ['tz-utc', 'UTC', 'Uday UTC', ['23:30']],
  ] as const) {
    const p = b.addUser({ slug, persona: `Time zone ${tz}`, covers: ['Reminder times across time zones', tz === 'America/New_York' ? '02:30 reminder skipped on the spring-forward day' : 'Offsets that are not whole hours or near midnight'], fullName: name, dob: utcDate(1987, 8, 8), gender: 'Male', bloodGroup: 'B+', timezone: tz, createdAt: ago(400) });
    p.addRx({ date: ago(250), doctor: DOCTORS[8], diagnosis: 'Chronic medicine across time zones', current: true, lines: [line('levipil', { duration: 'continue', reminderTimes: [...times] })] });
  }

  // 18. Duplicates and look-alikes.
  {
    const p = b.addUser({ slug: 'duplicates', persona: 'Same medicine many ways', covers: ['Same generic under different brands (Dolo, Crocin, Calpol, PCM)', 'Same brand, different strengths', 'Same prescription confirmed twice', 'Two active copies of one medicine'], fullName: 'Deepak Duplicate', dob: utcDate(1980, 1, 20), gender: 'Male', bloodGroup: 'AB-', createdAt: ago(365) });
    for (const k of ['dolo650', 'crocin', 'calpol', 'pcm', 'combiflam']) p.addRx({ date: rng.dateBetween(ago(300), ago(30)), diagnosis: 'Fever', lines: [line(k)] });
    p.addRx({ date: ago(100), lines: [line('thyronorm50')] });
    p.addRx({ date: ago(50), lines: [line('thyronorm75')] });
    p.addRx({ date: ago(10), lines: [line('eltroxin')], current: true });
    const twice = { date: ago(7), doctor: DOCTORS[6], clinic: CLINICS[8], diagnosis: 'Confirmed twice', lines: [line('pan40', { duration: '14 days' })], current: true };
    const first = p.addRx(twice);
    p.addRx({ ...twice, sameBytesAs: first.documentId });
  }

  // 19. Every route and dosage form.
  {
    const p = b.addUser({ slug: 'all-routes', persona: 'Every route and dosage form', covers: ['Oral, topical, IV, IM, SC, inhaled, eye, nose, ear, rectal, other', 'Units, puffs, drops, ml, sachets', 'Traditional medicines with no generic name'], fullName: 'Rohan Routes', dob: utcDate(1977, 7, 7), gender: 'Male', bloodGroup: 'A+', createdAt: ago(120) });
    const keys = ['monocef', 'b12inj', 'lantus', 'clexane', 'foracort', 'budecort', 'moxicip', 'otrivin', 'ciplox', 'betnovatec', 'luliconazole', 'dulcolax', 'susten', 'electral', 'liv52', 'arnica', 'septilin'];
    p.addRx({ date: ago(12), doctor: DOCTORS[0], clinic: CLINICS[9], diagnosis: 'All routes', lines: keys.map((k) => line(k)), current: true, docKind: 'pdf', pages: 2 });
  }

  // 20. Two near-identical accounts for cross-patient isolation tests.
  for (const slug of ['isolation-a', 'isolation-b']) {
    const p = b.addUser({ slug, persona: 'Twin account for cross-patient tests', covers: ['Use one account\'s IDs from the other: every call must return 404 (Rule 4)'], fullName: `Twin ${slug.slice(-1).toUpperCase()}`, dob: utcDate(1991, 9, 19), gender: 'Female', bloodGroup: 'O+', createdAt: ago(90) });
    p.addRx({ date: ago(30), doctor: DOCTORS[1], clinic: CLINICS[1], diagnosis: 'Same story, different patient', lines: [line('augmentin'), line('pan40')], current: false });
    p.addRx({ date: ago(3), doctor: DOCTORS[1], clinic: CLINICS[1], diagnosis: 'Current', lines: [line('montairlc', { duration: '10 days' })], current: true });
  }

  // 21. Long chronic history: refills since 2000.
  {
    const p = b.addUser({ slug: 'chronic', persona: 'Diabetes and hypertension since 2000', covers: ['Long refill history', 'Dose changes over years', 'Lab and BP trends (later phases)'], fullName: 'Suresh Chronic', dob: utcDate(1955, 5, 25), gender: 'Male', bloodGroup: 'B+', createdAt: yearsAgo(20), adherence: 'good' });
    chronicRefills(b, p, ['glycomet', 'telma40'], utcDate(2000, 3, 15), 90, { diagnosis: 'T2DM, HTN' });
    p.addRx({ date: ago(20), diagnosis: 'Statin added', lines: [line('rosuvas', { duration: 'continue' })], current: true });
    setFuture(b, p, (f) => {
      f.conditions.push({ name: 'Type 2 diabetes', onset: '2000-03', onsetPrecision: 'MONTH', status: 'ACTIVE' }, { name: 'Hypertension', onset: '2000', onsetPrecision: 'YEAR', status: 'ACTIVE' }, { name: 'Gallstones', onset: '2012-08-14', onsetPrecision: 'EXACT', status: 'RESOLVED' });
      f.measurements = measurementSeries(rng, now, { days: 730, diabetic: true, hypertensive: true, deviceShare: 0.3 });
      f.labResults = labPanels(rng, now, 10, true);
      f.emergency = emergencyContacts(rng, ['Sunita Chronic', 'Amit Chronic']);
    });
  }

  // 22. Allergy conflicts for Phase 16.
  {
    const p = b.addUser({ slug: 'allergy-conflicts', persona: 'Allergic to penicillin and NSAIDs, yet prescribed them', covers: ['Allergy warnings against prescribed medicines (Phase 16)', 'Resolved and refuted allergies'], fullName: 'Aarti Allergy', dob: utcDate(1993, 12, 12), gender: 'Female', bloodGroup: 'A-', createdAt: ago(300) });
    p.addRx({ date: ago(4), doctor: DOCTORS[0], diagnosis: 'Pharyngitis', lines: [line('augmentin'), line('combiflam')], current: true });
    p.addRx({ date: ago(200), lines: [line('septran')] });
    setFuture(b, p, (f) => {
      f.allergies.push(
        { substance: 'Penicillin', class: 'PENICILLIN', reaction: 'Hives and lip swelling', severity: 'SEVERE', recordedOn: '2015-04-02', status: 'ACTIVE' },
        { substance: 'Ibuprofen', class: 'NSAID', reaction: 'Wheezing', severity: 'MODERATE', recordedOn: null, status: 'ACTIVE' },
        { substance: 'Sulfa drugs', class: 'SULFA', reaction: 'Rash (doubtful)', severity: 'UNKNOWN', recordedOn: '2020-01-01', status: 'REFUTED' },
        { substance: 'Peanuts', reaction: 'Itching', severity: 'MILD', recordedOn: '2005-06-06', status: 'RESOLVED' },
      );
    });
  }

  // 23. Pregnancy for later safety checks.
  {
    const p = b.addUser({ slug: 'pregnant', persona: 'Pregnant, 18 weeks', covers: ['Pregnancy flag for medicine safety (later phases)', 'Antenatal prescriptions'], fullName: 'Pooja Shah', dob: utcDate(1997, 2, 14), gender: 'Female', bloodGroup: 'O+', createdAt: ago(130) });
    p.addRxFromTemplate(template('HW-16'));
    p.addRx({ date: ago(10), doctor: DOCTORS[1], clinic: CLINICS[11], diagnosis: 'Antenatal care, 18 weeks', lines: [line('orofer'), line('shelcal'), line('folvite')], current: true });
    setFuture(b, p, (f) => {
      f.pregnancy = { status: 'PREGNANT', lmp: isoDay(ago(126)), edd: isoDay(addDays(today, 154)) };
      f.family.push({ relation: 'Child', seedEmail: 'newborn@seed.ayoreni.test', name: 'Baby of Pooja Shah', role: 'DEPENDENT' });
    });
  }

  // 24. Caregiver who manages others (Phase 24): own record is thin.
  {
    const p = b.addUser({ slug: 'caregiver', persona: 'Caregiver for a parent and a child', covers: ['Family and caregiver links (Phase 24)', 'Switching between patients'], fullName: 'Ravi Ramaswamy', dob: utcDate(1968, 1, 26), gender: 'Male', bloodGroup: 'A+', createdAt: ago(500) });
    p.addRx({ date: ago(100), lines: [line('allegra')] });
    setFuture(b, p, (f) => {
      f.family.push({ relation: 'Mother', seedEmail: 'elderly-polypharmacy@seed.ayoreni.test', name: 'Kamala Devi Ramaswamy', role: 'DEPENDENT' }, { relation: 'Daughter', seedEmail: null, name: 'Riya Ramaswamy', role: 'DEPENDENT' });
    });
  }

  // 25. Records older than the default range.
  {
    const p = b.addUser({ slug: 'historical', persona: 'Records from 1985 onwards', covers: ['Timeline before 2000', 'Old brands, faded paper (HW-11)'], fullName: 'Hemant Historical', dob: utcDate(1950, 1, 1), gender: 'Male', bloodGroup: 'O+', createdAt: yearsAgo(3) });
    for (const y of [1985, 1991, 1996, 1999]) p.addRx({ date: utcDate(y, rng.int(1, 12), rng.int(1, 28)), doctor: rng.pick(DOCTORS), lines: [line(rng.pick(['rantac', 'becosules', 'pcm', 'metrogyl']))], docKind: 'photo', dateUncertain: y < 1990 });
    p.addRxFromTemplate(template('HW-11'));
  }

  // 26. Many concurrent active short courses: Today screen crowded right now.
  {
    const p = b.addUser({ slug: 'busy-today', persona: 'Crowded Today: 3 doctors in one week', covers: ['Many doses due right now', 'Overlapping courses from different doctors', 'Snoozed doses in the last hours'], fullName: 'Bhavna Busy', dob: utcDate(1990, 6, 6), gender: 'Female', bloodGroup: 'B+', createdAt: ago(40), adherence: 'patchy' });
    p.addRx({ date: ago(5), doctor: DOCTORS[0], diagnosis: 'Typhoid fever', lines: [line('zifi', { duration: '14 days' }), line('dolo650', { duration: '7 days' }), line('pan40', { duration: '14 days' })], current: true });
    p.addRx({ date: ago(3), doctor: DOCTORS[6], diagnosis: 'Fungal infection', lines: [line('luliconazole'), line('cetzine', { duration: '10 days' })], current: true });
    p.addRx({ date: ago(1), doctor: DOCTORS[5], diagnosis: 'Conjunctivitis', lines: [line('moxicip'), line('refresh')], current: true });
  }
}

/** Ordinary random users: the bulk of the data. */
export function buildBulkUsers(b: WorldBuilder): void {
  const rng = b.rng;
  const now = b.now;
  const today = startOfUtcDay(now);

  for (let i = 1; i <= b.opts.bulkUsers; i++) {
    const female = rng.bool(0.52);
    const first = rng.pick(female ? FIRST_NAMES_F : FIRST_NAMES_M);
    const fullName = `${first} ${rng.pick(SURNAMES)}`;
    const age = rng.weighted<[number, number]>([[[0, 12], 1], [[13, 25], 2], [[26, 45], 4], [[46, 65], 3], [[66, 95], 2]]);
    const dob = utcDate(today.getUTCFullYear() - rng.int(age[0], age[1]), rng.int(1, 12), rng.int(1, 28));
    const joined = rng.dateBetween(utcDate(2019, 1, 1), addDays(today, -1));
    const historyStart = new Date(Math.max(dob.getTime(), rng.dateBetween(utcDate(2000, 1, 1), joined).getTime()));
    const adherence = rng.weighted<Adherence>([['perfect', 1], ['good', 5], ['patchy', 3], ['poor', 1], ['never-records', 1]]);

    const p = b.addUser({
      slug: `user${String(i).padStart(4, '0')}`,
      persona: 'Bulk random user',
      covers: [],
      fullName,
      dob: rng.bool(0.93) ? dob : null,
      gender: rng.bool(0.95) ? (female ? 'Female' : 'Male') : null,
      bloodGroup: rng.bool(0.7) ? rng.pick(BLOOD_GROUPS) : null,
      timezone: rng.bool(0.95) ? 'Asia/Kolkata' : rng.pick(['Asia/Dubai', 'Europe/London', 'America/Chicago', 'Asia/Singapore']),
      createdAt: joined,
      adherence,
      notificationsEnabled: rng.bool(0.85),
      dailySummaryTime: rng.pick(['07:00', '08:00', '09:30', null]),
    });

    const target = rng.weighted<number>([[0, 1], [rng.int(1, 3), 3], [rng.int(4, 12), 4], [rng.int(13, b.opts.maxRxPerUser), 2]]);
    let made = 0;

    if (age[0] >= 26 && rng.bool(age[0] >= 46 ? 0.6 : 0.2) && target > 3) {
      const plan = rng.pick(CHRONIC_PLANS);
      const since = rng.dateBetween(historyStart, addDays(today, -90));
      const every = rng.pick([30, 60, 90]);
      const count = Math.min(Math.floor(target * 0.6), Math.floor((today.getTime() - since.getTime()) / (every * 86_400_000)));
      const start = addDays(today, -every * Math.max(1, count));
      chronicRefills(b, p, [...plan.meds], start, every, { diagnosis: plan.condition });
      made += Math.max(1, count);
    }

    while (made < target) {
      const recent = rng.bool(0.12);
      const date = recent ? addDays(today, -rng.int(0, 6)) : rng.dateBetween(historyStart, addDays(today, -10));
      const roll = rng.next();
      if (roll < 0.04) {
        p.addRx({ date, lines: [{ med: rng.pick(MEDICINES) }], pipeline: rng.pick(['READY_FOR_REVIEW', 'FAILED', 'UPLOADED'] as const), uploadedAt: addDays(today, -rng.int(0, 3)) });
      } else if (roll < 0.1) {
        p.addRxFromTemplate(rng.pick(HANDWRITTEN_TEMPLATES));
      } else if (roll < 0.13) {
        p.addRx({ date: null, lines: [{ med: rng.pick(MEDICINES) }], diagnosis: null });
      } else {
        acuteVisit(b, p, date, recent);
      }
      made++;
    }
  }
}
