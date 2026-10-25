'use strict';

const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/ApiResponse');
const { env } = require('../config/env');
const { CANCELLATION_REASONS, PAYMENT_METHOD_VALUES, BOOKING_STATUS_VALUES } = require('../constants/domain');
const BusinessContact = require('../models/BusinessContact');

/**
 * GET /public/business-contact
 *
 * The official business contact details, unauthenticated so the support screen
 * works before sign-in.
 *
 * Only `toPublicJSON()` is returned, which is the whitelist of customer-facing
 * fields on the model. Administrator credentials are not in this collection at
 * all, so there is nothing privileged to leak here.
 */
const getBusinessContact = asyncHandler(async (req, res) => {
  const contact = await BusinessContact.findOne({ isActive: true }).sort({ updatedAt: -1 });

  if (!contact) {
    // A deliberate 404 rather than invented placeholder details: the app shows
    // "contact details unavailable" instead of a wrong phone number.
    throw ApiError.notFound(
      'Business contact details have not been configured yet.',
      'BUSINESS_CONTACT_NOT_CONFIGURED'
    );
  }

  return ok(res, { businessContact: contact.toPublicJSON() });
});

/**
 * GET /public/app-config
 *
 * Values the client would otherwise have to hardcode: the enum vocabularies it
 * renders, and which optional integrations this deployment actually has. The
 * app uses `features` to hide UI that cannot work rather than showing a button
 * that fails.
 */
const getAppConfig = asyncHandler(async (req, res) =>
  ok(res, {
    apiVersion: 'v1',
    paymentMethods: PAYMENT_METHOD_VALUES,
    bookingStatuses: BOOKING_STATUS_VALUES,
    cancellationReasons: CANCELLATION_REASONS,
    otp: {
      length: env.otp.length,
      ttlSeconds: env.otp.ttlSeconds,
      resendCooldownSeconds: env.otp.resendCooldownSeconds,
      maxAttempts: env.otp.maxAttempts,
    },
    features: {
      smsOtp: env.sms.provider !== 'mock',
      emailDelivery: env.email.provider !== 'mock',
      // False means fares come from the straight-line estimator, and the app
      // shows an "approximate distance" note.
      routeAccurateDistances: Boolean(env.maps.serverKey),
      pushNotifications: Boolean(env.firebase.serviceAccountPath),
      realtimeUpdates: true,
      scheduledBookings: true,
    },
  })
);

/** GET /public/health - for uptime checks and the admin dashboard. */
const health = asyncHandler(async (req, res) => {
  const mongoose = require('mongoose');
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];

  return ok(res, {
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    database: states[mongoose.connection.readyState] || 'unknown',
    environment: env.nodeEnv,
    timestamp: new Date().toISOString(),
  });
});

module.exports = { getBusinessContact, getAppConfig, health };
