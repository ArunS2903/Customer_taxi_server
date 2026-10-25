'use strict';

/**
 * Single source of truth for the enums that cross the API boundary.
 * The Flutter client mirrors these strings in core/constants/booking_status.dart;
 * changing a value here is a breaking API change.
 */

const BOOKING_STATUS = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  DRIVER_ASSIGNED: 'Driver Assigned',
  DRIVER_ARRIVED: 'Driver Arrived',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const BOOKING_STATUS_VALUES = Object.values(BOOKING_STATUS);

/** Statuses a customer is still allowed to cancel from. */
const CANCELLABLE_STATUSES = [
  BOOKING_STATUS.PENDING,
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.DRIVER_ASSIGNED,
  BOOKING_STATUS.DRIVER_ARRIVED,
];

/** Statuses that count as "not finished yet" for the Active/Upcoming tabs. */
const ACTIVE_STATUSES = [
  BOOKING_STATUS.DRIVER_ASSIGNED,
  BOOKING_STATUS.DRIVER_ARRIVED,
  BOOKING_STATUS.IN_PROGRESS,
];

const UPCOMING_STATUSES = [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED];

const TERMINAL_STATUSES = [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.CANCELLED];

const PAYMENT_METHOD = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  WALLET: 'Wallet',
};

const PAYMENT_METHOD_VALUES = Object.values(PAYMENT_METHOD);

const PAYMENT_STATUS = {
  PENDING: 'Pending',
  PAID: 'Paid',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
};

const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUS);

const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DELETION_REQUESTED: 'deletion_requested',
};

const OTP_PURPOSE = {
  REGISTER: 'register',
  LOGIN: 'login',
  VERIFY_PHONE: 'verify_phone',
  VERIFY_EMAIL: 'verify_email',
  RESET_PASSWORD: 'reset_password',
};

const OTP_PURPOSE_VALUES = Object.values(OTP_PURPOSE);

const OTP_CHANNEL = { SMS: 'sms', EMAIL: 'email' };

const ADDRESS_LABEL = { HOME: 'Home', OFFICE: 'Office', OTHER: 'Other' };

const NOTIFICATION_TYPE = {
  ACCOUNT: 'account',
  BOOKING_CREATED: 'booking_created',
  BOOKING_STATUS: 'booking_status',
  DRIVER_ASSIGNED: 'driver_assigned',
  DRIVER_ARRIVED: 'driver_arrived',
  TRIP_COMPLETED: 'trip_completed',
  BOOKING_CANCELLED: 'booking_cancelled',
  PAYMENT: 'payment',
  PROMOTION: 'promotion',
};

const CANCELLATION_REASONS = [
  'Driver is taking too long',
  'Booked by mistake',
  'Found another ride',
  'Plans changed',
  'Wrong pickup location',
  'Driver asked to cancel',
  'Other',
];

/** Cancellation reasons that must never attract a fee, whoever is at fault. */
const NO_FEE_REASONS = ['Driver asked to cancel', 'Wrong pickup location'];

module.exports = {
  BOOKING_STATUS,
  BOOKING_STATUS_VALUES,
  CANCELLABLE_STATUSES,
  ACTIVE_STATUSES,
  UPCOMING_STATUSES,
  TERMINAL_STATUSES,
  PAYMENT_METHOD,
  PAYMENT_METHOD_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  CUSTOMER_STATUS,
  OTP_PURPOSE,
  OTP_PURPOSE_VALUES,
  OTP_CHANNEL,
  ADDRESS_LABEL,
  NOTIFICATION_TYPE,
  CANCELLATION_REASONS,
  NO_FEE_REASONS,
};
