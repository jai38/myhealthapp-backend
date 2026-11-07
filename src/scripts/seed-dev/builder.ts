import type { Prisma, MedicationStatus, DoseStatus } from '@prisma/client';
import { Rng } from './rng.js';
import { CatalogMedicine, med as catalogMed } from './catalog.js';
import { HandwrittenTemplate } from './handwritten-templates.js';
import { DAY, HOUR, MINUTE, addDays, isoDay, localDay, startOfUtcDay, zonedToUtc } from './time.js';
import type { FutureData } from './future.js';

/** Every seeded account uses this domain. `.test` is reserved (RFC 2606): it can never be a real inbox. */
export const SEED_EMAIL_DOMAIN = 'seed.ayoreni.test';
/** Replaced by one real bcrypt hash at write time, so the generator stays fast and pure. */
export const PASSWORD_HASH_PLACEHOLDER = '__SEED_PASSWORD_HASH__';
export const SEED_PROVIDER_NAME = 'seed-synthetic';

export type Adherence = 'perfect' | 'good' | 'patchy' | 'poor' | 'never-records';
export type Pipeline = 'CONFIRMED' | 'READY_FOR_REVIEW' | 'EXTRACTING' | 'EXTRACTING_STUCK' | 'UPLOADED' | 'FAILED' | 'CANCELLED';

export interface DocFile {
  kind: 'pdf' | 'png';
  /** Handwritten template id, when the placeholder will later be swapped for a generated image. */
  templateId?: string;
  heading: string;
  lines: string[];
  pages: number;
  /** Re-use another document's bytes: tests duplicate uploads (same SHA-256). */
  sameBytesAs?: string;
}

export interface PersonaSummary {
  email: string;
  persona: string;
  covers: string[];
}

export interface World {
  users: Prisma.UserCreateManyInput[];
  profiles: Prisma.PatientProfileCreateManyInput[];
  preferences: Prisma.UserPreferencesCreateManyInput[];
  documents: Prisma.DocumentCreateManyInput[];
  uploadIntents: Prisma.UploadIntentCreateManyInput[];
  jobs: Prisma.ExtractionJobCreateManyInput[];
  prescriptions: Prisma.PrescriptionCreateManyInput[];
  items: Prisma.PrescriptionItemCreateManyInput[];
  timeline: Prisma.TimelineEventCreateManyInput[];
  medications: Prisma.MedicationCreateManyInput[];
  doses: Prisma.DoseLogCreateManyInput[];
  audits: Prisma.AuditEventCreateManyInput[];
  files: Map<string, DocFile>;
  personas: PersonaSummary[];
  future: Record<string, FutureData>;
}

export interface SeedOptions {
  seed: number;
  bulkUsers: number;
  maxRxPerUser: number;
  now: Date;
  /** How far back dose logs go for medicines that are or were active. */
  doseHistoryDays: number;
}

export interface UserSpec {
  slug: string;
  persona: string;
  covers: string[];
  fullName: string;
  dob: Date | null;
  gender: string | null;
  bloodGroup: string | null;
  createdAt: Date;
  timezone?: string;
  notificationsEnabled?: boolean;
  dailySummaryTime?: string | null;
  isVerified?: boolean;
  authProvider?: 'EMAIL' | 'GOOGLE' | 'APPLE';
  noPassword?: boolean;
  passwordChangedAt?: Date;
  adherence?: Adherence;
  /** Create no PatientProfile at all (sign-up interrupted before onboarding). */
  noProfile?: boolean;
}

export interface RxLine {
  med: CatalogMedicine;
  written?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
  uncertain?: boolean;
  /** Override the medicine status the confirmation produces. */
  status?: MedicationStatus;
  /** Override reminder times. An empty list means active without reminders. */
  reminderTimes?: string[] | null;
  /** For PAUSED / DISCONTINUED / COMPLETED: when that happened. */
  endedAt?: Date;
  discontinuedReason?: string;
  notes?: string;
}

export interface RxSpec {
  date: Date | null;
  dateUncertain?: boolean;
  doctor?: string | null;
  clinic?: string | null;
  diagnosis?: string | null;
  lines: RxLine[];
  docKind?: 'photo' | 'pdf' | 'handwritten';
  templateId?: string;
  pages?: number;
  pipeline?: Pipeline;
  reviewStatus?: 'CONFIRMED' | 'DRAFT' | 'DISCARDED';
  uploadedAt?: Date;
  /** The patient marked these medicines as currently taken during review. */
  current?: boolean;
  failure?: string;
  warnings?: string[];
  notes?: string;
  sameBytesAs?: string;
  originalFilename?: string;
}

export interface RxResult {
  documentId: string;
  jobId: string;
  prescriptionId?: string;
  medicationIds: string[];
}

const FREQ_TIMES: ReadonlyArray<readonly [RegExp, string[]]> = [
  [/weekly|once a week|week\b|sunday|monday only|alternate/i, []],
  [/\bsos\b|stat|single|as needed|prn|if /i, []],
  [/qid|4 times|four times|2 hourly|6 times/i, ['07:00', '12:00', '17:00', '22:00']],
  [/^1-1-1|tds|tid|three|8 hourly|6 hrly|6 hourly|10ml tds|5 ml tds/i, ['08:00', '14:00', '20:00']],
  [/^1-0-1|bd|twice|^1-0-½|^½-0-½|18 u/i, ['08:00', '20:00']],
  [/^0-0-1|hs|bedtime|night|0-0-12/i, ['21:30']],
  [/^0-1-0|lunch/i, ['13:00']],
  [/^1-0-0|^od\b|morning|bbf|empty stomach|before breakfast/i, ['08:00']],
];

export function reminderTimesFor(frequency: string | undefined): string[] {
  if (!frequency) return ['09:00'];
  for (const [pattern, times] of FREQ_TIMES) {
    if (pattern.test(frequency.trim())) return [...times];
  }
  return ['09:00'];
}

/** Days covered by a written duration, or null when open-ended or unreadable. */
export function durationDays(text: string | undefined): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const n = Number((t.match(/(\d+)/) ?? [])[1]);
  if (!Number.isFinite(n) || n <= 0) return /single/.test(t) ? 1 : null;
  if (/week|wk/.test(t)) return n * 7;
  if (/month|mo\b|माह/.test(t)) return n * 30;
  if (/year|yr/.test(t)) return n * 365;
  if (/day|\bd\b|\dd\b|दिन/.test(t)) return n;
  return null;
}

const DOSE_MIX: Record<Adherence, ReadonlyArray<readonly [DoseStatus | 'TAKEN_LATE', number]>> = {
  perfect: [['TAKEN', 100]],
  good: [['TAKEN', 86], ['TAKEN_LATE', 5], ['SKIPPED', 3], ['MISSED', 2], ['PENDING', 4]],
  patchy: [['TAKEN', 55], ['TAKEN_LATE', 10], ['SKIPPED', 8], ['MISSED', 7], ['PENDING', 20]],
  poor: [['TAKEN', 20], ['TAKEN_LATE', 5], ['SKIPPED', 10], ['MISSED', 15], ['PENDING', 50]],
  // Rule 15: an unrecorded past dose stays PENDING. It is never presumed Taken or Missed.
  'never-records': [['PENDING', 100]],
};

export class WorldBuilder {
  readonly world: World = {
    users: [], profiles: [], preferences: [], documents: [], uploadIntents: [], jobs: [], prescriptions: [],
    items: [], timeline: [], medications: [], doses: [], audits: [], files: new Map(), personas: [], future: {},
  };

  constructor(readonly rng: Rng, readonly opts: SeedOptions) {}

  get now(): Date {
    return this.opts.now;
  }

  addUser(spec: UserSpec): Patient {
    const userId = this.rng.uuid();
    const profileId = this.rng.uuid();
    const email = `${spec.slug}@${SEED_EMAIL_DOMAIN}`;
    const tz = spec.timezone ?? 'Asia/Kolkata';

    this.world.users.push({
      id: userId,
      email,
      passwordHash: spec.noPassword ? null : PASSWORD_HASH_PLACEHOLDER,
      passwordChangedAt: spec.passwordChangedAt ?? null,
      authProvider: spec.authProvider ?? 'EMAIL',
      isVerified: spec.isVerified ?? true,
      createdAt: spec.createdAt,
      updatedAt: spec.createdAt,
    });
    this.world.audits.push({ id: this.rng.uuid(), userId, action: 'USER_SIGNED_UP', resourceType: 'USER', resourceId: userId, createdAt: spec.createdAt });
    if (spec.isVerified ?? true) {
      this.world.audits.push({ id: this.rng.uuid(), userId, action: 'EMAIL_VERIFIED', resourceType: 'USER', resourceId: userId, createdAt: new Date(spec.createdAt.getTime() + 5 * MINUTE) });
    }

    if (!spec.noProfile) {
      this.world.profiles.push({
        id: profileId,
        userId,
        fullName: spec.fullName,
        dateOfBirth: spec.dob,
        gender: spec.gender,
        bloodGroup: spec.bloodGroup,
        isPrimaryAccountHolder: true,
        createdAt: spec.createdAt,
        updatedAt: spec.createdAt,
      });
      this.world.preferences.push({
        id: this.rng.uuid(),
        patientProfileId: profileId,
        preferredTimezone: tz,
        notificationsEnabled: spec.notificationsEnabled ?? true,
        dailySummaryTime: spec.dailySummaryTime === undefined ? '08:00' : spec.dailySummaryTime,
        createdAt: spec.createdAt,
        updatedAt: spec.createdAt,
      });
    }

    this.world.personas.push({ email, persona: spec.persona, covers: spec.covers });
    return new Patient(this, { userId, profileId, email, tz, adherence: spec.adherence ?? 'good', createdAt: spec.createdAt, hasProfile: !spec.noProfile });
  }
}

interface PatientInit {
  userId: string;
  profileId: string;
  email: string;
  tz: string;
  adherence: Adherence;
  createdAt: Date;
  hasProfile: boolean;
}

export class Patient {
  constructor(private readonly b: WorldBuilder, readonly info: PatientInit) {}

  private get rng(): Rng {
    return this.b.rng;
  }

  private get w(): World {
    return this.b.world;
  }

  /** Upload time for a prescription dated `date`: usually days to years later (people upload old papers). */
  private uploadTimeFor(date: Date | null): Date {
    const now = this.b.now;
    const floor = Math.max(this.info.createdAt.getTime(), date ? date.getTime() : this.info.createdAt.getTime());
    const lag = this.rng.weighted<number>([[0, 4], [1, 3], [7, 2], [60, 1]]) * DAY + this.rng.int(0, 20) * HOUR;
    return new Date(Math.min(now.getTime() - MINUTE, floor + lag));
  }

  addRx(spec: RxSpec): RxResult {
    if (!this.info.hasProfile) throw new Error('addRx on a user without a profile');
    const rng = this.rng;
    const pid = this.info.profileId;
    const pipeline: Pipeline = spec.pipeline ?? 'CONFIRMED';
    const uploadedAt = spec.uploadedAt ?? this.uploadTimeFor(spec.date);
    const documentId = rng.uuid();
    const jobId = rng.uuid();
    const kind = spec.docKind ?? rng.weighted<'photo' | 'pdf'>([['photo', 6], ['pdf', 4]]);
    const isPdf = kind === 'pdf';
    const pages = isPdf ? spec.pages ?? 1 : 1;

    const docStatus: Prisma.DocumentCreateManyInput['status'] =
      pipeline === 'CONFIRMED' ? (spec.reviewStatus === 'DRAFT' ? 'READY_FOR_REVIEW' : 'CONFIRMED')
        : pipeline === 'EXTRACTING_STUCK' ? 'EXTRACTING'
        : pipeline === 'CANCELLED' ? 'FAILED'
        : pipeline;

    const filename = spec.originalFilename
      ?? (spec.templateId ? `seed-${spec.templateId.toLowerCase()}.png` : isPdf ? `prescription-${isoDay(uploadedAt)}.pdf` : `IMG_${isoDay(uploadedAt).replace(/-/g, '')}_${rng.int(1000, 9999)}.png`);

    this.w.documents.push({
      id: documentId,
      patientProfileId: pid,
      storageKey: `documents/${pid}/${rng.uuid()}`,
      originalFilename: filename,
      mimeType: isPdf ? 'application/pdf' : 'image/png',
      // Size, checksum and dimensions are filled from the generated bytes at write time.
      fileSizeBytes: 0,
      sha256Checksum: '',
      status: docStatus,
      pageCount: isPdf ? pages : null,
      imageWidth: isPdf ? null : 0,
      imageHeight: isPdf ? null : 0,
      uploadedAt,
      updatedAt: uploadedAt,
    });

    const medNames = spec.lines.map((l) => `${l.written ?? l.med.written}  ${l.frequency ?? ''}  ${l.duration ?? ''}`.trim());
    this.w.files.set(documentId, {
      kind: isPdf ? 'pdf' : 'png',
      templateId: spec.templateId,
      heading: spec.clinic ?? spec.doctor ?? 'Prescription',
      lines: [
        spec.doctor ?? 'Doctor: not written',
        `Date: ${spec.date ? isoDay(spec.date) : 'not written'}`,
        spec.diagnosis ? `Dx: ${spec.diagnosis}` : '',
        ...medNames.map((m, i) => `${i + 1}. ${m}`),
        spec.notes ?? '',
      ].filter(Boolean),
      pages,
      sameBytesAs: spec.sameBytesAs,
    });

    const payload = {
      prescription_date: spec.date && !(spec.dateUncertain && rng.bool(0.3)) ? isoDay(spec.date) : undefined,
      date_is_uncertain: spec.dateUncertain ?? spec.date === null,
      doctor_name: spec.doctor ?? undefined,
      clinic_hospital_name: spec.clinic ?? undefined,
      documented_diagnosis: spec.diagnosis ?? undefined,
      medicines: spec.lines.map((l) => ({
        name_as_written: l.written ?? l.med.written,
        normalized_medicine_name: l.uncertain ? undefined : l.med.generic ?? undefined,
        strength: l.uncertain ? undefined : l.med.strength ?? undefined,
        dosage_form: l.med.form,
        frequency_text: l.frequency,
        duration_text: l.duration,
        route: l.med.route,
        instructions: l.instructions,
        confidence: l.uncertain ? 'UNCERTAIN' : 'HIGH',
        source_page: Math.min(pages, 1 + Math.floor(rng.next() * pages)),
      })),
      unparsed_notes: spec.notes,
      validation_warnings: spec.warnings ?? [
        ...(spec.date === null ? ['Prescription date not found on the document.'] : []),
        ...spec.lines.filter((l) => l.uncertain).map((l) => `Unclear handwriting for "${l.written ?? l.med.written}". Please check.`),
      ],
    };
    const strip = (o: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(o)) as Prisma.InputJsonValue;

    const job: Prisma.ExtractionJobCreateManyInput = {
      id: jobId,
      patientProfileId: pid,
      documentId,
      idempotencyKey: `seed-${documentId}`,
      providerName: SEED_PROVIDER_NAME,
      status: 'QUEUED',
      createdAt: uploadedAt,
      updatedAt: uploadedAt,
    };
    const started = new Date(uploadedAt.getTime() + rng.int(2, 180) * 1000);
    const finished = new Date(started.getTime() + rng.int(4, 60) * 1000);
    switch (pipeline) {
      case 'UPLOADED':
        break;
      case 'EXTRACTING':
        Object.assign(job, { status: 'PROCESSING', startedAt: started });
        break;
      case 'EXTRACTING_STUCK':
        Object.assign(job, { status: 'PROCESSING', startedAt: started, retryCount: 1 });
        break;
      case 'FAILED':
        Object.assign(job, { status: 'FAILED', startedAt: started, completedAt: finished, retryCount: 3, errorMessage: spec.failure ?? 'PROVIDER_TIMEOUT' });
        break;
      case 'CANCELLED':
        Object.assign(job, { status: 'CANCELLED', startedAt: started, completedAt: finished, errorMessage: spec.failure ?? 'CANCELLED_BY_USER' });
        break;
      default:
        Object.assign(job, { status: 'SUCCEEDED', startedAt: started, completedAt: finished, extractedPayload: strip(payload) });
    }
    this.w.jobs.push(job);

    const result: RxResult = { documentId, jobId, medicationIds: [] };
    if (pipeline !== 'CONFIRMED') return result;

    const reviewStatus = spec.reviewStatus ?? 'CONFIRMED';
    const confirmedAt = new Date(finished.getTime() + rng.int(1, 600) * MINUTE / 10);
    job.confirmedAt = reviewStatus === 'CONFIRMED' ? confirmedAt : null;
    const prescriptionId = rng.uuid();
    result.prescriptionId = prescriptionId;
    this.w.prescriptions.push({
      id: prescriptionId,
      patientProfileId: pid,
      documentId,
      jobId,
      prescriptionDate: spec.date ? startOfUtcDay(spec.date) : null,
      dateIsUncertain: spec.dateUncertain ?? spec.date === null,
      doctorName: spec.doctor ?? null,
      clinicHospitalName: spec.clinic ?? null,
      diagnosis: spec.diagnosis ?? null,
      reviewStatus,
      confirmedAt,
      confirmedByUserId: this.info.userId,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
    });

    const current = Boolean(spec.current) && reviewStatus === 'CONFIRMED';
    const start = spec.date ? startOfUtcDay(spec.date) : null;

    for (const line of spec.lines) {
      const itemId = rng.uuid();
      const isActive = current && line.status !== 'INACTIVE';
      this.w.items.push({
        id: itemId,
        prescriptionId,
        nameAsWritten: line.written ?? line.med.written,
        normalizedMedicineName: line.uncertain ? null : line.med.generic,
        strength: line.uncertain ? null : line.med.strength,
        dosageForm: line.med.form,
        frequencyText: line.frequency ?? null,
        durationText: line.duration ?? null,
        route: line.med.route,
        instructions: line.instructions ?? null,
        // Rule 11: only what the patient marks as current is active. Historical prescriptions stay false.
        isActiveMedication: isActive,
        sourceDocumentId: documentId,
        createdAt: confirmedAt,
        updatedAt: confirmedAt,
      });
      if (reviewStatus !== 'CONFIRMED') continue;

      const medId = this.addMedicationRow({
        line,
        itemId,
        prescriptionId,
        documentId,
        start,
        createdAt: confirmedAt,
        status: line.status ?? (isActive ? 'ACTIVE' : this.historicalStatus(line, start)),
      });
      result.medicationIds.push(medId);
    }

    if (reviewStatus === 'CONFIRMED') {
      this.w.timeline.push({
        id: rng.uuid(),
        patientProfileId: pid,
        eventType: 'PRESCRIPTION_RECORDED',
        eventDate: start ?? startOfUtcDay(uploadedAt),
        dateIsUncertain: spec.dateUncertain ?? spec.date === null,
        datePrecision: (spec.dateUncertain ?? spec.date === null) ? 'UNCERTAIN' : 'EXACT',
        title: spec.diagnosis ? spec.diagnosis : 'Prescription',
        summary: `${spec.lines.length} medicine${spec.lines.length === 1 ? '' : 's'}: ${spec.lines.map((l) => l.written ?? l.med.written).join(', ')}`,
        sourceDocumentId: documentId,
        sourcePrescriptionId: prescriptionId,
        isVerified: true,
        createdAt: confirmedAt,
        updatedAt: confirmedAt,
      });
      this.w.audits.push({ id: rng.uuid(), userId: this.info.userId, action: 'PRESCRIPTION_CONFIRMED', resourceType: 'PRESCRIPTION', resourceId: prescriptionId, createdAt: confirmedAt });
    }
    return result;
  }

  addRxFromTemplate(t: HandwrittenTemplate, extra: Partial<RxSpec> = {}): RxResult {
    return this.addRx({
      date: t.dateIso ? new Date(`${t.dateIso}T00:00:00Z`) : null,
      dateUncertain: t.dateUncertain,
      doctor: t.doctor,
      clinic: t.clinic,
      diagnosis: t.diagnosis,
      lines: t.lines.map((l) => ({ med: catalogMed(l.med), written: l.written, frequency: l.frequency, duration: l.duration, instructions: l.instructions, uncertain: l.uncertain })),
      docKind: 'handwritten',
      templateId: t.id,
      pages: t.pages,
      notes: t.advice,
      ...extra,
    });
  }

  private historicalStatus(line: RxLine, start: Date | null): MedicationStatus {
    // Most past medicines stay INACTIVE (never marked). Some patients tidy up and mark them.
    const roll = this.rng.next();
    if (start && durationDays(line.duration) !== null && roll < 0.15) return 'COMPLETED';
    if (roll < 0.2) return 'DISCONTINUED';
    return 'INACTIVE';
  }

  /** A medicine the patient added by hand, with no prescription or document behind it. */
  addManualMedication(line: RxLine & { start: Date | null; end?: Date | null }): string {
    return this.addMedicationRow({ line, itemId: null, prescriptionId: null, documentId: null, start: line.start, end: line.end, createdAt: line.start ?? this.info.createdAt, status: line.status ?? 'ACTIVE' });
  }

  private addMedicationRow(a: {
    line: RxLine;
    itemId: string | null;
    prescriptionId: string | null;
    documentId: string | null;
    start: Date | null;
    end?: Date | null;
    createdAt: Date;
    status: MedicationStatus;
  }): string {
    const { line, status } = a;
    const rng = this.rng;
    const now = this.b.now;
    const id = rng.uuid();
    const days = durationDays(line.duration);
    const end = a.end !== undefined ? a.end : a.start && days ? addDays(a.start, days - 1) : null;
    const hasSchedule = status === 'ACTIVE' || status === 'PAUSED' || ((status === 'COMPLETED' || status === 'DISCONTINUED') && line.reminderTimes !== undefined);
    const times = line.reminderTimes !== undefined ? line.reminderTimes : hasSchedule ? reminderTimesFor(line.frequency) : null;

    let endedAt: Date | null = line.endedAt ?? null;
    if (!endedAt && (status === 'COMPLETED' || status === 'DISCONTINUED')) {
      endedAt = end && end < now ? new Date(end.getTime() + 20 * HOUR) : new Date(Math.min(now.getTime() - HOUR, (a.start ?? now).getTime() + rng.int(2, 20) * DAY));
    }
    if (!endedAt && status === 'PAUSED') endedAt = new Date(now.getTime() - rng.int(1, 12) * DAY);

    this.w.medications.push({
      id,
      patientProfileId: this.info.profileId,
      prescriptionItemId: a.itemId,
      prescriptionId: a.prescriptionId,
      sourceDocumentId: a.documentId,
      nameAsWritten: line.written ?? line.med.written,
      normalizedMedicineName: line.uncertain ? null : line.med.generic,
      strength: line.uncertain ? null : line.med.strength,
      dosageForm: line.med.form,
      route: line.med.route,
      prescribedInstructions: line.instructions ?? line.frequency ?? null,
      status,
      startDate: a.start,
      endDate: end,
      reminderTimes: times === null ? undefined : times,
      notes: line.notes ?? null,
      discontinuedReason: status === 'DISCONTINUED' ? line.discontinuedReason ?? rng.pick(['Side effects', 'Doctor changed medicine', 'Felt better', 'Too expensive', 'Ran out']) : null,
      discontinuedAt: status === 'DISCONTINUED' ? endedAt : null,
      completedAt: status === 'COMPLETED' ? endedAt : null,
      createdAt: a.createdAt,
      updatedAt: endedAt ?? a.createdAt,
    });

    if (times && times.length > 0 && a.start) {
      const scheduleEnd = status === 'ACTIVE' ? end : endedAt && end ? new Date(Math.min(endedAt.getTime(), end.getTime())) : endedAt ?? end;
      this.addDoses(id, a.start, scheduleEnd, times, status === 'ACTIVE');
    }
    return id;
  }

  private addDoses(medicationId: string, start: Date, end: Date | null, times: string[], future: boolean): void {
    const rng = this.rng;
    const now = this.b.now;
    const tz = this.info.tz;
    const windowStart = addDays(startOfUtcDay(now), -this.b.opts.doseHistoryDays);
    const horizon = future ? addDays(now, 7) : now;
    const firstDay = localDay(new Date(Math.max(start.getTime(), windowStart.getTime())), tz);
    const lastInstant = end ? Math.min(horizon.getTime(), end.getTime() + DAY) : horizon.getTime();
    const seen = new Set<number>();
    const mix = DOSE_MIX[this.info.adherence];

    for (let day = firstDay; day.getTime() <= lastInstant; day = addDays(day, 1)) {
      for (const t of times) {
        const at = zonedToUtc(day, t, tz);
        const ms = at.getTime();
        if (ms < start.getTime() || ms > lastInstant || seen.has(ms)) continue;
        seen.add(ms);
        const row: Prisma.DoseLogCreateManyInput = {
          id: rng.uuid(),
          medicationId,
          patientProfileId: this.info.profileId,
          scheduledTime: at,
          status: 'PENDING',
          createdAt: new Date(Math.min(ms, now.getTime()) - DAY),
          updatedAt: new Date(Math.min(ms, now.getTime()) - DAY),
        };
        if (ms <= now.getTime()) {
          const pick = rng.weighted(mix);
          const recentSnooze = now.getTime() - ms < 2 * HOUR && pick !== 'PENDING' && rng.bool(0.4);
          if (recentSnooze) {
            row.status = 'SNOOZED';
            row.snoozeMinutes = rng.pick([5, 10, 15, 30, 60]);
            row.actionTime = new Date(ms + rng.int(0, 5) * MINUTE);
          } else if (pick === 'TAKEN') {
            row.status = 'TAKEN';
            row.actionTime = new Date(ms + rng.int(-15, 45) * MINUTE);
          } else if (pick === 'TAKEN_LATE') {
            row.status = 'TAKEN';
            row.actionTime = new Date(Math.min(now.getTime(), ms + rng.int(2 * 60, 14 * 60) * MINUTE));
            row.notes = rng.bool(0.3) ? 'Took it late' : null;
          } else if (pick === 'SKIPPED') {
            row.status = 'SKIPPED';
            row.actionTime = new Date(ms + rng.int(0, 90) * MINUTE);
            row.notes = rng.pick([null, 'Felt nauseous', 'Out of stock', 'Doctor said to skip', 'Travelling']);
          } else if (pick === 'MISSED') {
            row.status = 'MISSED';
            row.actionTime = new Date(Math.min(now.getTime(), ms + rng.int(3, 20) * HOUR));
          }
          if (row.actionTime instanceof Date && row.actionTime.getTime() > now.getTime()) row.actionTime = new Date(now.getTime() - MINUTE);
          if (row.actionTime) row.updatedAt = row.actionTime;
        }
        this.w.doses.push(row);
      }
    }
  }

  addUploadIntent(kind: 'PENDING_FRESH' | 'PENDING_EXPIRED' | 'VERIFYING_STUCK' | 'REJECTED' | 'VERIFIED_CONSUMED', reason?: string): void {
    const rng = this.rng;
    const now = this.b.now;
    const created = kind === 'PENDING_FRESH' ? new Date(now.getTime() - 2 * MINUTE) : new Date(now.getTime() - rng.int(2, 72) * HOUR);
    const row: Prisma.UploadIntentCreateManyInput = {
      id: rng.uuid(),
      storageKey: `documents/${this.info.profileId}/${rng.uuid()}`,
      patientProfileId: this.info.profileId,
      originalFilename: rng.pick(['IMG_20261101_0930.jpg', 'scan.pdf', 'WhatsApp Image 2026-10-30 at 21.14.05.jpeg', 'prescription.png']),
      mimeType: rng.pick(['image/jpeg', 'application/pdf', 'image/png']),
      expectedSizeBytes: rng.int(40_000, 9_000_000),
      expiresAt: new Date(created.getTime() + 15 * MINUTE),
      consumed: kind === 'VERIFIED_CONSUMED',
      status: kind === 'REJECTED' ? 'REJECTED' : kind === 'VERIFYING_STUCK' ? 'VERIFYING' : kind === 'VERIFIED_CONSUMED' ? 'VERIFIED' : 'PENDING',
      rejectionReason: kind === 'REJECTED' ? reason ?? 'MAGIC_BYTES_MISMATCH' : null,
      verifyingStartedAt: kind === 'VERIFYING_STUCK' ? new Date(created.getTime() + MINUTE) : null,
      createdAt: created,
      updatedAt: created,
    };
    this.w.uploadIntents.push(row);
  }

  /** A timeline entry of a type the app does not create yet (lab report, vaccination...). Needs a document. */
  addOtherTimelineEvent(eventType: string, date: Date, title: string, summary: string, precision: 'EXACT' | 'MONTH' | 'YEAR' | 'UNCERTAIN' = 'EXACT'): void {
    const doc = this.addRx({
      date,
      lines: [{ med: catalogMed('pcm') }],
      pipeline: 'UPLOADED',
      docKind: 'pdf',
      originalFilename: `${eventType.toLowerCase()}-${isoDay(date)}.pdf`,
    });
    // Not a prescription: the job stays queued, the document shows as uploaded, and the timeline gets its own event.
    this.w.timeline.push({
      id: this.rng.uuid(),
      patientProfileId: this.info.profileId,
      eventType,
      eventDate: startOfUtcDay(date),
      dateIsUncertain: precision !== 'EXACT',
      datePrecision: precision,
      title,
      summary,
      sourceDocumentId: doc.documentId,
      sourcePrescriptionId: null,
      isVerified: precision === 'EXACT',
      createdAt: this.b.now,
      updatedAt: this.b.now,
    });
  }
}
