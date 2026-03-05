import { Router } from 'express';
import { authenticate, requireAdminAllowlist } from '../middleware/auth';
import AdminController from '../controllers/admin.controller';

const router = Router();

router.use(authenticate);
router.use(requireAdminAllowlist);

router.get('/driver-verifications/pending', AdminController.getPendingDriverVerifications);
router.get('/driver-verifications/:driverId', AdminController.getDriverVerificationDetails);
router.post('/driver-verifications/:driverId', AdminController.verifyDriverDocuments);

router.get('/refunds/pending', AdminController.getPendingRefunds);
router.post('/refunds/:refundId/mark-paid', AdminController.markRefundPaid);

export default router;
