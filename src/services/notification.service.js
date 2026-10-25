'use strict';

const Customer = require('../models/Customer');
const Notification = require('../models/Notification');
const logger = require('../config/logger');
const { NOTIFICATION_TYPE } = require('../constants/domain');
const pushService = require('./push.service');
const socket = require('./socket');

/**
 * Notification fan-out.
 *
 * Order is deliberate: persist, then emit over the socket, then attempt push.
 * The database row is the record of truth that the in-app history reads, so a
 * failed push never loses the message. Nothing here is allowed to throw into
 * the caller - a booking must not fail because a notification did.
 */

/**
 * Whether the customer wants this notification pushed. Transactional messages
 * about a booking honour the `push` switch; marketing honours `promotions` too.
 */
function wantsPush(customer, type) {
  const prefs = customer.notificationPrefs || {};
  if (prefs.push === false) return false;
  if (type === NOTIFICATION_TYPE.PROMOTION) return prefs.promotions !== false;
  return true;
}

async function notify({ customerId, type, title, body, data = {}, bookingId = null }) {
  let record;

  try {
    record = await Notification.create({ customerId, type, title, body, data, bookingId });
  } catch (err) {
    logger.error(`Could not persist notification for ${customerId}: ${err.message}`);
    return null;
  }

  try {
    socket.emitNotification(customerId, record);
  } catch (err) {
    logger.warn(`Socket notification emit failed: ${err.message}`);
  }

  if (!pushService.isEnabled()) {
    return record;
  }

  try {
    // `devices` is select:false, so ask for it explicitly.
    const customer = await Customer.findById(customerId).select('+devices notificationPrefs');
    if (!customer || !wantsPush(customer, type) || !customer.devices?.length) {
      return record;
    }

    const deadTokens = [];
    const results = await Promise.all(
      customer.devices.map((device) =>
        pushService.sendToToken({
          fcmToken: device.fcmToken,
          title,
          body,
          data: { ...data, type, bookingId: bookingId ? String(bookingId) : '' },
        })
      )
    );

    results.forEach((result, index) => {
      if (result.unregistered) deadTokens.push(customer.devices[index].fcmToken);
    });

    if (deadTokens.length) {
      await Customer.updateOne(
        { _id: customerId },
        { $pull: { devices: { fcmToken: { $in: deadTokens } } } }
      );
      logger.debug(`Pruned ${deadTokens.length} dead FCM token(s) for ${customerId}`);
    }

    const anySent = results.some((r) => r.ok);
    const firstError = results.find((r) => !r.ok && !r.unregistered)?.error || null;

    record.pushSentAt = anySent ? new Date() : null;
    record.pushError = anySent ? null : firstError;
    await record.save();
  } catch (err) {
    logger.warn(`Push delivery failed for ${customerId}: ${err.message}`);
  }

  return record;
}

// --- Call sites for each event in the booking lifecycle --------------------

function money(booking) {
  const symbol = booking.fareBreakdown?.currencySymbol || '';
  return `${symbol}${booking.displayFare}`;
}

const templates = {
  registered: (customer) => ({
    type: NOTIFICATION_TYPE.ACCOUNT,
    title: 'Welcome aboard',
    body: `Your account is ready, ${customer.fullName.split(' ')[0]}. Book your first ride whenever you are.`,
  }),

  loggedIn: () => ({
    type: NOTIFICATION_TYPE.ACCOUNT,
    title: 'New sign-in',
    body: 'Your account was signed in on a new device. If this was not you, change your password.',
  }),

  passwordChanged: () => ({
    type: NOTIFICATION_TYPE.ACCOUNT,
    title: 'Password changed',
    body: 'Your password was changed and you have been signed out of other devices.',
  }),

  bookingCreated: (booking) => ({
    type: NOTIFICATION_TYPE.BOOKING_CREATED,
    title: `Booking ${booking.bookingCode} confirmed`,
    body: `${booking.vehicleTypeName} to ${booking.destination.address}. Estimated fare ${money(booking)}.`,
  }),

  statusChanged: (booking) => ({
    type: NOTIFICATION_TYPE.BOOKING_STATUS,
    title: `Booking ${booking.bookingCode} is now ${booking.bookingStatus}`,
    body: `${booking.vehicleTypeName} from ${booking.pickup.address}.`,
  }),

  driverAssigned: (booking) => ({
    type: NOTIFICATION_TYPE.DRIVER_ASSIGNED,
    title: 'Your driver is on the way',
    body: booking.driver?.name
      ? `${booking.driver.name} is driving a ${booking.driver.vehicleModel || booking.vehicleTypeName}` +
        `${booking.driver.vehicleNumber ? ` (${booking.driver.vehicleNumber})` : ''}.`
      : `A driver has been assigned to booking ${booking.bookingCode}.`,
  }),

  driverArrived: (booking) => ({
    type: NOTIFICATION_TYPE.DRIVER_ARRIVED,
    title: 'Your driver has arrived',
    body: `Your ${booking.vehicleTypeName} is waiting at ${booking.pickup.address}.`,
  }),

  tripCompleted: (booking) => ({
    type: NOTIFICATION_TYPE.TRIP_COMPLETED,
    title: 'Trip completed',
    body: `Thanks for riding with us. Total fare ${money(booking)}.`,
  }),

  bookingCancelled: (booking) => ({
    type: NOTIFICATION_TYPE.BOOKING_CANCELLED,
    title: `Booking ${booking.bookingCode} cancelled`,
    body: booking.cancellation?.fee
      ? `A cancellation fee of ${booking.fareBreakdown?.currencySymbol || ''}${booking.cancellation.fee} applies.`
      : 'Your booking was cancelled. No cancellation fee was charged.',
  }),

  paymentConfirmed: (booking) => ({
    type: NOTIFICATION_TYPE.PAYMENT,
    title: 'Payment received',
    body: `We received ${money(booking)} for booking ${booking.bookingCode}.`,
  }),
};

/** Notifies about a booking using one of the templates above. */
async function notifyBooking(templateName, booking) {
  const template = templates[templateName];
  if (!template) {
    logger.warn(`Unknown notification template "${templateName}"`);
    return null;
  }

  const { type, title, body } = template(booking);
  return notify({
    customerId: booking.customerId,
    type,
    title,
    body,
    bookingId: booking._id,
    data: { bookingCode: booking.bookingCode, bookingStatus: booking.bookingStatus },
  });
}

/** Notifies about an account event (registration, sign-in, password change). */
async function notifyAccount(templateName, customer) {
  const template = templates[templateName];
  if (!template) return null;

  const { type, title, body } = template(customer);
  return notify({ customerId: customer._id, type, title, body });
}

module.exports = { notify, notifyBooking, notifyAccount, templates };
