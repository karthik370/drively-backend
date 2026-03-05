-- CreateEnum
CREATE TYPE "TransmissionType" AS ENUM ('MANUAL', 'AUTOMATIC');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "transmissionType" "TransmissionType" NOT NULL DEFAULT 'MANUAL';
