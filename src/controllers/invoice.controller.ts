import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { AppError, asyncHandler } from '../middleware/errorHandler';
import { InvoiceService } from '../services/invoice.service';

export class InvoiceController {
  static getInvoice = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const bookingId = String(req.params.bookingId || '');
    if (!bookingId) throw new AppError('bookingId is required', 400);

    const data = await InvoiceService.getInvoiceForBooking({
      userId: req.user.id,
      bookingId,
    });

    res.status(200).json({ success: true, data });
  });

  static downloadPdf = asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) throw new AppError('Not authenticated', 401);

    const bookingId = String(req.params.bookingId || '');
    if (!bookingId) throw new AppError('bookingId is required', 400);

    const buffer = await InvoiceService.renderInvoicePdf({
      userId: req.user.id,
      bookingId,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=invoice-${bookingId}.pdf`);
    res.status(200).send(buffer);
  });
}

export default InvoiceController;
