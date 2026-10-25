'use strict';

const Customer = require('../models/Customer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../config/logger');
const { ok } = require('../utils/ApiResponse');
const { normalizePhone } = require('../utils/phone');
const { hashPassword, verifyPassword } = require('../utils/password');
const { OTP_PURPOSE, CUSTOMER_STATUS } = require('../constants/domain');
const otpService = require('../services/otp.service');
const tokenService = require('../services/token.service');
const bookingService = require('../services/booking.service');
const notificationService = require('../services/notification.service');

// --- GET /customers/me ------------------------------------------------------

const getMe = asyncHandler(async (req, res) => ok(res, { customer: req.customer.toPublicJSON() }));

// --- PUT /customers/me ------------------------------------------------------

/**
 * Updates the profile.
 *
 * The name is free to change. Changing an identifier is gated:
 *   - a new value must not already belong to another account
 *   - replacing an *already verified* phone or email needs a verificationToken
 *     for the NEW value, proving the customer controls it
 *
 * Without that gate, a stolen session could move the account onto an attacker's
 * number and then use the OTP login path to keep it.
 */
const updateMe = asyncHandler(async (req, res) => {
  const customer = req.customer;
  const { fullName, verificationToken } = req.body;
  const changes = [];

  if (fullName && fullName !== customer.fullName) {
    customer.fullName = fullName;
    changes.push('name');
  }

  if (req.body.phone) {
    const phone = normalizePhone(req.body.phone);

    if (phone !== customer.phone) {
      const taken = await Customer.findOne({ phone, _id: { $ne: customer._id } });
      if (taken) {
        throw ApiError.conflict('That mobile number belongs to another account.', 'PHONE_TAKEN', {
          field: 'phone',
        });
      }

      await otpService.consumeVerificationToken({
        destination: phone,
        purpose: OTP_PURPOSE.VERIFY_PHONE,
        verificationToken,
      });

      customer.phone = phone;
      customer.phoneVerified = true;
      changes.push('mobile number');
    }
  }

  if (req.body.email) {
    const email = req.body.email.toLowerCase();

    if (email !== customer.email) {
      const taken = await Customer.findOne({ email, _id: { $ne: customer._id } });
      if (taken) {
        throw ApiError.conflict('That email address belongs to another account.', 'EMAIL_TAKEN', {
          field: 'email',
        });
      }

      // An unverified email can be corrected freely - a typo should not need an
      // OTP to the address that never worked. A verified one must be proven.
      if (customer.emailVerified) {
        await otpService.consumeVerificationToken({
          destination: email,
          purpose: OTP_PURPOSE.VERIFY_EMAIL,
          verificationToken,
        });
        customer.email = email;
        customer.emailVerified = true;
      } else {
        customer.email = email;
        customer.emailVerified = false;
      }

      changes.push('email address');
    }
  }

  if (!changes.length) {
    return ok(res, { customer: customer.toPublicJSON() }, 'Nothing changed.');
  }

  await customer.save();
  logger.info(`Profile updated for ${customer._id}: ${changes.join(', ')}`);

  return ok(res, { customer: customer.toPublicJSON() }, `Updated your ${changes.join(' and ')}.`);
});

// --- PUT /customers/me/password ---------------------------------------------

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const customer = await Customer.findById(req.customer._id).select('+passwordHash');

  if (customer.passwordHash) {
    if (!currentPassword) {
      throw ApiError.badRequest('Enter your current password.', 'CURRENT_PASSWORD_REQUIRED');
    }
    const matches = await verifyPassword(currentPassword, customer.passwordHash);
    if (!matches) {
      throw ApiError.badRequest('Your current password is not correct.', 'CURRENT_PASSWORD_INVALID');
    }
  }

  customer.passwordHash = await hashPassword(newPassword);
  // Other devices are signed out: a password change usually means the customer
  // suspects someone else has access.
  customer.tokenVersion = (customer.tokenVersion || 0) + 1;
  await customer.save();
  await tokenService.revokeAllForCustomer(customer._id);

  logger.info(`Password changed for ${customer._id}`);
  notificationService.notifyAccount('passwordChanged', customer).catch(() => {});

  // The caller's own token was just invalidated, so hand back a new session.
  const session = await tokenService.issueSession(customer, {
    ip: req.ip,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
  });

  return ok(
    res,
    { customer: customer.toPublicJSON(), ...session },
    'Password changed. Other devices have been signed out.'
  );
});

// --- GET /customers/me/bookings ---------------------------------------------

const getMyBookings = asyncHandler(async (req, res) => {
  const { tab, status, page, limit } = req.query;
  const result = await bookingService.listBookings({
    customerId: req.customer._id,
    tab,
    status,
    page,
    limit,
  });

  return ok(res, result);
});

// --- Saved addresses --------------------------------------------------------

const MAX_SAVED_ADDRESSES = 20;

const listAddresses = asyncHandler(async (req, res) =>
  ok(res, { items: req.customer.toPublicJSON().savedAddresses })
);

/**
 * Adds or replaces a saved address.
 *
 * "Home" and "Office" are singletons: saving a new Home replaces the old one
 * rather than leaving the customer with two, which is what the home screen's
 * two shortcut tiles assume.
 */
const addAddress = asyncHandler(async (req, res) => {
  const customer = req.customer;
  const { label, address, latitude, longitude, placeId } = req.body;

  const isSingleton = ['home', 'office'].includes(label.toLowerCase());

  if (isSingleton) {
    customer.savedAddresses = customer.savedAddresses.filter(
      (saved) => saved.label.toLowerCase() !== label.toLowerCase()
    );
  } else if (customer.savedAddresses.length >= MAX_SAVED_ADDRESSES) {
    throw ApiError.badRequest(
      `You can save up to ${MAX_SAVED_ADDRESSES} addresses. Delete one to add another.`,
      'ADDRESS_LIMIT_REACHED'
    );
  }

  customer.savedAddresses.push({ label, address, latitude, longitude, placeId });
  await customer.save();

  return ok(res, { savedAddresses: customer.toPublicJSON().savedAddresses }, `Saved as ${label}.`);
});

const deleteAddress = asyncHandler(async (req, res) => {
  const customer = req.customer;
  const { addressId } = req.params;

  const before = customer.savedAddresses.length;
  customer.savedAddresses = customer.savedAddresses.filter(
    (saved) => saved._id.toString() !== addressId
  );

  if (customer.savedAddresses.length === before) {
    throw ApiError.notFound('That saved address does not exist.', 'ADDRESS_NOT_FOUND');
  }

  await customer.save();
  return ok(res, { savedAddresses: customer.toPublicJSON().savedAddresses }, 'Address removed.');
});

// --- Notification preferences and devices -----------------------------------

const updateNotificationPrefs = asyncHandler(async (req, res) => {
  const customer = req.customer;
  const current = customer.notificationPrefs?.toObject?.() ?? customer.notificationPrefs ?? {};
  customer.notificationPrefs = { ...current, ...req.body };
  await customer.save();

  return ok(
    res,
    { notificationPrefs: customer.toPublicJSON().notificationPrefs },
    'Notification preferences updated.'
  );
});

/** Registers (or refreshes) this device's FCM token. */
const registerDevice = asyncHandler(async (req, res) => {
  const { fcmToken, platform } = req.body;
  const customerId = req.customer._id;

  // One token belongs to one account at a time.
  await Customer.updateMany(
    { _id: { $ne: customerId }, 'devices.fcmToken': fcmToken },
    { $pull: { devices: { fcmToken } } }
  );
  await Customer.updateOne({ _id: customerId }, { $pull: { devices: { fcmToken } } });
  await Customer.updateOne(
    { _id: customerId },
    { $push: { devices: { fcmToken, platform, lastSeenAt: new Date() } } }
  );

  return ok(res, { registered: true }, 'Device registered for notifications.');
});

// --- DELETE /customers/me ---------------------------------------------------

/**
 * Flags the account for deletion rather than removing it.
 *
 * Bookings must survive for the operator's records and for tax purposes, and a
 * hard delete would orphan them. The admin app completes or reverses the
 * request; signing back in cancels it.
 */
const requestAccountDeletion = asyncHandler(async (req, res) => {
  const customer = req.customer;

  const { items: openBookings } = await bookingService.listBookings({
    customerId: customer._id,
    tab: 'active',
    limit: 1,
  });

  if (openBookings.length) {
    throw ApiError.conflict(
      'You have a trip in progress. Please finish or cancel it before requesting deletion.',
      'ACTIVE_BOOKING_EXISTS'
    );
  }

  customer.status = CUSTOMER_STATUS.DELETION_REQUESTED;
  customer.deletionRequestedAt = new Date();
  customer.deletionReason = req.body.reason;
  customer.devices = [];
  await customer.save();

  await tokenService.revokeAllForCustomer(customer._id);
  logger.info(`Account deletion requested: ${customer._id}`);

  return ok(
    res,
    { status: customer.status, deletionRequestedAt: customer.deletionRequestedAt },
    'Your deletion request has been received. Sign in again at any time to cancel it.'
  );
});

module.exports = {
  getMe,
  updateMe,
  changePassword,
  getMyBookings,
  listAddresses,
  addAddress,
  deleteAddress,
  updateNotificationPrefs,
  registerDevice,
  requestAccountDeletion,
};
