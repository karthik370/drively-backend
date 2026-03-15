import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { DriverWalletService } from '../services/driverWallet.service';

const router = Router();

// ── PUBLIC routes (no auth — called by Cashfree) ──

// Cashfree Payout Webhook — receives transfer SUCCESS/FAILED notifications
router.post('/webhook/payout', asyncHandler(async (req: any, res: Response) => {
    const signature = typeof req.headers['x-webhook-signature'] === 'string'
        ? req.headers['x-webhook-signature']
        : null;
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);

    const result = await DriverWalletService.handlePayoutWebhook(req.body, signature, rawBody);
    res.json({ success: true, ...result });
}));

// ── AUTHENTICATED routes (driver must be logged in) ──
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
    const { amount, method, upiId, bankAccountNumber, bankIfscCode, bankAccountHolderName } = req.body;
    if (!amount || !method) {
        res.status(400).json({ success: false, message: 'Amount and method required' });
        return;
    }
    const data = await DriverWalletService.requestPayout(userId, amount, method, { upiId, bankAccountNumber, bankIfscCode, bankAccountHolderName });
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
