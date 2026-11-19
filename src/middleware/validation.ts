import { ZodError } from 'zod';

/** One failed field, the same shape on every route: `path` is dot-joined ('' for the whole body). */
export interface FieldError {
  path: string;
  message: string;
}

/**
 * Every 400 VALIDATION_ERROR (and the timeline's INVALID_QUERY_PARAMETERS) carries `fields` in this
 * shape. The older per-route `details` stay beside it so no existing client breaks.
 */
export function fieldErrors(error: ZodError): FieldError[] {
  return error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }));
}
