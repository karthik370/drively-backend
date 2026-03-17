import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/msg91/verify-access-token', AuthController.verifyMsg91AccessToken);
router.post('/send-otp', AuthController.sendOtp);
router.post('/verify-otp', AuthController.verifyOtp);
router.post('/signup', AuthController.signup);
router.post('/login', AuthController.login);
router.post('/refresh-token', AuthController.refreshToken);
router.post('/logout', authenticate, AuthController.logout);
router.post('/logout-all-devices', authenticate, AuthController.logoutAllDevices);
router.get('/me', authenticate, AuthController.getMe);
router.post('/social-login', AuthController.socialLogin);
// Admin direct login — no OTP, validated by ADMIN_SECRET_KEY env var
router.post('/admin/login', AuthController.adminLogin);

export default router;
