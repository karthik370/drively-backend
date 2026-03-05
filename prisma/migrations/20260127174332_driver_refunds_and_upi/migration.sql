-- CreateEnum
CREATE TYPE "DriverRefundStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "driverTravelDistanceKm" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "driver_refunds" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "upiId" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL DEFAULT 30,
    "status" "DriverRefundStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "driver_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_refunds_bookingId_key" ON "driver_refunds"("bookingId");

-- CreateIndex
CREATE INDEX "driver_refunds_driverId_idx" ON "driver_refunds"("driverId");

-- CreateIndex
CREATE INDEX "driver_refunds_status_createdAt_idx" ON "driver_refunds"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "driver_refunds" ADD CONSTRAINT "driver_refunds_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_refunds" ADD CONSTRAINT "driver_refunds_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
