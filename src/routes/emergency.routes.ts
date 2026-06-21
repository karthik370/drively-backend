import { Router, Response } from 'express';
import { authenticate, requireAdminAllowlist } from '../middleware/auth';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { EmergencyService } from '../services/emergency.service';
import { AppError } from '../middleware/errorHandler';

const router = Router();

router.use(authenticate);

/**
 * POST /api/v1/emergency/trigger
 * Trigger an SOS emergency with current GPS coordinates.
 */
router.post('/trigger', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) throw new AppError('Not authenticated', 401);

    const { bookingId, latitude, longitude } = req.body;
    if (!bookingId) throw new AppError('bookingId is required', 400);
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        throw new AppError('latitude and longitude are required numbers', 400);
    }

    const result = await EmergencyService.triggerSOS({ userId, bookingId, latitude, longitude });
    res.json({ success: true, data: result });
}));

/**
 * POST /api/v1/emergency/:emergencyId/resolve
 * Mark an emergency as resolved (user is safe).
 */
router.post('/:emergencyId/resolve', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) throw new AppError('Not authenticated', 401);

    const result = await EmergencyService.resolveEmergency(req.params.emergencyId, userId);
    res.json({ success: true, data: result });
}));

/**
 * GET /api/v1/emergency/active
 * List all active emergencies (admin only — checked by phone).
 */
router.get('/active', requireAdminAllowlist, asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) throw new AppError('Not authenticated', 401);

    const emergencies = await EmergencyService.getActiveEmergencies();
    res.json({ success: true, data: emergencies });
}));

/**
 * GET /api/v1/emergency/contacts
 * Get saved emergency contacts for the current user.
 */
router.get('/contacts', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) throw new AppError('Not authenticated', 401);

    const contacts = await EmergencyService.getEmergencyContacts(userId);
    res.json({ success: true, data: contacts });
}));

/**
 * PUT /api/v1/emergency/contacts
 * Save emergency contacts for the current user (stored in CustomerProfile).
 */
router.put('/contacts', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) throw new AppError('Not authenticated', 401);

    const { contacts } = req.body;
    if (!Array.isArray(contacts)) throw new AppError('contacts must be an array', 400);

    const saved = await EmergencyService.saveEmergencyContacts(userId, contacts);
    res.json({ success: true, data: saved });
}));

export default router;
