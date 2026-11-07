import { Rng } from './rng.js';
import { DAY, addDays, isoDay } from './time.js';

/**
 * Data for phases that have no tables yet (allergies, conditions, measurements, labs, symptoms,
 * vaccinations, emergency card, family links). The seed exports it as JSON with `--export`; each
 * later phase adds a writer for its own part, so testers keep the same people and stories.
 */
export interface FutureData {
  allergies: Array<{ substance: string; class?: string; reaction: string; severity: 'MILD' | 'MODERATE' | 'SEVERE' | 'UNKNOWN'; recordedOn: string | null; status: 'ACTIVE' | 'RESOLVED' | 'REFUTED' }>;
  conditions: Array<{ name: string; onset: string | null; onsetPrecision: 'EXACT' | 'MONTH' | 'YEAR' | 'UNKNOWN'; status: 'ACTIVE' | 'RESOLVED' | 'IN_REMISSION' }>;
  measurements: Array<{ type: 'BP' | 'GLUCOSE_FASTING' | 'GLUCOSE_PP' | 'WEIGHT' | 'SPO2' | 'PULSE' | 'TEMPERATURE' | 'HEIGHT'; value: string; unit: string; takenAt: string; source: 'MANUAL' | 'DEVICE' }>;
  labResults: Array<{ panel: string; test: string; value: string; unit: string; refRange: string; flag: 'NORMAL' | 'HIGH' | 'LOW' | 'CRITICAL' | 'UNREADABLE'; date: string }>;
  symptoms: Array<{ name: string; severity: 1 | 2 | 3 | 4 | 5; startedAt: string; endedAt: string | null; note: string | null }>;
  vaccinations: Array<{ vaccine: string; dose: string; date: string | null; datePrecision: 'EXACT' | 'YEAR' | 'UNKNOWN' }>;
  emergency: { contacts: Array<{ name: string; relation: string; phone: string }>; organDonor: boolean | null; notes: string | null };
  family: Array<{ relation: string; seedEmail: string | null; name: string; role: 'DEPENDENT' | 'CAREGIVER' | 'VIEWER' }>;
  pregnancy?: { status: 'PREGNANT' | 'POSTPARTUM' | 'NONE'; lmp: string | null; edd: string | null };
}

export function emptyFuture(): FutureData {
  return { allergies: [], conditions: [], measurements: [], labResults: [], symptoms: [], vaccinations: [], emergency: { contacts: [], organDonor: null, notes: null }, family: [] };
}

/** Synthetic phone numbers use the 99999 0xxxx block so they never collide with a real person. */
function fakePhone(rng: Rng): string {
  return `+91 99999 0${rng.int(1000, 9999)}`;
}

export function measurementSeries(
  rng: Rng,
  now: Date,
  opts: { days: number; diabetic?: boolean; hypertensive?: boolean; everyNDays?: number; deviceShare?: number },
): FutureData['measurements'] {
  const out: FutureData['measurements'] = [];
  const step = opts.everyNDays ?? 1;
  let weight = rng.int(48, 96) + rng.next();
  for (let d = opts.days; d >= 0; d -= step) {
    const day = new Date(now.getTime() - d * DAY);
    const at = (h: number) => new Date(day.getTime() - (day.getTime() % DAY) + h * 3_600_000 - 330 * 60_000).toISOString();
    const source = rng.bool(opts.deviceShare ?? 0.2) ? 'DEVICE' : 'MANUAL';
    if (opts.diabetic) {
      out.push({ type: 'GLUCOSE_FASTING', value: String(rng.int(85, 190) + (rng.bool(0.03) ? 200 : 0)), unit: 'mg/dL', takenAt: at(7), source });
      if (rng.bool(0.5)) out.push({ type: 'GLUCOSE_PP', value: String(rng.int(120, 280) + (rng.bool(0.02) ? -90 : 0)), unit: 'mg/dL', takenAt: at(10), source });
    }
    if (opts.hypertensive || rng.bool(0.1)) {
      const sys = rng.int(112, 168) + (rng.bool(0.02) ? 40 : 0);
      out.push({ type: 'BP', value: `${sys}/${rng.int(70, 102)}`, unit: 'mmHg', takenAt: at(8), source });
      out.push({ type: 'PULSE', value: String(rng.int(58, 104)), unit: 'bpm', takenAt: at(8), source });
    }
    if (d % 7 === 0) {
      weight += (rng.next() - 0.5) * 0.8;
      out.push({ type: 'WEIGHT', value: weight.toFixed(1), unit: 'kg', takenAt: at(7), source });
    }
  }
  return out;
}

export function labPanels(rng: Rng, now: Date, years: number, diabetic: boolean): FutureData['labResults'] {
  const out: FutureData['labResults'] = [];
  for (let q = 0; q < years * 2; q++) {
    const date = isoDay(addDays(now, -q * 182 - rng.int(0, 30)));
    const hba1c = diabetic ? 6.4 + rng.next() * 3.4 : 4.9 + rng.next() * 0.8;
    out.push({ panel: 'HbA1c', test: 'HbA1c', value: hba1c.toFixed(1), unit: '%', refRange: '4.0-5.6', flag: hba1c > 5.6 ? 'HIGH' : 'NORMAL', date });
    const ldl = rng.int(70, 190);
    out.push({ panel: 'Lipid profile', test: 'LDL cholesterol', value: String(ldl), unit: 'mg/dL', refRange: '<100', flag: ldl >= 100 ? 'HIGH' : 'NORMAL', date });
    const hb = 9 + rng.next() * 7;
    out.push({ panel: 'CBC', test: 'Haemoglobin', value: hb.toFixed(1), unit: 'g/dL', refRange: '12.0-16.0', flag: hb < 8 ? 'CRITICAL' : hb < 12 ? 'LOW' : 'NORMAL', date });
    const tsh = 0.2 + rng.next() * 9;
    out.push({ panel: 'Thyroid profile', test: 'TSH', value: tsh.toFixed(2), unit: 'µIU/mL', refRange: '0.4-4.0', flag: tsh > 4 ? 'HIGH' : tsh < 0.4 ? 'LOW' : 'NORMAL', date });
    if (rng.bool(0.1)) out.push({ panel: 'KFT', test: 'Creatinine', value: '?', unit: 'mg/dL', refRange: '0.6-1.2', flag: 'UNREADABLE', date });
  }
  return out;
}

export function emergencyContacts(rng: Rng, names: readonly string[]): FutureData['emergency'] {
  return {
    contacts: rng.pickN(names, rng.int(1, 2)).map((n, i) => ({ name: n, relation: i === 0 ? 'Spouse' : 'Child', phone: fakePhone(rng) })),
    organDonor: rng.pick([true, false, null]),
    notes: null,
  };
}
