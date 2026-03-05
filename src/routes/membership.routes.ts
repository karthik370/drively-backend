import { Router } from 'express';
import { authenticate, requireCustomerOrOfflineDriver } from '../middleware/auth';
import MembershipController from '../controllers/membership.controller';

const router = Router();

router.get('/plans', MembershipController.listPlans);

router.use(authenticate);
router.use(requireCustomerOrOfflineDriver);

router.get('/current', MembershipController.current);
router.post('/orders', MembershipController.createOrder);
router.post('/verify', MembershipController.verify);

export default router;
