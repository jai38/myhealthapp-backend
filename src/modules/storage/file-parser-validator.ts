import path from 'path';
import { Worker } from 'worker_threads';
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

const WORKER_SCRIPT_PATH = path.resolve(__dirname, 'parser-worker.cjs');

/**
 * Validates file magic bytes against claimed MIME type.
 * Fast in-process pre-check to reject obviously invalid binaries without thread overhead.
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
 * Concurrency manager to bound simultaneous worker threads and prevent
 * CPU/memory exhaustion under high upload volume.
 */
export class ParserConcurrencyManager {
  private activeCount = 0;
  private queue: Array<() => void> = [];
  public maxConcurrent = 4;
  public maxQueue = 20;

  async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return;
    }
    if (this.queue.length >= this.maxQueue) {
      throw new Error(
        `Service busy: Concurrency limit reached for document parsing (active: ${this.activeCount}, queued: ${this.queue.length})`
      );
    }
    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.activeCount++;
        resolve();
      });
    });
  }

  release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  reset(): void {
    this.activeCount = 0;
    this.queue = [];
  }
}

export const parserConcurrency = new ParserConcurrencyManager();

/**
 * Fallback in-process validation if Worker cannot be initialized.
 */
async function runDocumentValidationInternal(
  buffer: Buffer,
  claimedMimeType: string
): Promise<DocumentValidationResult> {
  const fileSizeBytes = buffer.length;

  if (claimedMimeType === 'application/pdf') {
    try {
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

      const expectedType = claimedMimeType === 'image/jpeg' ? 'jpg' : 'png';
      if (dimensions.type !== expectedType && !(claimedMimeType === 'image/jpeg' && dimensions.type === 'jpeg')) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          error: `Image data format (${dimensions.type}) does not match claimed MIME type ${claimedMimeType}`,
        };
      }

      if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
        return {
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          imageDimensions: { width: dimensions.width, height: dimensions.height },
          error: `Image dimensions (${dimensions.width}x${dimensions.height}) exceed maximum allowed dimension of ${MAX_IMAGE_DIMENSION}px.`,
        };
      }

      if (dimensions.width < MIN_IMAGE_DIMENSION || dimensions.height < MIN_IMAGE_DIMENSION) {
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
 * Validates document content with strict resource limits:
 * 1. File size limits are enforced before passing to the parser.
 * 2. Magic byte signatures are verified in-process.
 * 3. Deep CPU-intensive PDF/image parsing is isolated in a bounded Worker thread.
 * 4. Timeouts forcefully terminate the underlying Worker thread via worker.terminate(),
 *    stopping runaway CPU loops, zip bombs, and freeing memory.
 * 5. Concurrency is strictly bounded by ParserConcurrencyManager.
 */
export async function validateDocumentContent(
  buffer: Buffer,
  claimedMimeType: string,
  timeoutMs = 5000,
  testOptions?: { _simulateHang?: boolean }
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

  // Initial magic byte verification
  if (!validateFileMagicBytes(buffer, claimedMimeType)) {
    return {
      isValid: false,
      mimeType: claimedMimeType,
      fileSizeBytes,
      error: `File magic byte signature does not match claimed MIME type ${claimedMimeType}`,
    };
  }

  // Acquire concurrency slot
  await parserConcurrency.acquire();

  return new Promise<DocumentValidationResult>((resolve) => {
    let hasFinished = false;
    let worker: Worker | null = null;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      parserConcurrency.release();
      if (worker) {
        try {
          await worker.terminate();
        } catch {}
        worker = null;
      }
    };

    timer = setTimeout(async () => {
      if (hasFinished) return;
      hasFinished = true;
      if (worker) {
        try {
          await worker.terminate();
        } catch {}
        worker = null;
      }
      parserConcurrency.release();
      resolve({
        isValid: false,
        mimeType: claimedMimeType,
        fileSizeBytes,
        error: `Document parser timed out and execution was terminated after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    try {
      worker = new Worker(WORKER_SCRIPT_PATH);

      worker.on('message', async (result: DocumentValidationResult) => {
        if (hasFinished) return;
        hasFinished = true;
        await cleanup();
        resolve(result);
      });

      worker.on('error', async (err: Error) => {
        if (hasFinished) return;
        hasFinished = true;
        await cleanup();
        resolve({
          isValid: false,
          mimeType: claimedMimeType,
          fileSizeBytes,
          error: `Worker execution error: ${err.message}`,
        });
      });

      worker.on('exit', async (code: number) => {
        if (hasFinished) return;
        hasFinished = true;
        await cleanup();
        if (code !== 0) {
          resolve({
            isValid: false,
            mimeType: claimedMimeType,
            fileSizeBytes,
            error: `Worker exited prematurely with code ${code}`,
          });
        }
      });

      // Post payload to worker
      worker.postMessage({
        buffer,
        mimeType: claimedMimeType,
        maxPdfPages: MAX_PDF_PAGES,
        maxImageDimension: MAX_IMAGE_DIMENSION,
        minImageDimension: MIN_IMAGE_DIMENSION,
        _simulateHang: testOptions?._simulateHang,
      });
    } catch (err: unknown) {
      // Fallback if Worker thread creation fails in unsupported environment
      if (timer) clearTimeout(timer);
      parserConcurrency.release();
      runDocumentValidationInternal(buffer, claimedMimeType).then(resolve);
    }
  });
}
