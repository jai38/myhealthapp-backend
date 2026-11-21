-- CreateEnum
CREATE TYPE "SkipReason" AS ENUM ('FELT_UNWELL', 'DOCTOR_ADVISED', 'RAN_OUT', 'SIDE_EFFECTS', 'OTHER');

-- AlterTable
ALTER TABLE "dose_logs" ADD COLUMN "skip_reason" "SkipReason";
