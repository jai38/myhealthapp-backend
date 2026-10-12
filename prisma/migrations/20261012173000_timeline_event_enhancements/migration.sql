-- AlterTable
ALTER TABLE "timeline_events" ADD COLUMN "date_is_uncertain" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "timeline_events" ADD COLUMN "date_precision" TEXT NOT NULL DEFAULT 'EXACT';
