import { Router } from 'express';
import { authenticate, requireCustomerOrOfflineDriver } from '../middleware/auth';
import PaymentController from '../controllers/payment.controller';

const router = Router();

router.post('/webhook/cashfree', PaymentController.cashfreeWebhook);

router.use(authenticate);

router.post('/orders', requireCustomerOrOfflineDriver, PaymentController.createOrder);
router.post('/verify', requireCustomerOrOfflineDriver, PaymentController.verifyPayment);
router.get('/status/:bookingId', requireCustomerOrOfflineDriver, PaymentController.getBookingPaymentStatus);

export default router;
