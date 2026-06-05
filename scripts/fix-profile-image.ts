import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const userId = 'd6e65912-715e-428e-acbd-19d6a46c584e';

  // Get the stored selfieUrl from KYC
  const kyc = await prisma.kycVerification.findUnique({
    where: { userId },
    select: { selfieUrl: true, status: true },
  });

  console.log('KYC status:', kyc?.status);
  console.log('selfieUrl type:', kyc?.selfieUrl ? (kyc.selfieUrl.startsWith('http') ? 'URL' : kyc.selfieUrl.startsWith('data:') ? 'dataURI' : 'base64') : 'none');
  console.log('selfieUrl preview:', kyc?.selfieUrl?.slice(0, 80));

  if (!kyc?.selfieUrl) {
    console.log('❌ No selfieUrl stored in KYC');
    return;
  }

  let profileImageValue: string;
  if (kyc.selfieUrl.startsWith('http')) {
    profileImageValue = kyc.selfieUrl;
  } else if (kyc.selfieUrl.startsWith('data:')) {
    profileImageValue = kyc.selfieUrl;
  } else {
    profileImageValue = `data:image/jpeg;base64,${kyc.selfieUrl}`;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { profileImage: profileImageValue },
  });

  console.log('✅ profileImage updated!');
  console.log('Value preview:', profileImageValue.slice(0, 80));
}

main().catch(console.error).finally(() => prisma.$disconnect());
