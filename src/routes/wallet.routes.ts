import { Router } from 'express';
import { authenticate, requireCustomerOrOfflineDriver } from '../middleware/auth';
import WalletController from '../controllers/wallet.controller';

const router = Router();

router.use(authenticate);
router.use(requireCustomerOrOfflineDriver);

router.get('/balance', WalletController.getBalance);
router.get('/transactions', WalletController.getTransactions);
router.post('/topup/orders', WalletController.createTopupOrder);
router.post('/topup/verify', WalletController.verifyTopup);
router.post('/pay-booking', WalletController.payBookingWithWallet);

export default router;
