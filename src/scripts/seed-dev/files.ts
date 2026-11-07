import crypto from 'crypto';
import zlib from 'zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { DocFile } from './builder.js';

/** Same limits as the upload validator (file-parser-validator.ts), kept here so the seed never imports app config. */
export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8000;

export interface RenderedFile {
  bytes: Buffer;
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg';
  width: number | null;
  height: number | null;
  pageCount: number | null;
}

export function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// PDF: printed prescriptions whose text matches the record exactly.
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

/** Standard PDF fonts only cover WinAnsi; anything else (Devanagari, Tamil, emoji) becomes '?'. */
function winAnsi(text: string): string {
  return Array.from(text)
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 63;
      return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) ? ch : ch === '—' || ch === '–' ? '-' : '?';
    })
    .join('');
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      if (cur) out.push(cur);
      cur = w.length > max ? w.slice(0, max) : w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function renderPdf(file: DocFile, documentId: string): Promise<RenderedFile> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Synthetic test prescription');
  pdf.setProducer('ayoreni dev seed');
  pdf.setCreator('ayoreni dev seed');
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const body = file.lines.flatMap((l) => wrap(winAnsi(l), 70));
  const perPage = Math.max(1, Math.ceil(body.length / file.pages));
  for (let p = 0; p < file.pages; p++) {
    const page = pdf.addPage([420, 595]); // A5
    page.drawText(winAnsi(file.heading).slice(0, 60), { x: 30, y: 555, size: 13, font: bold, color: rgb(0.1, 0.2, 0.45) });
    page.drawText('SYNTHETIC TEST DATA - NOT A REAL PRESCRIPTION', { x: 30, y: 538, size: 8, font: bold, color: rgb(0.75, 0.1, 0.1) });
    page.drawLine({ start: { x: 30, y: 530 }, end: { x: 390, y: 530 }, thickness: 1, color: rgb(0.1, 0.2, 0.45) });
    let y = 505;
    for (const l of body.slice(p * perPage, (p + 1) * perPage)) {
      page.drawText(l, { x: 30, y, size: 10, font });
      y -= 16;
      if (y < 60) break;
    }
    page.drawText(`Page ${p + 1} of ${file.pages}   ref ${documentId.slice(0, 8)}`, { x: 30, y: 30, size: 7, font, color: rgb(0.4, 0.4, 0.4) });
  }
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  return { bytes, mimeType: 'application/pdf', width: null, height: null, pageCount: file.pages };
}

// ---------------------------------------------------------------------------
// PNG placeholder: paper-coloured page with "SYNTHETIC PLACEHOLDER" and the template id.
// Replaced by a generated image when one exists for the template (see index.ts --images).
// ---------------------------------------------------------------------------

const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function renderPlaceholderPng(file: DocFile, documentId: string): RenderedFile {
  const W = 480;
  const H = 640;
  const px = Buffer.alloc(W * H * 3);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 247, 243, 232);

  // Ruled "handwriting" strokes so it reads as a page at thumbnail size.
  for (let row = 0; row < 14; row++) {
    const y = 250 + row * 24;
    const len = 120 + ((row * 97 + documentId.charCodeAt(row % 36)) % 260);
    for (let x = 40; x < 40 + len; x++) for (let t = 0; t < 2; t++) set(x, y + t + Math.round(Math.sin(x / 9) * 2), 40, 60, 140);
  }

  const text = (s: string, top: number, scale: number, color: [number, number, number]) => {
    const width = s.length * 6 * scale;
    let x0 = Math.floor((W - width) / 2);
    for (const ch of s.toUpperCase()) {
      const g = GLYPHS[ch] ?? GLYPHS[' '];
      g?.forEach((rowBits, gy) => {
        for (let gx = 0; gx < 5; gx++) {
          if (rowBits[gx] !== '1') continue;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(x0 + gx * scale + dx, top + gy * scale + dy, ...color);
        }
      });
      x0 += 6 * scale;
    }
  };
  text('SYNTHETIC', 50, 6, [180, 30, 30]);
  text('PLACEHOLDER', 110, 4, [180, 30, 30]);
  text(file.templateId ?? 'PHOTO', 170, 5, [40, 60, 140]);

  // A strip of bits from the document id keeps every placeholder's checksum distinct.
  const bits = documentId.replace(/-/g, '');
  for (let i = 0; i < bits.length; i++) {
    const v = parseInt(bits[i] ?? '0', 16);
    for (let b = 0; b < 4; b++) if (v & (1 << b)) for (let y = 610; y < 620; y++) for (let x = 0; x < 3; x++) set(40 + (i * 4 + b) * 3 + x, y, 30, 30, 30);
  }

  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { bytes, mimeType: 'image/png', width: W, height: H, pageCount: null };
}

/**
 * Checks a generated image before it is used: PNG or JPEG by magic bytes, within the upload limits,
 * with readable dimensions. Fails closed, like the real upload path (Rule 7).
 */
export function inspectImage(bytes: Buffer, name: string): RenderedFile {
  if (bytes.length === 0 || bytes.length > MAX_FILE_SIZE_BYTES) throw new Error(`${name}: size ${bytes.length} bytes is outside 1..${MAX_FILE_SIZE_BYTES}`);
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) throw new Error(`${name}: not a PNG or JPEG (convert WebP or HEIC first)`);
  let width = 0;
  let height = 0;
  if (isPng) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else {
    // Walk JPEG markers to the first SOFn frame header.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1] ?? 0;
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = bytes.readUInt16BE(i + 5);
        width = bytes.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
  }
  if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new Error(`${name}: unreadable or oversized dimensions ${width}x${height}`);
  }
  return { bytes, mimeType: isPng ? 'image/png' : 'image/jpeg', width, height, pageCount: null };
}
