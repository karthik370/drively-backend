import { BookingStatus, InvoiceStatus } from '@prisma/client';
import PDFDocument from 'pdfkit';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

const formatMoney = (n: number) => `₹${n.toFixed(2)}`;

const formatDate = (d: Date | null | undefined) => {
  if (!d) return '';
  return d.toISOString().replace('T', ' ').slice(0, 19);
};

const buildInvoiceNumber = (bookingNumber: string) => {
  const safe = bookingNumber.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  return `INV-${safe}-${Date.now()}`;
};

export class InvoiceService {
  static async ensureInvoiceForBooking(params: { bookingId: string }) {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        bookingNumber: true,
        status: true,
        totalAmount: true,
        discountAmount: true,
        platformCommission: true,
        driverEarnings: true,
        pickupAddress: true,
        dropAddress: true,
        createdAt: true,
        completedAt: true,
        customer: { select: { id: true, firstName: true, lastName: true, phoneNumber: true, email: true } },
        driver: { select: { id: true, firstName: true, lastName: true, phoneNumber: true } },
      },
    });

    if (!booking) {
      throw new AppError('Booking not found', 404);
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new AppError('Invoice is available only after trip completion', 400);
    }

    const existing = await prisma.invoice.findUnique({ where: { bookingId: booking.id } });
    if (existing) return existing;

    const invoiceNumber = buildInvoiceNumber(booking.bookingNumber);

    return await prisma.invoice.create({
      data: {
        bookingId: booking.id,
        invoiceNumber,
        status: InvoiceStatus.GENERATED,
        amount: booking.totalAmount,
        currency: 'INR',
        meta: {
          bookingNumber: booking.bookingNumber,
          pickupAddress: booking.pickupAddress,
          dropAddress: booking.dropAddress,
          createdAt: booking.createdAt,
          completedAt: booking.completedAt,
          customer: booking.customer,
          driver: booking.driver,
          totalAmount: booking.totalAmount,
          discountAmount: booking.discountAmount,
          platformCommission: booking.platformCommission,
          driverEarnings: booking.driverEarnings,
        } as any,
      },
    });
  }

  static async getInvoiceForBooking(params: { userId: string; bookingId: string }) {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: { id: true, customerId: true, driverId: true },
    });

    if (!booking) throw new AppError('Booking not found', 404);

    if (booking.customerId !== params.userId && booking.driverId !== params.userId) {
      throw new AppError('Not authorized for this booking', 403);
    }

    const invoice = await this.ensureInvoiceForBooking({ bookingId: booking.id });

    return {
      id: invoice.id,
      bookingId: invoice.bookingId,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      createdAt: invoice.createdAt,
      pdfUrl: invoice.pdfUrl,
    };
  }

  static async renderInvoicePdf(params: { userId: string; bookingId: string }) {
    const booking = await prisma.booking.findUnique({
      where: { id: params.bookingId },
      select: {
        id: true,
        customerId: true,
        driverId: true,
        bookingNumber: true,
        status: true,
        totalAmount: true,
        discountAmount: true,
        platformCommission: true,
        driverEarnings: true,
        pickupAddress: true,
        dropAddress: true,
        createdAt: true,
        completedAt: true,
        paymentMethod: true,
        paymentStatus: true,
        customer: { select: { firstName: true, lastName: true, phoneNumber: true, email: true } },
        driver: { select: { firstName: true, lastName: true, phoneNumber: true } },
      },
    });

    if (!booking) throw new AppError('Booking not found', 404);

    if (booking.customerId !== params.userId && booking.driverId !== params.userId) {
      throw new AppError('Not authorized for this booking', 403);
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new AppError('Invoice is available only after trip completion', 400);
    }

    await this.ensureInvoiceForBooking({ bookingId: booking.id });

    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];

    doc.on('data', (b: unknown) => {
      if (Buffer.isBuffer(b)) {
        chunks.push(b);
      } else if (typeof b === 'string') {
        chunks.push(Buffer.from(b));
      }
    });

    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (e: unknown) => reject(e));
    });

    doc.fontSize(20).text('DriveMate Invoice', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#444444').text(`Booking: ${booking.bookingNumber}`);
    doc.text(`Created: ${formatDate(booking.createdAt)}`);
    doc.text(`Completed: ${formatDate(booking.completedAt || null)}`);
    doc.text(`Payment: ${booking.paymentMethod} (${booking.paymentStatus})`);

    doc.moveDown(1);
    doc.fillColor('#111111').fontSize(12).text('Customer');
    doc.fontSize(10).fillColor('#444444').text(`${booking.customer.firstName} ${booking.customer.lastName}`);
    doc.text(`${booking.customer.phoneNumber}${booking.customer.email ? ` | ${booking.customer.email}` : ''}`);

    doc.moveDown(0.5);
    doc.fillColor('#111111').fontSize(12).text('Driver');
    doc.fontSize(10).fillColor('#444444').text(`${booking.driver?.firstName || ''} ${booking.driver?.lastName || ''}`.trim() || '—');
    doc.text(booking.driver?.phoneNumber ? `${booking.driver.phoneNumber}` : '');

    doc.moveDown(1);
    doc.fillColor('#111111').fontSize(12).text('Trip');
    doc.fontSize(10).fillColor('#444444').text(`Pickup: ${booking.pickupAddress}`);
    if (booking.dropAddress) doc.text(`Drop: ${booking.dropAddress}`);

    const total = Number(booking.totalAmount);
    const discount = Number(booking.discountAmount || 0);
    const gross = total + discount;
    const commission = Number(booking.platformCommission || 0);
    const earnings = Number(booking.driverEarnings || 0);

    doc.moveDown(1);
    doc.fillColor('#111111').fontSize(12).text('Charges');
    doc.fontSize(10).fillColor('#444444').text(`Total fare: ${formatMoney(gross)}`);
    if (discount > 0) doc.text(`Discount: -${formatMoney(discount)}`);
    doc.text(`Platform commission: ${formatMoney(commission)}`);
    doc.text(`Driver earnings: ${formatMoney(earnings)}`);

    doc.moveDown(2);
    doc.fillColor('#111111').fontSize(12).text('Amount paid');
    doc.fontSize(16).fillColor('#111111').text(formatMoney(total), { align: 'left' });

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#666666').text('This is a system-generated invoice.', { align: 'left' });

    doc.end();

    return await done;
  }
}
