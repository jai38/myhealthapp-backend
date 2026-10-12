-- CreateEnum
CREATE TYPE "UploadIntentStatus" AS ENUM ('PENDING', 'VERIFYING', 'VERIFIED', 'REJECTED');

-- AlterTable
ALTER TABLE "upload_intents" ADD COLUMN "status" "UploadIntentStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "upload_intents" ADD COLUMN "rejection_reason" TEXT;
ALTER TABLE "upload_intents" ADD COLUMN "verifying_started_at" TIMESTAMP(3);
ALTER TABLE "upload_intents" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
