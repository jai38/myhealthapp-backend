-- Phase 4b task 16: optional structured reason for a skipped dose. Additive and nullable.
CREATE TYPE "SkipReason" AS ENUM ('FELT_UNWELL', 'DOCTOR_ADVISED', 'RAN_OUT', 'SIDE_EFFECTS', 'OTHER');

ALTER TABLE "dose_logs" ADD COLUMN "skip_reason" "SkipReason";
