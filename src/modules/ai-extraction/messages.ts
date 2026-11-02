import { z } from 'zod';

/**
 * Wire formats between the API and the extraction worker.
 *
 * The worker has no database access, so the job message carries everything it needs to read the
 * document and run the provider, and the result message carries everything the API needs to record
 * the outcome. Both messages hold identifiers only, except the result payload, which is the draft
 * extraction the API re-validates before storing. No message is ever logged.
 */

const idString = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

export const ExtractionWorkMessageSchema = z.object({
  version: z.literal(1),
  jobId: idString,
  patientProfileId: idString,
  documentId: idString,
  storageKey: z.string().min(1).max(300),
  mimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
});
export type ExtractionWorkMessage = z.infer<typeof ExtractionWorkMessageSchema>;

export const ExtractionResultMessageSchema = z.discriminatedUnion('outcome', [
  z.object({
    version: z.literal(1),
    jobId: idString,
    patientProfileId: idString,
    outcome: z.literal('SUCCEEDED'),
    // Shape is validated by the API with ExtractedPrescriptionPayloadSchema before it is stored.
    payload: z.unknown(),
  }),
  z.object({
    version: z.literal(1),
    jobId: idString,
    patientProfileId: idString,
    outcome: z.literal('FAILED'),
    // Short, PHI-free description. Truncated by the worker and again by the API.
    error: z.string().max(300),
  }),
]);
export type ExtractionResultMessage = z.infer<typeof ExtractionResultMessageSchema>;

/** Sender side seen by ExtractionJobQueue. */
export interface ExtractionDispatcher {
  dispatch(message: ExtractionWorkMessage): Promise<void>;
}
