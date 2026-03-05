import admin from 'firebase-admin';
import twilio from 'twilio';
import { logger } from '../utils/logger';

let firebaseInitialized = false;

const initializeFirebaseIfNeeded = () => {
  if (firebaseInitialized) {
    return;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    return;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    });
    firebaseInitialized = true;
    logger.info('Firebase Admin initialized');
  } catch (error) {
    logger.error('Failed to initialize Firebase Admin', { error });
  }
};

const shouldSendSmsViaTwilio = (): boolean => {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  return process.env.TWILIO_SEND_IN_DEV === 'true';
};

let twilioClient: ReturnType<typeof twilio> | null = null;

const getTwilioClient = () => {
  if (twilioClient) {
    return twilioClient;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return null;
  }

  try {
    twilioClient = twilio(accountSid, authToken);
    return twilioClient;
  } catch (error) {
    logger.error('Failed to initialize Twilio client', { error });
    return null;
  }
};

export const sendSmsNotification = async (params: { to: string; body: string }): Promise<void> => {
  if (!shouldSendSmsViaTwilio()) {
    logger.info('[DEV MODE] SMS skipped (set TWILIO_SEND_IN_DEV=true to enable)', {
      to: params.to,
    });
    return;
  }

  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) {
    logger.warn('SMS notification skipped: TWILIO_PHONE_NUMBER not configured');
    return;
  }

  const client = getTwilioClient();
  if (!client) {
    logger.warn('SMS notification skipped: Twilio not configured');
    return;
  }

  const to = params.to?.trim();
  const body = params.body?.trim();
  if (!to || !body) {
    return;
  }

  try {
    await client.messages.create({
      to,
      from,
      body,
    });
  } catch (error) {
    logger.error('Failed to send SMS notification', { error });
  }
};

export const sendPushNotification = async (params: {
  deviceTokens: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
}): Promise<void> => {
  const tokens = (params.deviceTokens || []).filter(Boolean);
  if (tokens.length === 0) {
    return;
  }

  initializeFirebaseIfNeeded();
  if (!firebaseInitialized) {
    logger.warn('Push notification skipped: Firebase not configured');
    return;
  }

  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: {
        title: params.title,
        body: params.body,
      },
      data: params.data,
    });

    if (response.failureCount > 0) {
      logger.warn('Some push notifications failed', {
        failureCount: response.failureCount,
      });
    }
  } catch (error) {
    logger.error('Failed to send push notification', { error });
  }
};

export default {
  sendPushNotification,
  sendSmsNotification,
};
