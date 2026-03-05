import axios from 'axios';
import prisma from '../config/database';
import { logger } from '../utils/logger';

export type ExpoPushData = Record<string, string>;

const isExpoToken = (t: string): boolean => {
  const s = String(t || '').trim();
  return s.startsWith('ExponentPushToken[') || s.startsWith('ExpoPushToken[');
};

export const listExpoTokensForUsers = async (userIds: string[]): Promise<string[]> => {
  const ids = Array.from(new Set((userIds || []).map((u) => String(u || '').trim()).filter(Boolean)));
  if (ids.length === 0) return [];

  try {
    const rows = await (prisma as any).expoPushToken.findMany({
      where: { userId: { in: ids }, isActive: true },
      select: { token: true },
    });
    return rows
      .map((r: any) => String(r?.token || '').trim())
      .filter(Boolean)
      .filter(isExpoToken);
  } catch (error) {
    logger.warn('Failed to load Expo push tokens', { error });
    return [];
  }
};

export const sendExpoPushNotification = async (params: {
  userIds: string[];
  title: string;
  body: string;
  data?: ExpoPushData;
}): Promise<void> => {
  const title = String(params.title || '').trim();
  const body = String(params.body || '').trim();
  if (!title || !body) return;

  const tokens = await listExpoTokensForUsers(params.userIds || []);
  if (tokens.length === 0) return;

  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
    data: params.data || {},
  }));

  try {
    // Expo recommends chunking. Keep it simple but safe.
    const chunkSize = 90;
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize);
      const res = await axios.post('https://exp.host/--/api/v2/push/send', chunk, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' },
      });

      const data = res?.data;
      if (data?.data && Array.isArray(data.data)) {
        const bad = data.data.filter((t: any) => t?.status === 'error');
        if (bad.length) {
          logger.warn('Expo push send had errors', { errors: bad.slice(0, 5) });
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to send Expo push notifications', { error });
  }
};

export default {
  sendExpoPushNotification,
  listExpoTokensForUsers,
};
