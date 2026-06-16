/**
 * Single source of truth for admin identity.
 * Only phone 6304767391 is admin — hardcoded, no env parsing that can break.
 */

/** Last-10-digits of the admin phone number */
export const ADMIN_PHONE_LAST10 = '6304767391';

const normalizePhoneDigits = (phone: string): string => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
};

/** Returns true if the given phone number belongs to the admin */
export const isAdminPhone = (phone: string): boolean => {
  return normalizePhoneDigits(phone) === ADMIN_PHONE_LAST10;
};

/** Fetches the admin user's DB id (cached for 60 s per process) */
let _adminUserIdCache: string | null = null;
let _adminUserIdCacheTs = 0;

export const getAdminUserId = async (prisma: any): Promise<string | null> => {
  const now = Date.now();
  if (_adminUserIdCache && now - _adminUserIdCacheTs < 60_000) {
    return _adminUserIdCache;
  }
  try {
    // Try both +91 prefix and bare 10-digit formats
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { phoneNumber: { endsWith: ADMIN_PHONE_LAST10 } },
        ],
      },
      select: { id: true },
    });
    _adminUserIdCache = user?.id ?? null;
    _adminUserIdCacheTs = now;
    return _adminUserIdCache;
  } catch {
    return null;
  }
};

/** Returns array of admin user IDs (always just one) */
export const getAdminUserIds = async (prisma: any): Promise<string[]> => {
  const id = await getAdminUserId(prisma);
  return id ? [id] : [];
};
