-- CreateEnum
CREATE TYPE "MedicationStatus" AS ENUM ('INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETED', 'DISCONTINUED');

-- CreateTable
CREATE TABLE "medications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_profile_id" UUID NOT NULL,
    "prescription_item_id" UUID,
    "prescription_id" UUID,
    "source_document_id" UUID,
    "name_as_written" TEXT NOT NULL,
    "normalized_medicine_name" TEXT,
    "strength" TEXT,
    "dosage_form" TEXT NOT NULL,
    "route" TEXT NOT NULL DEFAULT 'ORAL',
    "prescribed_instructions" TEXT,
    "status" "MedicationStatus" NOT NULL DEFAULT 'INACTIVE',
    "start_date" DATE,
    "end_date" DATE,
    "reminder_times" JSONB,
    "notes" TEXT,
    "discontinued_reason" TEXT,
    "discontinued_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dose_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "medication_id" UUID NOT NULL,
    "patient_profile_id" UUID NOT NULL,
    "scheduled_time" TIMESTAMP(3) NOT NULL,
    "status" "DoseStatus" NOT NULL DEFAULT 'PENDING',
    "action_time" TIMESTAMP(3),
    "snooze_minutes" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dose_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "medications_prescription_item_id_key" ON "medications"("prescription_item_id");

-- CreateIndex
CREATE INDEX "medications_patient_profile_id_idx" ON "medications"("patient_profile_id");

-- CreateIndex
CREATE INDEX "medications_status_idx" ON "medications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "dose_logs_medication_id_scheduled_time_key" ON "dose_logs"("medication_id", "scheduled_time");

-- CreateIndex
CREATE INDEX "dose_logs_patient_profile_id_scheduled_time_idx" ON "dose_logs"("patient_profile_id", "scheduled_time");

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_patient_profile_id_fkey" FOREIGN KEY ("patient_profile_id") REFERENCES "patient_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_prescription_item_id_fkey" FOREIGN KEY ("prescription_item_id") REFERENCES "prescription_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dose_logs" ADD CONSTRAINT "dose_logs_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dose_logs" ADD CONSTRAINT "dose_logs_patient_profile_id_fkey" FOREIGN KEY ("patient_profile_id") REFERENCES "patient_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
