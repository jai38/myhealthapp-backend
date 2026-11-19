-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('UPLOAD', 'REPORT');

-- AlterTable
ALTER TABLE "documents" ADD COLUMN "kind" "DocumentKind" NOT NULL DEFAULT 'UPLOAD';

-- Backfill reports generated before this column existed. The server names them
-- medical-report-YYYY-MM-DD-xxxxxxxx.pdf and stores them CONFIRMED with no extraction job;
-- an uploaded document always has a job before it can be CONFIRMED.
UPDATE "documents" AS d
SET "kind" = 'REPORT'
WHERE d."mime_type" = 'application/pdf'
  AND d."status" = 'CONFIRMED'
  AND d."original_filename" ~ '^medical-report-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{8}\.pdf$'
  AND NOT EXISTS (SELECT 1 FROM "extraction_jobs" AS j WHERE j."document_id" = d."id");
