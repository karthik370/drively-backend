import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { ReferralService } from '../services/referral.service';
import { IncentiveService } from '../services/incentive.service';
import { RewardsService } from '../services/rewards.service';
import { DiscountService } from '../services/discount.service';
import { FavoriteDriverService } from '../services/favoriteDriver.service';

const router = Router();
router.use(authenticate);

// ── Referrals ───────────────────────────────────────────────────────

router.get('/referral/my-code', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const type = req.query.type === 'DRIVER' ? 'DRIVER' : 'CUSTOMER';
    const data = await ReferralService.getOrCreateCode(userId, type);
    res.json({ success: true, data });
}));

router.post('/referral/apply', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const data = await ReferralService.applyReferralCode(req.body.code, userId);
    res.json({ success: true, data });
}));

router.get('/referral/stats', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const data = await ReferralService.getReferralStats(userId);
    res.json({ success: true, data });
}));

// ── Driver Incentives ───────────────────────────────────────────────

router.get('/incentives', asyncHandler(async (_req: AuthRequest, res: Response) => {
    const data = await IncentiveService.getActiveIncentives();
    res.json({ success: true, data });
}));

router.get('/incentives/progress', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const data = await IncentiveService.getDriverProgress(userId);
    res.json({ success: true, data });
}));

// ── Rewards Coins ───────────────────────────────────────────────────

router.get('/rewards/balance', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const balance = await RewardsService.getBalance(userId);
    res.json({ success: true, data: { balance } });
}));

router.get('/rewards/summary', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const data = await RewardsService.getSummary(userId);
    res.json({ success: true, data });
}));

router.get('/rewards/history', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const limit = parseInt(req.query.limit as string) || 50;
    const data = await RewardsService.getHistory(userId, limit);
    res.json({ success: true, data });
}));

router.post('/rewards/redeem', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const { coins, bookingId } = req.body;
    const data = await RewardsService.redeemCoins(userId, coins, bookingId);
    res.json({ success: true, data });
}));

// ── Discount Preview ────────────────────────────────────────────────

router.get('/discounts/preview', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const amount = Number(req.query.amount || 0);
    const data = await DiscountService.getDiscountPreview(userId, amount);
    res.json({ success: true, data });
}));

// ── Favorite Drivers ────────────────────────────────────────────────

router.get('/favorite-drivers', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const data = await FavoriteDriverService.getFavoriteDrivers(userId);
    res.json({ success: true, data });
}));

router.post('/favorite-drivers/:driverId', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const data = await FavoriteDriverService.addFavoriteDriver(userId, req.params.driverId);
    res.json({ success: true, data });
}));

router.delete('/favorite-drivers/:driverId', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const data = await FavoriteDriverService.removeFavoriteDriver(userId, req.params.driverId);
    res.json({ success: true, data });
}));

router.get('/favorite-drivers/:driverId/check', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const isFavorite = await FavoriteDriverService.isFavorite(userId, req.params.driverId);
    res.json({ success: true, data: { isFavorite } });
}));

export default router;
