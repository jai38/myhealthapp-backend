/**
 * Deterministic random source for the dev seed. The same seed number always produces the same
 * world, including every UUID, so a reset-and-reseed gives testers identical data each time.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  /** mulberry32: small, fast, good enough for test data. Returns [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on an empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** n distinct items (or all of them when n is larger than the list). */
  pickN<T>(items: readonly T[], n: number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy.slice(0, Math.max(0, Math.min(n, copy.length)));
  }

  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    const last = entries[entries.length - 1];
    if (!last) throw new Error('Rng.weighted on an empty list');
    return last[0];
  }

  hex(length: number): string {
    let out = '';
    while (out.length < length) {
      out += Math.floor(this.next() * 0x100000000).toString(16).padStart(8, '0');
    }
    return out.slice(0, length);
  }

  /** RFC 4122 version-4 shaped UUID drawn from this generator. */
  uuid(): string {
    const h = this.hex(32).split('');
    h[12] = '4';
    h[16] = ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
  }

  dateBetween(from: Date, to: Date): Date {
    const a = from.getTime();
    const b = to.getTime();
    return new Date(a + Math.floor(this.next() * Math.max(0, b - a)));
  }
}
