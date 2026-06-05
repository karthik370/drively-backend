import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const userId = 'd6e65912-715e-428e-acbd-19d6a46c584e';

  // Fix profileImage — add data URI prefix if it's raw base64
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { profileImage: true } });
  if (user?.profileImage && !user.profileImage.startsWith('data:') && !user.profileImage.startsWith('http')) {
    const fixed = `data:image/jpeg;base64,${user.profileImage}`;
    await prisma.user.update({ where: { id: userId }, data: { profileImage: fixed } });
    console.log('✅ ProfileImage fixed — added data URI prefix');
  } else {
    console.log('ℹ️  ProfileImage already correct or not set:', user?.profileImage?.slice(0, 50));
  }

  // Reset KYC to FACE_MATCH_PENDING — keep Aadhaar/PAN/DL verified
  const kyc = await prisma.kycVerification.update({
    where: { userId },
    data: {
      status: 'FACE_MATCH_PENDING' as any,
      faceMatchScore: null,
      faceMatchPassed: false,
      selfieUrl: null,
      completedAt: null,
      failureReason: null,
    },
  });

  // Reset driver verification on DriverProfile
  await prisma.driverProfile.updateMany({
    where: { userId },
    data: {
      documentsVerified: false,
      backgroundCheckStatus: 'PENDING' as any,
    },
  });

  console.log('✅ KYC reset to FACE_MATCH_PENDING');
  console.log({
    status: kyc.status,
    aadhaarVerified: kyc.aadhaarVerified,
    panVerified: kyc.panVerified,
    dlVerified: kyc.dlVerified,
    faceMatchPassed: kyc.faceMatchPassed,
    faceMatchScore: kyc.faceMatchScore,
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
