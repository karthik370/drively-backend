import { Router } from 'express';
import { authenticate, requireDriver } from '../middleware/auth';
import DriverController from '../controllers/driver.controller';

const router = Router();

router.use(authenticate);
router.use(requireDriver);

router.patch('/status/online', DriverController.goOnline);
router.patch('/status/offline', DriverController.goOffline);

router.get('/documents/status', DriverController.getDocumentsStatus);
router.post('/uploads/presign', (DriverController as any).presignUpload);
router.post('/documents/submit', DriverController.submitDocuments);

router.get('/availability', DriverController.getAvailability);
router.patch('/availability', DriverController.updateAvailability);

router.get('/earnings', DriverController.getEarnings);
router.get('/earnings/breakdown', DriverController.getEarningsBreakdown);

router.post('/payout/request', DriverController.requestPayout);

router.get('/metrics', DriverController.getMetrics);
router.get('/trips', DriverController.getTrips);

export default router;
