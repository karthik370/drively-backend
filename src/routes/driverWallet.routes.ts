import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { DriverWalletService } from '../services/driverWallet.service';

const router = Router();
router.use(authenticate);

// Wallet summary
router.get('/summary', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const data = await DriverWalletService.getWalletSummary(userId);
    res.json({ success: true, data });
}));

// Transaction history
router.get('/transactions', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const limit = parseInt(req.query.limit as string) || 50;
    const data = await DriverWalletService.getTransactionHistory(userId, limit);
    res.json({ success: true, data });
}));

// Request payout
router.post('/payout', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const { amount, method } = req.body;
    if (!amount || !method) {
        res.status(400).json({ success: false, message: 'Amount and method required' });
        return;
    }
    const data = await DriverWalletService.requestPayout(userId, amount, method);
    res.json({ success: true, data });
}));

// Payout history
router.get('/payouts', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const data = await DriverWalletService.getPayoutHistory(userId);
    res.json({ success: true, data });
}));

export default router;
