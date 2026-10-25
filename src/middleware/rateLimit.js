'use strict';

const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

/**
 * Rate limiters. The envelope matches the error middleware so the client
 * handles a 429 from here exactly like any other failure.
 *
 * Limits are relaxed in development so testing the OTP flow by hand does not
 * lock you out of your own server.
 */
function handler(req, res) {
  res.status(429).json({
    success: false,
    message: 'Too many requests. Please slow down and try again shortly.',
    code: 'RATE_LIMITED',
  });
}

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  handler,
};

/** Broad ceiling for the whole API, to blunt scraping and runaway clients. */
const globalLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: env.isProduction ? 120 : 1000,
});

/** Login / register / refresh: tight, because these are credential endpoints. */
const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 20 : 200,
  // Counts failures only, so a customer who logs in successfully is not
  // penalised for having retried a typo.
  skipSuccessfulRequests: true,
});

/**
 * OTP sending. Deliberately stricter than authLimiter because each request
 * costs real money, and keyed on the destination number rather than the IP so
 * one number cannot be pestered from a pool of addresses.
 */
const otpLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: env.isProduction ? 10 : 100,
  keyGenerator: (req) => {
    const destination = req.body?.phone || req.body?.email || '';
    return destination ? `otp:${String(destination).toLowerCase()}` : `otp-ip:${req.ip}`;
  },
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many verification codes requested. Please try again later.',
      code: 'OTP_LIMIT_REACHED',
    });
  },
});

/** Booking creation, so a buggy client cannot flood the dispatch queue. */
const bookingLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: env.isProduction ? 10 : 100,
});

module.exports = { globalLimiter, authLimiter, otpLimiter, bookingLimiter };
