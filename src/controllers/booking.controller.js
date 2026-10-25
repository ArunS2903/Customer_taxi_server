'use strict';

const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/ApiResponse');
const { CANCELLATION_REASONS, CANCELLABLE_STATUSES } = require('../constants/domain');
const bookingService = require('../services/booking.service');

// --- POST /bookings ---------------------------------------------------------

/**
 * Creates a booking for the authenticated customer.
 *
 * The customer comes from the token, not the body - the client cannot book on
 * someone else's behalf. The fare, distance, booking code, status and payment
 * status are all produced by the server.
 *
 * A repeat submission carrying the same `idempotencyKey` returns the original
 * booking with HTTP 200 instead of creating a second one; the first creation
 * returns 201. That difference lets the client tell a retry from a new booking
 * without having to compare bodies.
 */
const createBooking = asyncHandler(async (req, res) => {
  const { booking, deduplicated } = await bookingService.createBooking({
    customer: req.customer,
    payload: req.body,
    requestIp: req.ip,
  });

  const body = {
    booking: booking.toPublicJSON(),
    bookingReference: booking.bookingCode,
    deduplicated,
  };

  if (deduplicated) {
    return ok(res, body, 'This booking was already created.');
  }

  return created(res, body, `Booking ${booking.bookingCode} confirmed.`);
});

// --- GET /bookings ----------------------------------------------------------

const listBookings = asyncHandler(async (req, res) => {
  const { tab, status, page, limit } = req.query;

  const result = await bookingService.listBookings({
    customerId: req.customer._id,
    tab,
    status,
    page,
    limit,
  });

  return ok(res, {
    ...result,
    hasMore: result.page * result.limit < result.total,
  });
});

// --- GET /bookings/:bookingId -----------------------------------------------

const getBooking = asyncHandler(async (req, res) => {
  const booking = await bookingService.getOwnedBooking(req.params.bookingId, req.customer._id);

  // Everything the cancellation sheet needs to decide what to show, computed
  // here so the client does not have to reimplement the fee policy.
  const canCancel = CANCELLABLE_STATUSES.includes(booking.bookingStatus);
  const { fee, waived } = canCancel
    ? await bookingService.computeCancellationFee(booking, null)
    : { fee: 0, waived: true };

  return ok(res, {
    booking: booking.toPublicJSON(),
    cancellation: {
      canCancel,
      estimatedFee: fee,
      feeWaived: waived,
      reasons: CANCELLATION_REASONS,
    },
  });
});

// --- POST /bookings/:bookingId/cancel ---------------------------------------

const cancelBooking = asyncHandler(async (req, res) => {
  const booking = await bookingService.getOwnedBooking(req.params.bookingId, req.customer._id);

  const updated = await bookingService.cancelBooking({
    booking,
    customer: req.customer,
    reason: req.body.reason,
    remarks: req.body.remarks,
  });

  return ok(
    res,
    {
      booking: updated.toPublicJSON(),
      cancellationFee: updated.cancellation?.fee || 0,
      feeWaived: Boolean(updated.cancellation?.feeWaived),
    },
    updated.cancellation?.fee
      ? `Booking cancelled. A cancellation fee of ${updated.fareBreakdown?.currencySymbol || ''}${updated.cancellation.fee} applies.`
      : 'Booking cancelled. No cancellation fee was charged.'
  );
});

// --- GET /bookings/:bookingId/cancellation-policy ---------------------------

/** What cancelling right now would cost, for the confirmation dialog. */
const getCancellationPolicy = asyncHandler(async (req, res) => {
  const booking = await bookingService.getOwnedBooking(req.params.bookingId, req.customer._id);

  if (!CANCELLABLE_STATUSES.includes(booking.bookingStatus)) {
    throw ApiError.conflict(
      `A booking that is ${booking.bookingStatus} can no longer be cancelled.`,
      'BOOKING_NOT_CANCELLABLE',
      { bookingStatus: booking.bookingStatus }
    );
  }

  const { fee, waived } = await bookingService.computeCancellationFee(booking, null);

  return ok(res, {
    canCancel: true,
    estimatedFee: fee,
    feeWaived: waived,
    currencySymbol: booking.fareBreakdown?.currencySymbol || '',
    reasons: CANCELLATION_REASONS,
    bookingStatus: booking.bookingStatus,
  });
});

module.exports = {
  createBooking,
  listBookings,
  getBooking,
  cancelBooking,
  getCancellationPolicy,
};
