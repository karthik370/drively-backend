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
        pricingBreakdown: true,
        experiencedDriverFee: true,
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

    // Determine the viewer role
    const isDriverView = booking.driverId === params.userId;

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

    const total = Number(booking.totalAmount);
    const discount = Number(booking.discountAmount || 0);
    const earnings = Number(booking.driverEarnings || 0);
    const commission = Number(booking.platformCommission || 0);
    const pb = (booking as any).pricingBreakdown || {};
    const discountsObj = pb?.discounts || {};
    const subsidy = Number(pb?.platformSubsidy ?? discountsObj?.platformSubsidy ?? 0);
    const computedSubsidy = subsidy > 0 ? subsidy : Math.max(0, earnings - total);

    // ── Header ─────────────────────────────────────────────────────────────
    doc.fontSize(22).text(isDriverView ? 'Trip Earnings Statement' : 'Trip Invoice', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#888888').text(isDriverView
      ? 'Driver copy — your personal earnings record'
      : 'Customer copy — for your records');
    doc.moveDown(0.5);
    doc.fillColor('#444444').fontSize(10).text(`Booking: ${booking.bookingNumber}`);
    doc.text(`Created: ${formatDate(booking.createdAt)}`);
    doc.text(`Completed: ${formatDate(booking.completedAt || null)}`);
    doc.text(`Payment: ${booking.paymentMethod} (${booking.paymentStatus})`);

    // ── Parties ─────────────────────────────────────────────────────────────
    doc.moveDown(1);
    doc.fillColor('#111111').fontSize(12).text('Customer');
    doc.fontSize(10).fillColor('#444444').text(`${booking.customer.firstName} ${booking.customer.lastName}`);
    doc.text(`${booking.customer.phoneNumber}${booking.customer.email ? ` | ${booking.customer.email}` : ''}`);

    doc.moveDown(0.5);
    doc.fillColor('#111111').fontSize(12).text('Driver');
    doc.fontSize(10).fillColor('#444444').text(`${booking.driver?.firstName || ''} ${booking.driver?.lastName || ''}`.trim() || '—');
    if (booking.driver?.phoneNumber) doc.text(booking.driver.phoneNumber);

    // ── Trip ────────────────────────────────────────────────────────────────
    doc.moveDown(1);
    doc.fillColor('#111111').fontSize(12).text('Trip');
    doc.fontSize(10).fillColor('#444444').text(`Pickup: ${booking.pickupAddress}`);
    if (booking.dropAddress) doc.text(`Drop: ${booking.dropAddress}`);

    // ── Fare Breakdown ───────────────────────────────────────────────────────
    doc.moveDown(1);

    if (isDriverView) {
      // ── DRIVER VIEW ──────────────────────────────────────────────────────
      doc.fillColor('#111111').fontSize(12).text('Your Earnings Breakdown');
      doc.fontSize(10).fillColor('#444444');

      // Base fare items (same as customer — these are the actual meter charges)
      const packagePrice = Number(pb?.packagePrice || pb?.baseAmount || 0);
      if (packagePrice > 0) {
        const pkgHours = Number(pb?.packageHours || 0);
        doc.text(`${pkgHours > 0 ? `Package (${pkgHours}hr)` : 'Base fare'}: ${formatMoney(packagePrice)}`);
      }
      const oneWayCharge = Number(pb?.oneWayCharge || 0);
      if (oneWayCharge > 0) doc.text(`One-way charge: ${formatMoney(oneWayCharge)}`);
      const extraKmCharge = Number(pb?.extraKmCharge || 0);
      if (extraKmCharge > 0) {
        const extraKm = Number(pb?.extraKm || 0);
        doc.text(`Extra km${extraKm > 0 ? ` (${extraKm.toFixed(1)} km)` : ''}: ${formatMoney(extraKmCharge)}`);
      }
      const extraMinuteCharge = Number(pb?.extraMinuteCharge || 0);
      if (extraMinuteCharge > 0) {
        const extraMin = Number(pb?.extraMinutes || 0);
        doc.text(`Extra time${extraMin > 0 ? ` (${extraMin} min)` : ''}: ${formatMoney(extraMinuteCharge)}`);
      }
      const nightCharge = Number(pb?.nightCharge || 0);
      if (nightCharge > 0) doc.text(`Night charge (10pm-6am): ${formatMoney(nightCharge)}`);
      const experiencedFee = Number(pb?.experiencedDriverFee || (booking as any).experiencedDriverFee || 0);
      if (experiencedFee > 0) doc.text(`Experienced driver fee: ${formatMoney(experiencedFee)}`);
      const taxesFee = Number(pb?.taxesFee || pb?.convenienceFee || 0);
      if (taxesFee > 0) doc.text(`Taxes & convenience fee: ${formatMoney(taxesFee)}`);

      doc.moveDown(0.5);

      // What customer paid
      doc.text(`${booking.paymentMethod} collected from customer: ${formatMoney(total)}`);

      // Platform subsidy (if any)
      if (computedSubsidy > 0) {
        doc.fillColor('#059669').text(`Platform subsidy (added to wallet): +${formatMoney(computedSubsidy)}`);
        doc.fillColor('#444444');
      }

      // Commission (if any)
      if (commission > 0) {
        doc.fillColor('#d97706').text(`Platform commission: -${formatMoney(commission)}`);
        doc.fillColor('#444444');
      }

      // Total earnings
      doc.moveDown(1);
      doc.fillColor('#111111').fontSize(14).text('Total Earnings');
      doc.fontSize(18).fillColor('#059669').text(formatMoney(earnings));
      doc.fillColor('#444444').fontSize(10);
      if (computedSubsidy > 0 && String(booking.paymentMethod).toUpperCase() === 'CASH') {
        doc.text(`${formatMoney(total)} cash + ${formatMoney(computedSubsidy)} wallet = ${formatMoney(earnings)}`);
      }
      doc.fontSize(9).fillColor('#666666').moveDown(1).text('0% platform fee — you keep your full earnings.', { align: 'left' });

    } else {
      // ── CUSTOMER VIEW ────────────────────────────────────────────────────
      doc.fillColor('#111111').fontSize(12).text('Fare Breakdown');
      doc.fontSize(10).fillColor('#444444');

      const packagePrice = Number(pb?.packagePrice || pb?.baseAmount || 0);
      if (packagePrice > 0) {
        const pkgHours = Number(pb?.packageHours || 0);
        doc.text(`${pkgHours > 0 ? `Package (${pkgHours}hr)` : 'Base fare'}: ${formatMoney(packagePrice)}`);
      }
      const oneWayCharge = Number(pb?.oneWayCharge || 0);
      if (oneWayCharge > 0) doc.text(`One-way charge: ${formatMoney(oneWayCharge)}`);
      const extraKmCharge = Number(pb?.extraKmCharge || 0);
      if (extraKmCharge > 0) {
        const extraKm = Number(pb?.extraKm || 0);
        doc.text(`Extra km${extraKm > 0 ? ` (${extraKm.toFixed(1)} km)` : ''}: ${formatMoney(extraKmCharge)}`);
      }
      const extraMinuteCharge = Number(pb?.extraMinuteCharge || 0);
      if (extraMinuteCharge > 0) {
        const extraMin = Number(pb?.extraMinutes || 0);
        doc.text(`Extra time${extraMin > 0 ? ` (${extraMin} min)` : ''}: ${formatMoney(extraMinuteCharge)}`);
      }
      const nightCharge = Number(pb?.nightCharge || 0);
      if (nightCharge > 0) doc.text(`Night charge (10pm-6am): ${formatMoney(nightCharge)}`);
      const experiencedFee = Number(pb?.experiencedDriverFee || (booking as any).experiencedDriverFee || 0);
      if (experiencedFee > 0) doc.text(`Experienced driver fee: ${formatMoney(experiencedFee)}`);
      const taxesFee = Number(pb?.taxesFee || pb?.convenienceFee || 0);
      if (taxesFee > 0) doc.text(`Taxes & convenience fee: ${formatMoney(taxesFee)}`);

      // Subtotal before discounts
      const gross = total + discount;
      doc.text(`Subtotal: ${formatMoney(gross)}`);

      // Discounts
      const promoDiscount = Number(discountsObj?.promoDiscount || 0);
      const membershipDiscount = Number(discountsObj?.membershipDiscount || 0);
      const streakDiscount = Number(discountsObj?.streakDiscount || 0);

      if (promoDiscount > 0) doc.fillColor('#059669').text(`Promo discount: -${formatMoney(promoDiscount)}`).fillColor('#444444');
      if (membershipDiscount > 0) {
        const membershipType = discountsObj?.membershipType || 'Membership';
        doc.fillColor('#059669').text(`${membershipType} discount: -${formatMoney(membershipDiscount)}`).fillColor('#444444');
      }
      if (streakDiscount > 0) doc.fillColor('#059669').text(`Streak discount: -${formatMoney(streakDiscount)}`).fillColor('#444444');
      if (discount > 0 && promoDiscount === 0 && membershipDiscount === 0 && streakDiscount === 0) {
        doc.fillColor('#059669').text(`Discount: -${formatMoney(discount)}`).fillColor('#444444');
      }

      // Amount paid
      doc.moveDown(1.5);
      doc.fillColor('#111111').fontSize(12).text('Amount Paid');
      doc.fontSize(18).fillColor('#111111').text(formatMoney(total));

      if (discount > 0) {
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#059669').text(`You saved ${formatMoney(discount)} on this trip! 🎉`);
      }
    }

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#999999').text('This is a system-generated document.', { align: 'left' });

    doc.end();
    return await done;
  }
}

