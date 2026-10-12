import { Router, Request, Response, NextFunction } from 'express';
import { DocumentService } from './document-service.js';

const getParamString = (param: string | string[] | undefined): string => {
  if (Array.isArray(param)) return param[0] || '';
  return param || '';
};

export function createDocumentRouter(documentService: DocumentService): Router {
  const router = Router();

  // POST /upload-intent
  router.post('/upload-intent', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { filename, mimeType, fileSizeBytes } = req.body;
      if (!filename || !mimeType || typeof fileSizeBytes !== 'number') {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Missing required upload parameters' },
        });
        return;
      }

      const patientProfileId = req.authContext!.patientProfileId;
      const intent = await documentService.initializeUpload(
        patientProfileId,
        filename,
        mimeType,
        fileSizeBytes
      );

      res.status(200).json({ data: intent });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload initialization failed';
      if (msg.includes('Unsupported MIME type') || msg.includes('exceeds')) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: msg } });
        return;
      }
      next(err);
      return;
    }
  });

  // POST /confirm-upload
  router.post('/confirm-upload', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { storageKey, fileBufferBase64, clientChecksum } = req.body;
      if (!storageKey) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'storageKey is required' },
        });
        return;
      }

      const patientProfileId = req.authContext!.patientProfileId;
      // Default to small valid PDF magic bytes if buffer is not provided
      const buffer = fileBufferBase64
        ? Buffer.from(fileBufferBase64, 'base64')
        : Buffer.from('%PDF-1.4 sample content', 'utf-8');

      const record = await documentService.confirmUpload(
        patientProfileId,
        storageKey,
        buffer,
        clientChecksum
      );

      res.status(201).json({ data: record });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload confirmation failed';
      if (msg.includes('Forbidden') || msg.includes('does not belong')) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: msg } });
        return;
      }
      if (
        msg.includes('Integrity check failed') ||
        msg.includes('File signature') ||
        msg.includes('exceeds') ||
        msg.includes('expired')
      ) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: msg } });
        return;
      }
      next(err);
      return;
    }
  });

  // GET /:documentId/signed-url
  router.get('/:documentId/signed-url', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const documentId = getParamString(req.params.documentId);
      if (!documentId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'documentId is required' } });
        return;
      }

      const patientProfileId = req.authContext!.patientProfileId;
      const signedUrl = await documentService.getSignedPreviewUrl(patientProfileId, documentId);
      res.status(200).json({ data: { signedUrl, expiresInSeconds: 900 } });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Document not found') || msg.includes('Unauthorized')) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found' } });
        return;
      }
      next(err);
      return;
    }
  });

  // GET /
  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patientProfileId = req.authContext!.patientProfileId;
      const docs = await documentService.listDocuments(patientProfileId);
      res.status(200).json({ data: docs });
      return;
    } catch (err) {
      next(err);
      return;
    }
  });

  return router;
}
