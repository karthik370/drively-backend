import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
    getSubscriptionStatus,
    createSubscriptionOrder,
    verifySubscriptionPayment,
} from '../controllers/subscription.controller';

const router = Router();

router.use(authenticate);

router.get('/', getSubscriptionStatus);
router.post('/create', createSubscriptionOrder);
router.post('/verify', verifySubscriptionPayment);

export default router;
