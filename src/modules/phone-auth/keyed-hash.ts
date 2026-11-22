import crypto from 'node:crypto';

/**
 * HMAC-SHA256 under the server's OTP_HMAC_SECRET, with a purpose label so a value hashed for one use
 * can't be replayed as another. A plain hash of a 6-digit code or a phone number is reversible by
 * trying every value; a keyed hash is not without the secret.
 */
export type HashPurpose = 'code' | 'phone' | 'install' | 'ip' | 'recovery';

export class KeyedHasher {
  constructor(private readonly secret: string) {
    if (!secret) throw new Error('A keyed-hash secret is required');
  }

  hash(purpose: HashPurpose, value: string): string {
    return crypto.createHmac('sha256', this.secret).update(`${purpose}:${value}`).digest('hex');
  }

  /** Constant-time comparison of a candidate against a stored keyed hash. */
  matches(purpose: HashPurpose, candidate: string, storedHex: string): boolean {
    const a = Buffer.from(this.hash(purpose, candidate), 'hex');
    const b = Buffer.from(storedHex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

/** Opaque tokens (refresh, second factor) are 256-bit random; a plain SHA-256 is enough for them. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Six digits from a cryptographic source, leading zeros kept. */
export function generateOtpCode(length = 6): string {
  return crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
}

// Recovery codes (P3, A02): 16 characters in four groups. 31 symbols with no 0/O or 1/I/L look-alikes,
// drawn without bias, so about 79 bits of entropy.
export const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateRecoveryCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < 16; i++) chars.push(RECOVERY_ALPHABET.charAt(crypto.randomInt(0, RECOVERY_ALPHABET.length)));
  return chars.join('').match(/.{4}/g)!.join('-');
}

/** Uppercase, dashes and spaces removed, so "k7qf 29xd-m4pl8rwc" matches "K7QF-29XD-M4PL-8RWC". */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '');
  return /^[0-9A-Z]{16}$/.test(cleaned) ? cleaned : null;
}
