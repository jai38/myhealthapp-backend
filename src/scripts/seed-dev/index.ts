/**
 * Dev seed: fills the dev database with synthetic patients, prescriptions, medicines, doses and
 * timelines. It refuses to run against prod (see guard.ts).
 *
 *   Local:   npm run seed:dev -- --target dev --reset
 *   AWS dev: the dev-seed ECS task (infra/dev.tf) runs node dist/scripts/seed-dev/index.js --target dev --reset
 *
 * Flags
 *   --target dev           required, always
 *   --reset                remove existing seeded accounts first (real dev sign-ups are kept)
 *   --remove               only remove seeded accounts, write nothing
 *   --users N              bulk random users on top of the ~30 scenario accounts (default 60)
 *   --max-rx N             most prescriptions per bulk user (default 40)
 *   --seed N               random seed; same seed, same data (default 20261107)
 *   --now ISO              pretend "now" is this instant (default: the real clock)
 *   --dose-days N          days of dose history (default 120)
 *   --no-files             do not render or upload document files
 *   --images DIR           use generated handwritten images from DIR (HW-01.png ...) instead of placeholders.
 *                          Without it, images are read from the bucket's seed-assets/ prefix when present.
 *   --export DIR           also write the world as JSON (personas, counts, future-phase data); no DB needed with --dry-run
 *   --dry-run              generate and report only; touch no database or bucket
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_SEED, generateWorld, worldCounts } from './generate.js';
import { assertDevSeedTarget } from './guard.js';
import { ImageSource, SeedStorage, removeSeedUsers, writeWorld } from './write.js';
import { SEED_EMAIL_DOMAIN } from './builder.js';

/** Local Docker only. The AWS dev seed task reads SEED_USER_PASSWORD from Parameter Store instead. */
export const LOCAL_DEFAULT_PASSWORD = 'Ayoreni-Local-Seed-2026';

interface Args {
  target?: string;
  reset: boolean;
  remove: boolean;
  users: number;
  maxRx: number;
  seed: number;
  now?: string;
  doseDays: number;
  files: boolean;
  images?: string;
  exportDir?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { reset: false, remove: false, users: 60, maxRx: 40, seed: DEFAULT_SEED, doseDays: 120, files: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    const int = (min: number, max: number) => {
      const n = Number(value());
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer from ${min} to ${max}`);
      return n;
    };
    switch (flag) {
      case '--target': a.target = value(); break;
      case '--reset': a.reset = true; break;
      case '--remove': a.remove = true; break;
      case '--users': a.users = int(0, 5000); break;
      case '--max-rx': a.maxRx = int(1, 500); break;
      case '--seed': a.seed = int(1, 2 ** 31); break;
      case '--now': a.now = value(); break;
      case '--dose-days': a.doseDays = int(0, 3650); break;
      case '--no-files': a.files = false; break;
      case '--images': a.images = value(); break;
      case '--export': a.exportDir = value(); break;
      case '--dry-run': a.dryRun = true; break;
      default: throw new Error(`Unknown flag ${flag}`);
    }
  }
  return a;
}

function dirImageSource(dir: string): ImageSource {
  return async (templateId) => {
    for (const ext of ['png', 'jpg', 'jpeg', 'PNG', 'JPG', 'JPEG']) {
      const file = path.join(dir, `${templateId}.${ext}`);
      if (fs.existsSync(file)) return fs.readFileSync(file);
    }
    return null;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string) => console.log(line);

  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('--now is not a valid date');

  const world = generateWorld({ seed: args.seed, bulkUsers: args.users, maxRxPerUser: args.maxRx, now, doseHistoryDays: args.doseDays });
  log(`Generated world (seed ${args.seed}, now ${now.toISOString()}):`);
  for (const [k, v] of Object.entries(worldCounts(world))) log(`  ${k.padEnd(18)} ${v}`);

  if (args.exportDir) {
    fs.mkdirSync(args.exportDir, { recursive: true });
    fs.writeFileSync(path.join(args.exportDir, 'personas.json'), JSON.stringify(world.personas.filter((p) => p.covers.length > 0), null, 2));
    fs.writeFileSync(path.join(args.exportDir, 'future-phase-data.json'), JSON.stringify(world.future, null, 2));
    fs.writeFileSync(path.join(args.exportDir, 'counts.json'), JSON.stringify(worldCounts(world), null, 2));
    log(`Exported personas, counts and future-phase data to ${args.exportDir}`);
  }
  if (args.dryRun) {
    log('Dry run: nothing written.');
    return;
  }

  const guard = assertDevSeedTarget({
    target: args.target,
    databaseUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    deploymentEnv: process.env.DEPLOYMENT_ENV,
    storageBucket: process.env.STORAGE_BUCKET,
    storageEndpoint: process.env.STORAGE_ENDPOINT,
    withFiles: args.files,
  });
  log(`Target accepted: ${guard.local ? 'local database' : 'AWS dev database'} (schema ${guard.schema}).`);

  const password = process.env.SEED_USER_PASSWORD || (guard.local ? LOCAL_DEFAULT_PASSWORD : '');
  if (password.length < 12) {
    throw new Error('SEED_USER_PASSWORD must be set (12+ characters) for a remote dev database.');
  }

  const storage = args.files ? new SeedStorage() : null;
  const images: ImageSource | null = args.images ? dirImageSource(args.images) : storage ? (id) => storage.getSeedAsset(id) : null;

  const prisma = new PrismaClient();
  try {
    if (args.remove) {
      await removeSeedUsers(prisma, storage, log);
      return;
    }
    await writeWorld(prisma, world, { passwordHash: await bcrypt.hash(password, 10), storage, images, reset: args.reset, log });
    log(`Done. Sign in as any <name>@${SEED_EMAIL_DOMAIN} account with the seed password.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // Messages here carry flag names and counts only, never record contents.
  console.error(err instanceof Error ? err.message : 'Seed failed');
  process.exit(1);
});
