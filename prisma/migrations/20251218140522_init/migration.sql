-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('CUSTOMER', 'DRIVER', 'BOTH');

-- CreateEnum
CREATE TYPE "MembershipType" AS ENUM ('NONE', 'BASIC', 'PREMIUM', 'CORPORATE');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('CAR', 'SUV', 'HATCHBACK', 'SEDAN', 'LUXURY');

-- CreateEnum
CREATE TYPE "Specialization" AS ENUM ('CITY', 'HIGHWAY', 'NIGHT', 'ELDERLY_CARE', 'FEMALE_ONLY');

-- CreateEnum
CREATE TYPE "BookingType" AS ENUM ('CITY', 'OUTSTATION', 'HOURLY');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'SEARCHING', 'ACCEPTED', 'DRIVER_ARRIVING', 'ARRIVED', 'STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'UPI', 'WALLET', 'NET_BANKING');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'REFUNDED', 'FAILED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "CancelledBy" AS ENUM ('CUSTOMER', 'DRIVER', 'SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'FIRST_RIDE', 'CASHBACK');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('PAYMENT', 'DRIVER_ISSUE', 'APP_BUG', 'ACCIDENT', 'SAFETY', 'BOOKING', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_DRIVER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('BOOKING', 'PAYMENT', 'PROMOTION', 'SYSTEM', 'SAFETY', 'DRIVER_UPDATE', 'DOCUMENT_UPDATE');

-- CreateEnum
CREATE TYPE "InsuranceType" AS ENUM ('TRIP', 'ACCIDENT', 'SUBSCRIPTION', 'LIABILITY');

-- CreateEnum
CREATE TYPE "IncentiveType" AS ENUM ('PERFORMANCE', 'REFERRAL', 'MILESTONE', 'SURGE', 'BONUS');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'IN_USE', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "EmergencyStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'FALSE_ALARM');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "phoneNumber" VARCHAR(15) NOT NULL,
    "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "email" VARCHAR(255),
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "password" VARCHAR(255),
    "firstName" VARCHAR(100) NOT NULL,
    "lastName" VARCHAR(100) NOT NULL,
    "profileImage" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "gender" "Gender",
    "userType" "UserType" NOT NULL DEFAULT 'CUSTOMER',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "deviceTokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredLanguage" VARCHAR(10) NOT NULL DEFAULT 'en',
    "rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "totalRatings" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "lastLocationUpdate" TIMESTAMP(3),
    "referredById" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "savedAddresses" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "favoriteDriverIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "membershipType" "MembershipType" NOT NULL DEFAULT 'NONE',
    "membershipExpiryDate" TIMESTAMP(3),
    "corporateId" TEXT,
    "emergencyContacts" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "walletBalance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalSpent" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalTrips" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "licenseNumber" VARCHAR(50) NOT NULL,
    "licenseExpiryDate" TIMESTAMP(3) NOT NULL,
    "licenseImageUrl" TEXT NOT NULL,
    "aadhaarNumber" VARCHAR(255) NOT NULL,
    "aadhaarImageUrl" TEXT NOT NULL,
    "panNumber" VARCHAR(20) NOT NULL,
    "panImageUrl" TEXT NOT NULL,
    "policeVerificationStatus" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "policeVerificationDate" TIMESTAMP(3),
    "bankAccountNumber" VARCHAR(255) NOT NULL,
    "bankIfscCode" VARCHAR(20) NOT NULL,
    "bankAccountHolderName" VARCHAR(255) NOT NULL,
    "upiId" VARCHAR(100),
    "currentLocationLat" DECIMAL(10,8),
    "currentLocationLng" DECIMAL(11,8),
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "vehicleTypes" "VehicleType"[] DEFAULT ARRAY[]::"VehicleType"[],
    "specializations" "Specialization"[] DEFAULT ARRAY[]::"Specialization"[],
    "languagesSpoken" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "uniformIssued" BOOLEAN NOT NULL DEFAULT false,
    "trainingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "trainingCompletionDate" TIMESTAMP(3),
    "insurancePolicyNumber" VARCHAR(100),
    "insuranceExpiryDate" TIMESTAMP(3),
    "totalTrips" INTEGER NOT NULL DEFAULT 0,
    "totalEarnings" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "pendingEarnings" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "acceptanceRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cancellationRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "averageResponseTime" INTEGER NOT NULL DEFAULT 0,
    "workingHours" JSONB,
    "documentsVerified" BOOLEAN NOT NULL DEFAULT false,
    "backgroundCheckStatus" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "currentVehicleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "bookingNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "driverId" TEXT,
    "bookingType" "BookingType" NOT NULL DEFAULT 'CITY',
    "status" "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "pickupLocationLat" DECIMAL(10,8) NOT NULL,
    "pickupLocationLng" DECIMAL(11,8) NOT NULL,
    "pickupAddress" TEXT NOT NULL,
    "dropLocationLat" DECIMAL(10,8),
    "dropLocationLng" DECIMAL(11,8),
    "dropAddress" TEXT,
    "scheduledTime" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "estimatedDistance" DECIMAL(10,2),
    "actualDistance" DECIMAL(10,2),
    "estimatedDuration" INTEGER,
    "actualDuration" INTEGER,
    "vehicleType" "VehicleType" NOT NULL DEFAULT 'CAR',
    "customerVehicleDetails" JSONB,
    "specialRequests" TEXT,
    "pricingBreakdown" JSONB,
    "totalAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "driverEarnings" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "platformCommission" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "commissionPercentage" DECIMAL(5,2) NOT NULL DEFAULT 12,
    "promoCodeId" TEXT,
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentId" TEXT,
    "customerRating" SMALLINT,
    "driverRating" SMALLINT,
    "customerReview" TEXT,
    "driverReview" TEXT,
    "cancellationReason" TEXT,
    "cancelledBy" "CancelledBy",
    "cancelledAt" TIMESTAMP(3),
    "cancellationCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "routePolyline" TEXT,
    "tripRecordingUrl" TEXT,
    "otp" VARCHAR(6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "locationLat" DECIMAL(10,8) NOT NULL,
    "locationLng" DECIMAL(11,8) NOT NULL,
    "speed" DECIMAL(6,2),
    "heading" DECIMAL(6,2),
    "accuracy" DECIMAL(6,2),
    "batteryLevel" SMALLINT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "gatewayTransactionId" VARCHAR(255),
    "gatewayResponse" JSONB,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "refundAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "refundReason" TEXT,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_payouts" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "bookingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payoutPeriodStart" TIMESTAMP(3) NOT NULL,
    "payoutPeriodEnd" TIMESTAMP(3) NOT NULL,
    "payoutMethod" VARCHAR(50) NOT NULL DEFAULT 'BANK_TRANSFER',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" VARCHAR(255),
    "remarks" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "driver_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "type" "PromotionType" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "maxDiscount" DECIMAL(10,2),
    "minOrderValue" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "usageLimitPerUser" INTEGER NOT NULL DEFAULT 1,
    "totalUsageLimit" INTEGER,
    "currentUsageCount" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "applicableFor" "UserType" NOT NULL DEFAULT 'CUSTOMER',
    "description" TEXT,
    "termsConditions" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "ratedById" TEXT NOT NULL,
    "ratedUserId" TEXT NOT NULL,
    "rating" SMALLINT NOT NULL,
    "review" TEXT,
    "categories" JSONB,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "ticketNumber" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingId" TEXT,
    "category" "TicketCategory" NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "subject" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "assignedTo" TEXT,
    "attachments" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "resolution" TEXT,
    "internalNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "imageUrl" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingId" TEXT,
    "policyType" "InsuranceType" NOT NULL,
    "policyNumber" VARCHAR(100) NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "coverageAmount" DECIMAL(10,2) NOT NULL,
    "premium" DECIMAL(10,2) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    "claimAmount" DECIMAL(10,2),
    "claimStatus" VARCHAR(50),
    "claimDate" TIMESTAMP(3),
    "policyDocument" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_incentives" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "incentiveType" "IncentiveType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "criteria" JSONB NOT NULL,
    "achieved" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "paidOut" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_incentives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_codes" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ownerType" "UserType" NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "rewardAmount" DECIMAL(10,2) NOT NULL,
    "referrerReward" DECIMAL(10,2) NOT NULL,
    "refereeReward" DECIMAL(10,2) NOT NULL,
    "totalRewardsEarned" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "registrationNumber" VARCHAR(20) NOT NULL,
    "make" VARCHAR(100) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "year" INTEGER NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "color" VARCHAR(50) NOT NULL,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "insurancePolicyNumber" VARCHAR(100),
    "insuranceExpiryDate" TIMESTAMP(3),
    "pucCertificate" VARCHAR(100),
    "pucExpiryDate" TIMESTAMP(3),
    "fitnessExpiryDate" TIMESTAMP(3),
    "currentDriverId" TEXT,
    "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "maintenanceHistory" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergencies" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "triggeredById" TEXT NOT NULL,
    "locationLat" DECIMAL(10,8) NOT NULL,
    "locationLng" DECIMAL(11,8) NOT NULL,
    "status" "EmergencyStatus" NOT NULL DEFAULT 'ACTIVE',
    "responders" JSONB[] DEFAULT ARRAY[]::JSONB[],
    "resolution" TEXT,
    "contactedAuthorities" BOOLEAN NOT NULL DEFAULT false,
    "policeNotified" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "emergencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporates" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(15) NOT NULL,
    "address" TEXT NOT NULL,
    "gstNumber" VARCHAR(20),
    "contactPerson" VARCHAR(100) NOT NULL,
    "contractStartDate" TIMESTAMP(3) NOT NULL,
    "contractEndDate" TIMESTAMP(3),
    "creditLimit" DECIMAL(12,2) NOT NULL,
    "usedCredit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "billingCycle" VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corporates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "deviceInfo" JSONB,
    "ipAddress" VARCHAR(45),
    "userAgent" TEXT,
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "phoneNumber" VARCHAR(15) NOT NULL,
    "otp" VARCHAR(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "otp_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "firstName" VARCHAR(100) NOT NULL,
    "lastName" VARCHAR(100) NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_configs" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" VARCHAR(100),

    CONSTRAINT "app_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "users"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_phoneNumber_idx" ON "users"("phoneNumber");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_userType_idx" ON "users"("userType");

-- CreateIndex
CREATE INDEX "users_isActive_idx" ON "users"("isActive");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_userId_key" ON "customer_profiles"("userId");

-- CreateIndex
CREATE INDEX "customer_profiles_userId_idx" ON "customer_profiles"("userId");

-- CreateIndex
CREATE INDEX "customer_profiles_corporateId_idx" ON "customer_profiles"("corporateId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_userId_key" ON "driver_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_licenseNumber_key" ON "driver_profiles"("licenseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_aadhaarNumber_key" ON "driver_profiles"("aadhaarNumber");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_panNumber_key" ON "driver_profiles"("panNumber");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_currentVehicleId_key" ON "driver_profiles"("currentVehicleId");

-- CreateIndex
CREATE INDEX "driver_profiles_userId_idx" ON "driver_profiles"("userId");

-- CreateIndex
CREATE INDEX "driver_profiles_isOnline_idx" ON "driver_profiles"("isOnline");

-- CreateIndex
CREATE INDEX "driver_profiles_isAvailable_idx" ON "driver_profiles"("isAvailable");

-- CreateIndex
CREATE INDEX "driver_profiles_currentLocationLat_currentLocationLng_idx" ON "driver_profiles"("currentLocationLat", "currentLocationLng");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_bookingNumber_key" ON "bookings"("bookingNumber");

-- CreateIndex
CREATE INDEX "bookings_customerId_idx" ON "bookings"("customerId");

-- CreateIndex
CREATE INDEX "bookings_driverId_idx" ON "bookings"("driverId");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "bookings"("status");

-- CreateIndex
CREATE INDEX "bookings_bookingType_idx" ON "bookings"("bookingType");

-- CreateIndex
CREATE INDEX "bookings_scheduledTime_idx" ON "bookings"("scheduledTime");

-- CreateIndex
CREATE INDEX "bookings_createdAt_idx" ON "bookings"("createdAt");

-- CreateIndex
CREATE INDEX "bookings_pickupLocationLat_pickupLocationLng_idx" ON "bookings"("pickupLocationLat", "pickupLocationLng");

-- CreateIndex
CREATE INDEX "locations_bookingId_idx" ON "locations"("bookingId");

-- CreateIndex
CREATE INDEX "locations_driverId_idx" ON "locations"("driverId");

-- CreateIndex
CREATE INDEX "locations_timestamp_idx" ON "locations"("timestamp");

-- CreateIndex
CREATE INDEX "payments_bookingId_idx" ON "payments"("bookingId");

-- CreateIndex
CREATE INDEX "payments_userId_idx" ON "payments"("userId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_createdAt_idx" ON "payments"("createdAt");

-- CreateIndex
CREATE INDEX "driver_payouts_driverId_idx" ON "driver_payouts"("driverId");

-- CreateIndex
CREATE INDEX "driver_payouts_status_idx" ON "driver_payouts"("status");

-- CreateIndex
CREATE INDEX "driver_payouts_initiatedAt_idx" ON "driver_payouts"("initiatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_code_key" ON "promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_code_idx" ON "promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_isActive_idx" ON "promotions"("isActive");

-- CreateIndex
CREATE INDEX "promotions_validFrom_validUntil_idx" ON "promotions"("validFrom", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ratings_bookingId_key" ON "ratings"("bookingId");

-- CreateIndex
CREATE INDEX "ratings_bookingId_idx" ON "ratings"("bookingId");

-- CreateIndex
CREATE INDEX "ratings_ratedById_idx" ON "ratings"("ratedById");

-- CreateIndex
CREATE INDEX "ratings_ratedUserId_idx" ON "ratings"("ratedUserId");

-- CreateIndex
CREATE INDEX "ratings_rating_idx" ON "ratings"("rating");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticketNumber_key" ON "support_tickets"("ticketNumber");

-- CreateIndex
CREATE INDEX "support_tickets_userId_idx" ON "support_tickets"("userId");

-- CreateIndex
CREATE INDEX "support_tickets_bookingId_idx" ON "support_tickets"("bookingId");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- CreateIndex
CREATE INDEX "support_tickets_priority_idx" ON "support_tickets"("priority");

-- CreateIndex
CREATE INDEX "support_tickets_createdAt_idx" ON "support_tickets"("createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_idx" ON "notifications"("userId");

-- CreateIndex
CREATE INDEX "notifications_isRead_idx" ON "notifications"("isRead");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "insurances_policyNumber_key" ON "insurances"("policyNumber");

-- CreateIndex
CREATE INDEX "insurances_userId_idx" ON "insurances"("userId");

-- CreateIndex
CREATE INDEX "insurances_policyNumber_idx" ON "insurances"("policyNumber");

-- CreateIndex
CREATE INDEX "insurances_status_idx" ON "insurances"("status");

-- CreateIndex
CREATE INDEX "driver_incentives_driverId_idx" ON "driver_incentives"("driverId");

-- CreateIndex
CREATE INDEX "driver_incentives_incentiveType_idx" ON "driver_incentives"("incentiveType");

-- CreateIndex
CREATE INDEX "driver_incentives_achieved_idx" ON "driver_incentives"("achieved");

-- CreateIndex
CREATE INDEX "driver_incentives_validFrom_validUntil_idx" ON "driver_incentives"("validFrom", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_ownerId_key" ON "referral_codes"("ownerId");

-- CreateIndex
CREATE INDEX "referral_codes_code_idx" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_codes_ownerId_idx" ON "referral_codes"("ownerId");

-- CreateIndex
CREATE INDEX "referral_codes_isActive_idx" ON "referral_codes"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_registrationNumber_key" ON "vehicles"("registrationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_currentDriverId_key" ON "vehicles"("currentDriverId");

-- CreateIndex
CREATE INDEX "vehicles_registrationNumber_idx" ON "vehicles"("registrationNumber");

-- CreateIndex
CREATE INDEX "vehicles_status_idx" ON "vehicles"("status");

-- CreateIndex
CREATE INDEX "emergencies_bookingId_idx" ON "emergencies"("bookingId");

-- CreateIndex
CREATE INDEX "emergencies_triggeredById_idx" ON "emergencies"("triggeredById");

-- CreateIndex
CREATE INDEX "emergencies_status_idx" ON "emergencies"("status");

-- CreateIndex
CREATE INDEX "emergencies_timestamp_idx" ON "emergencies"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "corporates_email_key" ON "corporates"("email");

-- CreateIndex
CREATE INDEX "corporates_email_idx" ON "corporates"("email");

-- CreateIndex
CREATE INDEX "corporates_isActive_idx" ON "corporates"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refreshToken_key" ON "sessions"("refreshToken");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_refreshToken_idx" ON "sessions"("refreshToken");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "otp_verifications_phoneNumber_idx" ON "otp_verifications"("phoneNumber");

-- CreateIndex
CREATE INDEX "otp_verifications_expiresAt_idx" ON "otp_verifications"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "admin_users_email_idx" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "app_configs_key_key" ON "app_configs"("key");

-- CreateIndex
CREATE INDEX "app_configs_key_idx" ON "app_configs"("key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "referral_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_corporateId_fkey" FOREIGN KEY ("corporateId") REFERENCES "corporates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_currentVehicleId_fkey" FOREIGN KEY ("currentVehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_payouts" ADD CONSTRAINT "driver_payouts_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_ratedById_fkey" FOREIGN KEY ("ratedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_ratedUserId_fkey" FOREIGN KEY ("ratedUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurances" ADD CONSTRAINT "insurances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_incentives" ADD CONSTRAINT "driver_incentives_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver_profiles"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergencies" ADD CONSTRAINT "emergencies_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_verifications" ADD CONSTRAINT "otp_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
