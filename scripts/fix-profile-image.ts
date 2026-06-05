import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const userId = 'd6e65912-715e-428e-acbd-19d6a46c584e';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { profileImage: true },
  });

  const img = user?.profileImage;
  if (!img) {
    console.log('No profileImage set');
    return;
  }
  if (img.startsWith('data:') || img.startsWith('http')) {
    console.log('✅ ProfileImage already correct:', img.slice(0, 60));
    return;
  }
  // Raw base64 — add prefix
  await prisma.user.update({
    where: { id: userId },
    data: { profileImage: `data:image/jpeg;base64,${img}` },
  });
  console.log('✅ Fixed: added data:image/jpeg;base64, prefix to profileImage');
}

main().catch(console.error).finally(() => prisma.$disconnect());
