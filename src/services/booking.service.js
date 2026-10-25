'use strict';

const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Counter = require('../models/Counter');
const BusinessContact = require('../models/BusinessContact');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');
const { env } = require('../config/env');
const fareService = require('./fare.service');
const notificationService = require('./notification.service');
const socket = require('./socket');
const {
  BOOKING_STATUS,
  CANCELLABLE_STATUSES,
  ACTIVE_STATUSES,
  UPCOMING_STATUSES,
  PAYMENT_STATUS,
  NO_FEE_REASONS,
} = require('../constants/domain');

const BOOKING_CODE_KEY = 'bookingCode';
const BOOKING_CODE_PREFIX = 'TX-';

async function nextBookingCode() {
  const seq = await Counter.next(BOOKING_CODE_KEY);
  return `${BOOKING_CODE_PREFIX}${String(seq).padStart(6, '0')}`;
}

/** The single active business-contact document, or null if admin has not set one. */
async function activeBusinessContact() {
  return BusinessContact.findOne({ isActive: true }).sort({ updatedAt: -1 });
}

/**
 * Creates a booking.
 *
 * Everything that determines money or identity is derived server-side:
 *   - the customer comes from the access token, never from the body
 *   - distance and duration are measured by the geo service
 *   - the fare is recomputed from the admin's FareRule, ignoring any figure the
 *     client may have shown the user
 *   - status and payment status always start at Pending
 *
 * Repeat submissions are absorbed by `idempotencyKey`: a unique sparse index
 * means the second insert loses the race and we return the first booking. That
 * covers both a double tap and a Dio retry after a timeout where the first
 * request actually succeeded.
 */
async function createBooking({ customer, payload, requestIp }) {
  const {
    vehicleTypeId,
    pickup,
    destination,
    paymentMethod,
    specialInstructions,
    scheduledAt,
    idempotencyKey,
  } = payload;

  // Fast path: a key we have already seen. Saves recomputing the fare and
  // burning a Routes API call on a duplicate tap.
  if (idempotencyKey) {
    const existing = await Booking.findOne({ idempotencyKey, customerId: customer._id });
    if (existing) {
      return { booking: existing, deduplicated: true };
    }
  }

  const quote = await fareService.estimateForVehicleType({
    vehicleTypeId,
    pickup,
    destination,
    at: new Date(),
  });

  const contact = await activeBusinessContact();
  if (!contact) {
    logger.warn('No active BusinessContact document - booking will carry no contact snapshot.');
  }

  const bookingCode = await nextBookingCode();

  const doc = {
    bookingCode,
    customerId: customer._id,
    customerName: customer.fullName,
    customerPhone: customer.phone || null,
    customerEmail: customer.email || null,

    vehicleTypeId: quote.vehicleType._id,
    vehicleTypeName: quote.vehicleType.name,
    vehicleTypeCode: quote.vehicleType.code,

    pickup: {
      address: pickup.address,
      latitude: Number(pickup.latitude),
      longitude: Number(pickup.longitude),
      placeId: pickup.placeId || undefined,
    },
    destination: {
      address: destination.address,
      latitude: Number(destination.latitude),
      longitude: Number(destination.longitude),
      placeId: destination.placeId || undefined,
    },

    distanceKm: quote.route.distanceKm,
    durationMinutes: quote.route.durationMinutes,
    routePolyline: quote.route.polyline,
    distanceSource: quote.route.source,

    estimatedFare: quote.breakdown.total,
    finalFare: null,
    fareBreakdown: quote.breakdown,

    bookingStatus: BOOKING_STATUS.PENDING,
    statusHistory: [
      {
        status: BOOKING_STATUS.PENDING,
        at: new Date(),
        byRole: 'customer',
        byId: customer._id.toString(),
        note: 'Booking created from the customer app.',
      },
    ],

    paymentMethod,
    paymentStatus: PAYMENT_STATUS.PENDING,

    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    specialInstructions: specialInstructions || undefined,

    businessContactSnapshot: contact ? contact.toSnapshot() : null,
    idempotencyKey: idempotencyKey || undefined,
    source: 'customer_app',
  };

  let booking;
  try {
    booking = await Booking.create(doc);
  } catch (err) {
    // 11000 is a duplicate key. On `idempotencyKey` it means a concurrent
    // request for the same tap won; return its booking instead of erroring.
    if (err.code === 11000 && idempotencyKey && err.keyPattern?.idempotencyKey) {
      const existing = await Booking.findOne({ idempotencyKey, customerId: customer._id });
      if (existing) {
        return { booking: existing, deduplicated: true };
      }
    }
    // A duplicate bookingCode means two requests drew the same counter value,
    // which should be impossible; retry once with a fresh code rather than
    // failing the customer's booking.
    if (err.code === 11000 && err.keyPattern?.bookingCode) {
      doc.bookingCode = await nextBookingCode();
      booking = await Booking.create(doc);
    } else {
      throw err;
    }
  }

  logger.info(
    `Booking ${booking.bookingCode} created by ${customer._id} ` +
      `(${booking.distanceKm}km, ${booking.fareBreakdown.currency} ${booking.estimatedFare}, ip ${requestIp || 'unknown'})`
  );

  // Both of these are best-effort and must not fail the request.
  try {
    socket.emitBookingUpdate(booking, 'booking:created');
  } catch (err) {
    logger.warn(`Socket emit failed for ${booking.bookingCode}: ${err.message}`);
  }
  notificationService.notifyBooking('bookingCreated', booking).catch(() => {});

  return { booking, deduplicated: false };
}

/**
 * Works out the cancellation fee for a booking being cancelled now.
 *
 * Free when: inside the grace window, the driver had not been assigned, or the
 * reason puts the fault on our side. Otherwise the fee from the FareRule
 * applies, falling back to BOOKING_LATE_CANCEL_FEE if the rule sets none.
 */
async function computeCancellationFee(booking, reason) {
  if (NO_FEE_REASONS.includes(reason)) {
    return { fee: 0, waived: true };
  }

  // Nobody has been dispatched yet, so cancelling costs us nothing.
  if (
    booking.bookingStatus === BOOKING_STATUS.PENDING ||
    booking.bookingStatus === BOOKING_STATUS.CONFIRMED
  ) {
    return { fee: 0, waived: true };
  }

  let graceSeconds = env.booking.freeCancelWindowSeconds;
  let ruleFee = null;

  try {
    const rule = await fareService.resolveFareRule(booking.vehicleTypeId, booking.createdAt);
    if (rule.freeCancellationMinutes != null) graceSeconds = rule.freeCancellationMinutes * 60;
    if (rule.cancellationFee != null) ruleFee = rule.cancellationFee;
  } catch (err) {
    logger.warn(`No fare rule for cancellation fee on ${booking.bookingCode}: ${err.message}`);
  }

  // The grace window runs from the moment a driver was assigned, not from the
  // booking, so a customer is not penalised for a long dispatch wait.
  const clockStart = booking.driver?.assignedAt || booking.createdAt;
  const elapsedSeconds = (Date.now() - new Date(clockStart).getTime()) / 1000;

  if (elapsedSeconds <= graceSeconds) {
    return { fee: 0, waived: true };
  }

  const fee = ruleFee != null ? ruleFee : env.booking.lateCancelFee;
  return { fee: Math.max(0, fee), waived: fee === 0 };
}

/**
 * Cancels a booking on the customer's behalf.
 *
 * The status transition is a single atomic `findOneAndUpdate` conditioned on the
 * booking still being in a cancellable state. That is what prevents the race
 * the brief calls out: if the admin assigns a driver or completes the trip
 * between our read and our write, the filter no longer matches, nothing is
 * written, and we report the real current status instead of silently cancelling
 * a trip that had already moved on.
 */
async function cancelBooking({ booking, customer, reason, remarks }) {
  if (booking.bookingStatus === BOOKING_STATUS.CANCELLED) {
    throw ApiError.conflict('This booking is already cancelled.', 'BOOKING_ALREADY_CANCELLED');
  }
  if (booking.bookingStatus === BOOKING_STATUS.COMPLETED) {
    throw ApiError.conflict(
      'This trip is already completed and cannot be cancelled.',
      'BOOKING_ALREADY_COMPLETED'
    );
  }
  if (!CANCELLABLE_STATUSES.includes(booking.bookingStatus)) {
    throw ApiError.conflict(
      `A booking that is ${booking.bookingStatus} can no longer be cancelled. Please contact support.`,
      'BOOKING_NOT_CANCELLABLE',
      { bookingStatus: booking.bookingStatus }
    );
  }

  const { fee, waived } = await computeCancellationFee(booking, reason);
  const now = new Date();

  const cancellation = {
    reason: reason || 'Other',
    remarks: remarks || undefined,
    cancelledByRole: 'customer',
    cancelledById: customer._id.toString(),
    cancelledAt: now,
    fee,
    feeWaived: waived,
  };

  const updated = await Booking.findOneAndUpdate(
    {
      _id: booking._id,
      customerId: customer._id,
      // The compare-and-set guard. Also re-checks ownership.
      bookingStatus: { $in: CANCELLABLE_STATUSES },
    },
    {
      $set: {
        bookingStatus: BOOKING_STATUS.CANCELLED,
        cancellation,
        // A waived cancellation leaves nothing to collect.
        paymentStatus: fee > 0 ? PAYMENT_STATUS.PENDING : PAYMENT_STATUS.REFUNDED,
      },
      $push: {
        statusHistory: {
          status: BOOKING_STATUS.CANCELLED,
          at: now,
          byRole: 'customer',
          byId: customer._id.toString(),
          note: reason ? `Cancelled by customer: ${reason}` : 'Cancelled by customer',
        },
      },
    },
    { new: true }
  );

  if (!updated) {
    // Someone moved the booking under us. Report where it actually is.
    const current = await Booking.findById(booking._id).select('bookingStatus');
    throw ApiError.conflict(
      current
        ? `This booking moved to "${current.bookingStatus}" while you were cancelling. Pull to refresh and try again.`
        : 'This booking no longer exists.',
      'BOOKING_STATE_CHANGED',
      { bookingStatus: current?.bookingStatus || null }
    );
  }

  logger.info(`Booking ${updated.bookingCode} cancelled by customer (fee ${fee})`);

  try {
    socket.emitBookingUpdate(updated, 'booking:cancelled');
  } catch (err) {
    logger.warn(`Socket emit failed for ${updated.bookingCode}: ${err.message}`);
  }
  notificationService.notifyBooking('bookingCancelled', updated).catch(() => {});

  return updated;
}

/** Maps a My Bookings tab onto the statuses it shows. */
function statusFilterForTab(tab) {
  switch ((tab || '').toLowerCase()) {
    case 'upcoming':
      return { $in: UPCOMING_STATUSES };
    case 'active':
      return { $in: ACTIVE_STATUSES };
    case 'completed':
      return BOOKING_STATUS.COMPLETED;
    case 'cancelled':
      return BOOKING_STATUS.CANCELLED;
    default:
      return null;
  }
}

/** One page of a customer's bookings, newest first. */
async function listBookings({ customerId, tab, status, page = 1, limit = 10 }) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 10));

  const query = { customerId };

  const tabFilter = statusFilterForTab(tab);
  if (tabFilter) {
    query.bookingStatus = tabFilter;
  } else if (status) {
    query.bookingStatus = status;
  }

  const [items, total] = await Promise.all([
    Booking.find(query)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    Booking.countDocuments(query),
  ]);

  return {
    items: items.map((b) => b.toListJSON()),
    page: safePage,
    limit: safeLimit,
    total,
  };
}

/** Loads a booking the customer owns, or throws 404. */
async function getOwnedBooking(bookingId, customerId) {
  if (!mongoose.isValidObjectId(bookingId)) {
    throw ApiError.notFound('Booking not found.', 'BOOKING_NOT_FOUND');
  }

  const booking = await Booking.findOne({ _id: bookingId, customerId });

  if (!booking) {
    // Deliberately the same error whether the booking is missing or belongs to
    // someone else, so the endpoint cannot be used to probe for valid ids.
    throw ApiError.notFound('Booking not found.', 'BOOKING_NOT_FOUND');
  }

  return booking;
}

module.exports = {
  createBooking,
  cancelBooking,
  computeCancellationFee,
  listBookings,
  getOwnedBooking,
  activeBusinessContact,
  nextBookingCode,
  statusFilterForTab,
};
