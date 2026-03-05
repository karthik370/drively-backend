import express from 'express';
import * as locationController from '../controllers/locationController';
import { authenticate, requireDriver } from '../middleware/auth';

const router = express.Router();

router.use(authenticate);

router.post('/update', requireDriver, locationController.updateDriverLocation);
router.get('/nearby-drivers', locationController.getNearbyDrivers);
router.get('/driver/:driverId', locationController.getDriverLocation);
router.post('/geocode', locationController.geocodeAddress);
router.post('/reverse-geocode', locationController.reverseGeocodeLocation);
router.post('/route', locationController.calculateRoute);
router.get('/trip-history/:bookingId', locationController.getTripHistory);

export default router;
