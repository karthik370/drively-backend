import { Router } from 'express';
import { authenticate, requireCustomerOrOfflineDriver } from '../middleware/auth';
import PromotionController from '../controllers/promotion.controller';

const router = Router();

router.use(authenticate);
router.use(requireCustomerOrOfflineDriver);

router.get('/', PromotionController.listActive);
router.post('/validate', PromotionController.validate);

export default router;
