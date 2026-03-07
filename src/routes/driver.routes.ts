import { Router } from 'express';
import { authenticate, requireDriver } from '../middleware/auth';
import multer from 'multer';
import DriverController from '../controllers/driver.controller';

const router = Router();

router.use(authenticate);
router.use(requireDriver);

router.patch('/status/online', DriverController.goOnline);
router.patch('/status/offline', DriverController.goOffline);

router.get('/documents/status', DriverController.getDocumentsStatus);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 6 * 1024 * 1024 } // 6MB limit
});

// Native binary upload via multipart/form-data
router.post('/uploads/image', upload.single('file'), DriverController.uploadImage as any);
router.post('/documents/submit', DriverController.submitDocuments);

router.get('/availability', DriverController.getAvailability);
router.patch('/availability', DriverController.updateAvailability);

router.get('/earnings', DriverController.getEarnings);
router.get('/earnings/breakdown', DriverController.getEarningsBreakdown);

router.post('/payout/request', DriverController.requestPayout);

router.get('/metrics', DriverController.getMetrics);
router.get('/trips', DriverController.getTrips);

export default router;
