import { Router } from 'express';
import { authenticate, requireAdminAllowlist } from '../middleware/auth';
import AdminController from '../controllers/admin.controller';

const router = Router();

// ── ALL routes below require: (1) valid JWT, (2) phone in ADMIN_PHONE_NUMBERS env ──
router.use(authenticate);
router.use(requireAdminAllowlist);

router.get('/driver-verifications/pending', AdminController.getPendingDriverVerifications);
router.get('/driver-verifications/:driverId', AdminController.getDriverVerificationDetails);
router.post('/driver-verifications/:driverId', AdminController.verifyDriverDocuments);

router.get('/refunds/pending', AdminController.getPendingRefunds);
router.post('/refunds/:refundId/mark-paid', AdminController.markRefundPaid);

// ── Withdrawal / Payout management ──
router.get('/payouts/pending', AdminController.getPendingPayouts);
router.post('/payouts/:payoutId/approve', AdminController.approvePayout);
router.post('/payouts/:payoutId/reject', AdminController.rejectPayout);

// ── Manual wallet credit (admin-only, full audit trail) ──
// POST /admin/wallet/credit  { phone, amount, note? }
router.post('/wallet/credit', AdminController.manualWalletCredit);

export default router;
