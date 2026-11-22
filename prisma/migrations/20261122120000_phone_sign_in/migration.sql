-- CreateEnum
CREATE TYPE "OtpDelivery" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'WHATSAPP_UNAVAILABLE', 'FAILED');

-- CreateEnum
CREATE TYPE "ConsentKind" AS ENUM ('TERMS', 'HEALTH_DATA');

-- AlterEnum
ALTER TYPE "AuthProvider" ADD VALUE 'PHONE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_active_at" TIMESTAMP(3),
ADD COLUMN     "phone_e164" TEXT,
ADD COLUMN     "phone_verified_at" TIMESTAMP(3),
ADD COLUMN     "recovery_code_created_at" TIMESTAMP(3),
ADD COLUMN     "recovery_code_hmac" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "patient_profiles" ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "gender_self_description" TEXT,
ADD COLUMN     "profile_completed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "device_id" UUID;

-- CreateTable
CREATE TABLE "otp_requests" (
    "id" UUID NOT NULL,
    "phone_hmac" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "code_hmac" TEXT NOT NULL,
    "install_id_hmac" TEXT NOT NULL,
    "ip_hmac" TEXT NOT NULL,
    "terms_version" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "wrong_attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "delivery" "OtpDelivery" NOT NULL DEFAULT 'PENDING',
    "provider_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "install_id_hmac" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "ConsentKind" NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "second_factor_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "install_id_hmac" TEXT NOT NULL,
    "device_name" TEXT NOT NULL,
    "device_platform" TEXT NOT NULL,
    "wrong_attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "second_factor_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "otp_requests_provider_message_id_key" ON "otp_requests"("provider_message_id");

-- CreateIndex
CREATE INDEX "otp_requests_phone_hmac_created_at_idx" ON "otp_requests"("phone_hmac", "created_at");

-- CreateIndex
CREATE INDEX "otp_requests_install_id_hmac_created_at_idx" ON "otp_requests"("install_id_hmac", "created_at");

-- CreateIndex
CREATE INDEX "otp_requests_ip_hmac_created_at_idx" ON "otp_requests"("ip_hmac", "created_at");

-- CreateIndex
CREATE INDEX "otp_requests_created_at_idx" ON "otp_requests"("created_at");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE INDEX "devices_user_id_install_id_hmac_idx" ON "devices"("user_id", "install_id_hmac");

-- CreateIndex
CREATE INDEX "consent_records_user_id_kind_idx" ON "consent_records"("user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "second_factor_challenges_token_hash_key" ON "second_factor_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "second_factor_challenges_user_id_idx" ON "second_factor_challenges"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_e164_key" ON "users"("phone_e164");

-- CreateIndex
CREATE INDEX "refresh_tokens_device_id_idx" ON "refresh_tokens"("device_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "second_factor_challenges" ADD CONSTRAINT "second_factor_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

