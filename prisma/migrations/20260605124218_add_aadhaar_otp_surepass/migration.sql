-- AlterEnum
ALTER TYPE "KycStatus" ADD VALUE 'AADHAAR_OTP_PENDING';

-- AlterTable
ALTER TABLE "kyc_verifications" ADD COLUMN "aadhaarClientId" VARCHAR(255),
ADD COLUMN "aadhaarPhotoUrl" TEXT;
