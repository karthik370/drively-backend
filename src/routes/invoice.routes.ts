import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import InvoiceController from '../controllers/invoice.controller';

const router = Router();

router.use(authenticate);

router.get('/:bookingId', InvoiceController.getInvoice);
router.get('/:bookingId/pdf', InvoiceController.downloadPdf);

export default router;
