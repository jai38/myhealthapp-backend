const { parentPort } = require('worker_threads');
const { PDFDocument } = require('pdf-lib');
const imageSize = require('image-size');

if (!parentPort) {
  process.exit(1);
}

parentPort.on('message', async (message) => {
  try {
    const { buffer, mimeType, maxPdfPages = 10, maxImageDimension = 8000, minImageDimension = 50 } = message;
    const nodeBuf = Buffer.from(buffer);

    // Synthetic timeout test mode
    if (message._simulateHang) {
      // Spinloop or sleep to test termination
      await new Promise((r) => setTimeout(r, 60000));
      return;
    }

    if (mimeType === 'application/pdf') {
      try {
        const pdfDoc = await PDFDocument.load(nodeBuf, {
          ignoreEncryption: false,
          updateMetadata: false,
        });

        if (pdfDoc.isEncrypted) {
          parentPort.postMessage({
            isValid: false,
            mimeType,
            fileSizeBytes: nodeBuf.length,
            error: 'Encrypted or password-protected PDF files are not supported.',
          });
          return;
        }

        const pageCount = pdfDoc.getPageCount();
        if (pageCount < 1) {
          parentPort.postMessage({
            isValid: false,
            mimeType,
            fileSizeBytes: nodeBuf.length,
            error: 'PDF contains no pages.',
          });
          return;
        }

        if (pageCount > maxPdfPages) {
          parentPort.postMessage({
            isValid: false,
            mimeType,
            fileSizeBytes: nodeBuf.length,
            pageCount,
            error: `PDF exceeds maximum allowable page count of ${maxPdfPages} pages (found ${pageCount}).`,
          });
          return;
        }

        parentPort.postMessage({
          isValid: true,
          mimeType,
          fileSizeBytes: nodeBuf.length,
          pageCount,
        });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid PDF structure';
        if (msg.toLowerCase().includes('encrypted') || msg.toLowerCase().includes('password')) {
          parentPort.postMessage({
            isValid: false,
            mimeType,
            fileSizeBytes: nodeBuf.length,
            error: 'Encrypted or password-protected PDF files are not supported.',
          });
          return;
        }
        parentPort.postMessage({
          isValid: false,
          mimeType,
          fileSizeBytes: nodeBuf.length,
          error: `Malformed PDF document: ${msg}`,
        });
        return;
      }
    }

    if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
      try {
        const dimensions = imageSize(nodeBuf);
        if (!dimensions || !dimensions.width || !dimensions.height) {
          parentPort.postMessage({
            isValid: false,
            mimeType,
            fileSizeBytes: nodeBuf.length,
            error: 'Unable to parse image dimensions from header.',
          });
          return;
        }

        const expectedType = mimeType === 'image/jpeg' ? 'jpg' : 'png';
        if (dimensions.type !== expectedType && !(mimeType === 'image/jpeg' && dimensions.type === 'jpeg')) {
          parentPort.postMessage({
            isValid: false,
            mimeType,
            fileSizeBytes: nodeBuf.length,
            error: `Image data format (${dimensions.type}) does not match claimed MIME type ${mimeType}`,
          });
          return;
        }

        if (dimensions.width > maxImageDimension || dimensions.height > maxImageDimension) {
          parentPort.postMessage({
            isValid: false,
            mimeType,
            fileSizeBytes: nodeBuf.length,
            imageDimensions: { width: dimensions.width, height: dimensions.height },
            error: `Image dimensions (${dimensions.width}x${dimensions.height}) exceed maximum allowed dimension of ${maxImageDimension}px.`,
          });
          return;
        }

        if (dimensions.width < minImageDimension || dimensions.height < minImageDimension) {
          parentPort.postMessage({
            isValid: false,
            mimeType,
            fileSizeBytes: nodeBuf.length,
            imageDimensions: { width: dimensions.width, height: dimensions.height },
            error: `Image dimensions (${dimensions.width}x${dimensions.height}) are below minimum resolution of ${minImageDimension}px.`,
          });
          return;
        }

        parentPort.postMessage({
          isValid: true,
          mimeType,
          fileSizeBytes: nodeBuf.length,
          imageDimensions: { width: dimensions.width, height: dimensions.height },
        });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Corrupt image data';
        parentPort.postMessage({
          isValid: false,
          mimeType,
          fileSizeBytes: nodeBuf.length,
          error: `Malformed image data: ${msg}`,
        });
        return;
      }
    }

    parentPort.postMessage({
      isValid: false,
      mimeType,
      fileSizeBytes: nodeBuf.length,
      error: `Unsupported MIME type: ${mimeType}`,
    });
  } catch (outerErr) {
    parentPort.postMessage({
      isValid: false,
      mimeType: message?.mimeType || 'unknown',
      fileSizeBytes: 0,
      error: `Worker execution error: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`,
    });
  }
});
