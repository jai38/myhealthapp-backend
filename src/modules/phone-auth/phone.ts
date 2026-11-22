/**
 * Indian mobile numbers only, at launch (S01): 10 digits starting 6-9. A pasted +91, 91 or leading
 * 0 and any spaces, dashes or brackets are removed. Returns E.164 (+91XXXXXXXXXX) or null.
 */
export function normalizeIndianMobile(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  let digits = input.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+91')) return null;
    digits = digits.slice(3);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}
