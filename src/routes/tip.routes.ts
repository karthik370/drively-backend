import { Router } from 'express';
import { authenticate, requireCustomerOrOfflineDriver } from '../middleware/auth';
import TipController from '../controllers/tip.controller';

const router = Router();

router.use(authenticate);
router.use(requireCustomerOrOfflineDriver);

router.post('/', TipController.create);
router.post('/wallet/pay', TipController.payWithWallet);
router.post('/orders', TipController.createOrder);
router.post('/verify', TipController.verify);

export default router;
