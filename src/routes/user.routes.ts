import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import UserController from '../controllers/user.controller';

const router = Router();

router.use(authenticate);

router.patch('/profile', UserController.updateProfile);

router.post('/push-token/expo', UserController.registerExpoPushToken);

router.get('/saved-addresses', UserController.getSavedAddresses);
router.post('/saved-addresses', UserController.addSavedAddress);
router.delete('/saved-addresses/:addressId', UserController.deleteSavedAddress);

export default router;
