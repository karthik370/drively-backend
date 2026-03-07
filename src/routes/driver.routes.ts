import { Router } from 'express';
import { authenticate, requireDriver } from '../middleware/auth';
import DriverController, { multerUpload } from '../controllers/driver.controller';

const router = Router();

// Public route to view images (bypasses auth so the mobile app's Image component can easily load them)
router.get('/uploads/*', DriverController.downloadImage);

router.use(authenticate);
router.use(requireDriver);

router.patch('/status/online', DriverController.goOnline);
router.patch('/status/offline', DriverController.goOffline);

router.get('/documents/status', DriverController.getDocumentsStatus);
// Multipart upload — multer-s3 streams the file directly to Tigris
router.post('/uploads/image', multerUpload.single('image'), DriverController.uploadImage as any);
router.post('/documents/submit', DriverController.submitDocuments);

router.get('/availability', DriverController.getAvailability);
router.patch('/availability', DriverController.updateAvailability);

router.get('/earnings', DriverController.getEarnings);
router.get('/earnings/breakdown', DriverController.getEarningsBreakdown);

router.post('/payout/request', DriverController.requestPayout);

router.get('/metrics', DriverController.getMetrics);
router.get('/trips', DriverController.getTrips);

export default router;
