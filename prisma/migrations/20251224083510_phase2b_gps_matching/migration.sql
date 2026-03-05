-- CreateEnum
CREATE TYPE "TripType" AS ENUM ('ONE_WAY', 'ROUND_TRIP', 'OUTSTATION');

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "actualRoutePolyline" TEXT,
ADD COLUMN     "currentETA" INTEGER,
ADD COLUMN     "driverDistance" DOUBLE PRECISION,
ADD COLUMN     "driverETA" INTEGER,
ADD COLUMN     "matchAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "matchScore" DOUBLE PRECISION,
ADD COLUMN     "rejectedDriverIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "tripType" "TripType" NOT NULL DEFAULT 'ONE_WAY';

-- AlterTable
ALTER TABLE "driver_profiles" ADD COLUMN     "batteryLevel" INTEGER,
ADD COLUMN     "currentHeading" DOUBLE PRECISION,
ADD COLUMN     "currentLatitude" DOUBLE PRECISION,
ADD COLUMN     "currentLongitude" DOUBLE PRECISION,
ADD COLUMN     "currentSpeed" DOUBLE PRECISION,
ADD COLUMN     "lastLocationUpdate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "altitude" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "bookings_status_createdAt_idx" ON "bookings"("status", "createdAt");

-- CreateIndex
CREATE INDEX "driver_profiles_isOnline_isAvailable_idx" ON "driver_profiles"("isOnline", "isAvailable");

-- CreateIndex
CREATE INDEX "driver_profiles_currentLatitude_currentLongitude_idx" ON "driver_profiles"("currentLatitude", "currentLongitude");

-- CreateIndex
CREATE INDEX "locations_driverId_timestamp_idx" ON "locations"("driverId", "timestamp");
