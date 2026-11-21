import { Request, Response, NextFunction } from 'express';

/**
 * Errors from express.json() (body-parser) carry a 4xx `status` and a `type`. Their messages can
 * quote part of the body, so the reply uses fixed text and never echoes them.
 */
function bodyParserError(err: unknown): { status: number; code: string; message: string } | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { status?: unknown; type?: unknown };
  if (typeof e.type !== 'string' || typeof e.status !== 'number' || e.status < 400 || e.status >= 500) {
    return null;
  }
  switch (e.type) {
    case 'entity.parse.failed':
      return { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON' };
    case 'entity.too.large':
      return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is larger than 1 MB' };
    default:
      return { status: e.status, code: 'BAD_REQUEST', message: 'The request body could not be read' };
  }
}

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Safe error handling: never leak PHI, stack traces, or internal database errors to client
  const bodyError = bodyParserError(err);
  if (bodyError) {
    res.status(bodyError.status).json({ error: { code: bodyError.code, message: bodyError.message } });
    return;
  }

  // Every route validates client input itself and answers 400 VALIDATION_ERROR. Anything else that
  // reaches here, a ZodError included, is a server fault: a generic 500 with no field paths.
  const errorMessage = err instanceof Error ? err.message : 'Internal server error';

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : errorMessage,
    },
  });
};
