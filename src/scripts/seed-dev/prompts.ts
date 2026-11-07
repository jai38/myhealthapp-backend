/**
 * Writes the image-generation prompts for the handwritten templates.
 *   npm run seed:prompts -- <output.md>
 * The prompts are built from handwritten-templates.ts, so an image always matches its seeded record.
 */
import fs from 'fs';
import { HANDWRITTEN_TEMPLATES, HandwrittenTemplate } from './handwritten-templates.js';

const HEADER_TEXT: Record<HandwrittenTemplate['header'], string> = {
  letterhead: 'a printed clinic letterhead at the top (clinic name, the doctor\'s name and degrees, a made-up address, and "Reg. No. SAMPLE-0000")',
  stamp: 'no printed header; instead a slightly smudged rubber stamp with the clinic name and "Reg. No. SAMPLE-0000"',
  'opd-slip': 'a small printed government OPD slip with form fields (Name, Age/Sex, OPD No., Date, Rx)',
  plain: 'no header at all; plain paper',
};

export function promptFor(t: HandwrittenTemplate): string {
  const rx = t.lines
    .map((l, i) => `${i + 1}. ${l.written}  —  ${l.frequency}  —  ${l.duration}${l.instructions ? `  (${l.instructions})` : ''}${l.uncertain ? '   [this line should be hard to read]' : ''}`)
    .join('\n');
  return [
    `A realistic smartphone photo of a handwritten Indian doctor's prescription. Portrait, 3:4.`,
    `Paper and handwriting: ${t.look}`,
    `Header: ${HEADER_TEXT[t.header]}.${t.clinic ? ` Clinic: "${t.clinic}".` : ''}${t.doctor ? ` Doctor: "${t.doctor}".` : ' No doctor name anywhere.'}`,
    `Handwritten on the page, in this order:`,
    `- Date: ${t.dateWritten ? `"${t.dateWritten}"` : 'leave the date blank (no date anywhere on the page)'}`,
    `- Patient line: "${t.patientLine}"`,
    t.diagnosisWritten ? `- Diagnosis / complaint: "${t.diagnosisWritten}"` : '- No diagnosis written',
    `- A large "Rx" symbol, then these medicines, each on its own line, exactly as written:`,
    rx,
    t.advice ? `- Advice at the bottom: "${t.advice}"` : '',
    `- A scribbled doctor's signature at the bottom right.`,
    `Photo: ${t.capture}`,
    `Keep every medicine name, number and date exactly as given (spelling, dashes, fractions). Do not add any other medicines, logos of real hospitals or real brands of paper. All people and clinics are fictional. No real QR codes or barcodes.`,
  ].filter(Boolean).join('\n');
}

export function promptsMarkdown(): string {
  const parts: string[] = [
    '# Handwritten prescription image prompts',
    '',
    'Generated from `myhealthapp-backend/src/scripts/seed-dev/handwritten-templates.ts` by `npm run seed:prompts`. Do not edit by hand: change the template file and regenerate, so each image keeps matching its seeded record.',
    '',
    '## How to use',
    '',
    '1. Use **Gemini Nano Banana Pro** (Gemini 3 Pro Image) in the Gemini app or AI Studio. If a medicine name comes out misspelt after two tries, try the newest GPT image model for that one prompt.',
    '2. Paste one prompt per chat. Ask for portrait 3:4. Regenerate until every medicine line, number and date matches the prompt exactly: the seeded record expects exactly that text.',
    '3. Save each image as `HW-01.png` ... `HW-20.png` (PNG or JPEG only; convert WebP or HEIC first). Keep each file under 15 MB and under 8000 px per side.',
    '4. Load them:',
    '   - Local: `npm run seed:dev -- --target dev --reset --images <folder>`',
    '   - AWS dev: upload the files to the dev bucket under `seed-assets/` (see `docs/dev-data/README.md`), then run the dev seed task again. Every seeded document for that template then shows the image.',
    '5. Images are also good real-upload tests: upload one through the app in dev and compare Gemini\'s draft with the record in the table below.',
    '',
    '| ID | Scenario | What it tests | Date on paper | Medicines |',
    '|---|---|---|---|---|',
    ...HANDWRITTEN_TEMPLATES.map((t) => `| ${t.id} | ${t.scenario} | ${t.tests} | ${t.dateWritten ?? '(none)'} | ${t.lines.length} |`),
    '',
  ];
  for (const t of HANDWRITTEN_TEMPLATES) {
    parts.push(`## ${t.id}: ${t.scenario}`, '', `Tests: ${t.tests}`, '', 'Expected record: ' + [
      `date ${t.dateIso ?? 'unknown'}${t.dateUncertain ? ' (flagged uncertain)' : ''}`,
      `doctor ${t.doctor ?? 'none'}`,
      `diagnosis ${t.diagnosis ?? 'none'}`,
      `${t.lines.length} medicine(s)${t.lines.some((l) => l.uncertain) ? `, ${t.lines.filter((l) => l.uncertain).length} flagged unclear` : ''}`,
    ].join('; ') + '.', '', '```text', promptFor(t), '```', '');
  }
  return parts.join('\n');
}

const isMain = process.argv[1] && /prompts\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const out = process.argv[2];
  if (!out) {
    console.error('Usage: npm run seed:prompts -- <output.md>');
    process.exit(1);
  }
  fs.writeFileSync(out, promptsMarkdown(), 'utf8');
  console.log(`Wrote ${HANDWRITTEN_TEMPLATES.length} prompts to ${out}`);
}
