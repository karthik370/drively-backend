import { Router, Request, Response } from 'express';
import { authenticate, requireCustomerOrOfflineDriver, requireDriver } from '../middleware/auth';
import BookingController from '../controllers/booking.controller';
import { TripShareService } from '../services/tripShare.service';
import { AuthRequest } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

// Public route — no auth needed (for family/friends tracking)
router.get('/track/:shareToken', asyncHandler(async (req: Request, res: Response) => {
    const data = await TripShareService.getPublicTracking(req.params.shareToken);
    res.json({ success: true, data });
}));

router.use(authenticate);

router.post('/', requireCustomerOrOfflineDriver, BookingController.createBooking);
router.get('/available', requireDriver, BookingController.getAvailableBookings);
router.get('/active', BookingController.getActiveBooking);
router.get('/user/history', BookingController.getUserBookingHistory);
router.get('/:bookingId', BookingController.getBooking);

router.post('/:bookingId/accept', requireDriver, BookingController.acceptBooking);
router.post('/:bookingId/reject', requireDriver, BookingController.rejectBooking);

router.post('/:bookingId/verify-otp', requireDriver, BookingController.verifyBookingOtp);

router.post('/:bookingId/rate', requireCustomerOrOfflineDriver, BookingController.rateBooking);

router.patch('/:bookingId/status', BookingController.updateBookingStatus);
router.post('/:bookingId/cancel', BookingController.cancelBooking);

// Trip sharing — generate share link
router.post('/:bookingId/share', asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: 'Not authenticated' }); return; }
    const data = await TripShareService.createShareLink(req.params.bookingId, userId);
    res.json({ success: true, data });
}));

export default router;
