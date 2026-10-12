import { PDFDocument } from 'pdf-lib';
import imageSize from 'image-size';

export interface DocumentValidationResult {
  isValid: boolean;
  mimeType: string;
  fileSizeBytes: number;
  pageCount?: number;
  imageDimensions?: { width: number; height: number };
  error?: string;
}

export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB
export const MAX_PDF_PAGES = 10;
export const MAX_IMAGE_DIMENSION = 8000;
export const MIN_IMAGE_DIMENSION = 50;

/**
 * Validates file magic bytes against claimed MIME type.
 */
export function validateFileMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 4) return false;

  if (mimeType === 'image/jpeg') {
    // JPEG starts with FF D8 FF
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    // PNG starts with 89 50 4E 47
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimeType === 'application/pdf') {
    // PDF starts with %PDF (25 50 44 46)
    return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
  }

  return false;
}

/**
 * Performs deep parser-based validation of uploaded document bytes.
 * Validates actual document structure beyond superficial magic byte headers.
 * Detects corrupt files, disguised extensions, encrypted PDFs, page-count overflows, and excessive image dimensions.
 */
async function runDocumentValidationInternal(
  buffer: Buffer,
  claimedMimeType: string
): Promise<DocumentValidationResult> {

  const fileSizeBytes = buffer.length;

  if (fileSizeBytes === 0) {
    return {
      isValid: false,
      mimeType: claimedMimeType,
      fileSizeBytes: 0,
      error: 'File is empty (0 bytes). Upload must fail closed.',
    };
  }

  if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
    return {
      isValid: false,
      mimeType: claimedMimeType,
      fileSizeBytes,
      error: `File size ${fileSizeBytes} bytes exceeds maximum limit of 15MB.`,
    };
  }

  // 1. Initial magic byte verification
  if (!validateFileMagicBytes(buffer, claimedMimeType)) {
    return {
      isValid: false,
      mimeType: claimedMimeType,
      fileSizeBytes,
      error: `File magic byte signature does not match claimed MIME type ${claimedMimeType}`,
    };
  }

  // 2. Parser-based validation
  if (claimedMimeType === 'application/pdf') {
    try {
      // PDF structure validation with pdf-lib
      const pdfDoc = await PDFDocument.load(buffer, {
        ignoreEncryption: false,
        updateMetadata: false,
      });

      if (pdfDoc.isEncrypted) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          error: 'Encrypted or password-protected PDF files are not supported.',
        };
      }

      const pageCount = pdfDoc.getPageCount();
      if (pageCount < 1) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          error: 'PDF contains no pages.',
        };
      }

      if (pageCount > MAX_PDF_PAGES) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          pageCount,
          error: `PDF exceeds maximum allowable page count of ${MAX_PDF_PAGES} pages (found ${pageCount}).`,
        };
      }

      return {
        isValid: true,
        mimeType: claimedMimeType,
        fileSizeBytes,
        pageCount,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid PDF structure';
      if (msg.toLowerCase().includes('encrypted') || msg.toLowerCase().includes('password')) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          error: 'Encrypted or password-protected PDF files are not supported.',
        };
      }
      return {
        isValid: false,
        mimeType: claimedMimeType,
        fileSizeBytes,
        error: `Malformed PDF document: ${msg}`,
      };
    }
  }

  if (claimedMimeType === 'image/jpeg' || claimedMimeType === 'image/png') {
    try {
      const dimensions = imageSize(buffer);
      if (!dimensions || !dimensions.width || !dimensions.height) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          error: 'Unable to parse image dimensions from header.',
        };
      }

      // Check format matches claimed MIME
      const expectedType = claimedMimeType === 'image/jpeg' ? 'jpg' : 'png';
      if (dimensions.type !== expectedType && !(claimedMimeType === 'image/jpeg' && dimensions.type === 'jpeg')) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          error: `Image data format (${dimensions.type}) does not match claimed MIME type ${claimedMimeType}`,
        };
      }

      // Enforce dimension boundaries
      if (
        dimensions.width > MAX_IMAGE_DIMENSION ||
        dimensions.height > MAX_IMAGE_DIMENSION
      ) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          imageDimensions: { width: dimensions.width, height: dimensions.height },
          error: `Image dimensions (${dimensions.width}x${dimensions.height}) exceed maximum allowed dimension of ${MAX_IMAGE_DIMENSION}px.`,
        };
      }

      if (
        dimensions.width < MIN_IMAGE_DIMENSION ||
        dimensions.height < MIN_IMAGE_DIMENSION
      ) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          imageDimensions: { width: dimensions.width, height: dimensions.height },
          error: `Image dimensions (${dimensions.width}x${dimensions.height}) are below minimum resolution of ${MIN_IMAGE_DIMENSION}px.`,
        };
      }

      return {
        isValid: true,
        mimeType: claimedMimeType,
        fileSizeBytes,
        imageDimensions: { width: dimensions.width, height: dimensions.height },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Corrupt image data';
      return {
        isValid: false,
        mimeType: claimedMimeType,
        fileSizeBytes,
        error: `Malformed image data: ${msg}`,
      };
    }
  }

  return {
    isValid: false,
    mimeType: claimedMimeType,
    fileSizeBytes,
    error: `Unsupported MIME type: ${claimedMimeType}`,
  };
}

/**
 * Validates document content with resource limits and an execution timeout to prevent parser hangs.
 */
export async function validateDocumentContent(
  buffer: Buffer,
  claimedMimeType: string,
  timeoutMs = 5000
): Promise<DocumentValidationResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<DocumentValidationResult>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Document parser timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      runDocumentValidationInternal(buffer, claimedMimeType),
      timeoutPromise,
    ]);
    if (timer) clearTimeout(timer);
    return result;
  } catch (err: unknown) {
    if (timer) clearTimeout(timer);
    const msg = err instanceof Error ? err.message : 'Parser validation failure';
    return {
      isValid: false,
      mimeType: claimedMimeType,
      fileSizeBytes: buffer.length,
      error: msg,
    };
  }
}

