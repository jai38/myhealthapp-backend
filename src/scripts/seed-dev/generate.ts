import { Rng } from './rng.js';
import { SeedOptions, World, WorldBuilder } from './builder.js';
import { buildBulkUsers, buildPersonas } from './personas.js';

export const DEFAULT_SEED = 20261107;

/** Builds the whole synthetic world in memory. Pure: no database, no network, no clock reads. */
export function generateWorld(opts: SeedOptions): World {
  const builder = new WorldBuilder(new Rng(opts.seed), opts);
  buildPersonas(builder);
  buildBulkUsers(builder);
  return builder.world;
}

export function worldCounts(w: World): Record<string, number> {
  return {
    users: w.users.length,
    patientProfiles: w.profiles.length,
    documents: w.documents.length,
    uploadIntents: w.uploadIntents.length,
    extractionJobs: w.jobs.length,
    prescriptions: w.prescriptions.length,
    prescriptionItems: w.items.length,
    medications: w.medications.length,
    doseLogs: w.doses.length,
    timelineEvents: w.timeline.length,
    auditEvents: w.audits.length,
  };
}
