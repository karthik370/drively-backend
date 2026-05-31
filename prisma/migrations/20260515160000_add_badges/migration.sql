-- CreateTable
CREATE TABLE "trip_photos" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "phase" VARCHAR(10) NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "label" VARCHAR(50),
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_definitions" (
    "id" TEXT NOT NULL,
    "slug" VARCHAR(50) NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "icon" VARCHAR(50) NOT NULL,
    "color" VARCHAR(20) NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badge_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badge_quizzes" (
    "id" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "questions" JSONB NOT NULL,
    "passingScore" INTEGER NOT NULL DEFAULT 70,
    "timeLimitSec" INTEGER NOT NULL DEFAULT 300,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "badge_quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_badges" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "quizScore" INTEGER,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_badges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_photos_bookingId_idx" ON "trip_photos"("bookingId");

-- CreateIndex
CREATE INDEX "trip_photos_bookingId_phase_idx" ON "trip_photos"("bookingId", "phase");

-- CreateIndex
CREATE INDEX "trip_photos_uploadedBy_idx" ON "trip_photos"("uploadedBy");

-- CreateIndex
CREATE UNIQUE INDEX "badge_definitions_slug_key" ON "badge_definitions"("slug");

-- CreateIndex
CREATE INDEX "badge_definitions_isActive_idx" ON "badge_definitions"("isActive");

-- CreateIndex
CREATE INDEX "badge_definitions_category_idx" ON "badge_definitions"("category");

-- CreateIndex
CREATE UNIQUE INDEX "badge_quizzes_badgeId_key" ON "badge_quizzes"("badgeId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_badges_driverId_badgeId_key" ON "driver_badges"("driverId", "badgeId");

-- CreateIndex
CREATE INDEX "driver_badges_driverId_idx" ON "driver_badges"("driverId");

-- CreateIndex
CREATE INDEX "driver_badges_badgeId_idx" ON "driver_badges"("badgeId");

-- AddForeignKey
ALTER TABLE "trip_photos" ADD CONSTRAINT "trip_photos_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badge_quizzes" ADD CONSTRAINT "badge_quizzes_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "badge_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_badges" ADD CONSTRAINT "driver_badges_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "badge_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
