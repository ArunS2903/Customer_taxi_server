'use strict';

const express = require('express');
const controller = require('../controllers/auth.controller');
const { validate } = require('../middleware/validate');
const { optionalAuth } = require('../middleware/auth');
const { authLimiter, otpLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators');

const router = express.Router();

/**
 * POST /auth/send-otp
 * Body: { phone? | email?, purpose }
 * purpose: register | login | verify_phone | verify_email | reset_password
 */
router.post('/send-otp', otpLimiter, validate(schemas.sendOtpSchema), controller.sendOtp);

/**
 * POST /auth/verify-otp
 * Body: { phone? | email?, purpose, otp, fcmToken?, platform? }
 * purpose=login returns a full session; every other purpose returns a one-use
 * verificationToken for the follow-up call.
 */
router.post('/verify-otp', authLimiter, validate(schemas.verifyOtpSchema), controller.verifyOtp);

/**
 * POST /auth/register
 * Body: { fullName, phone?, email?, password, confirmPassword?, verificationToken?, fcmToken? }
 * A `phone` requires a verificationToken from verify-otp with purpose=register.
 */
router.post('/register', authLimiter, validate(schemas.registerSchema), controller.register);

/**
 * POST /auth/login
 * Body: { phone? | email?, password? | otp?, fcmToken?, platform? }
 * Covers all three login options: phone+password, email+password, phone+OTP.
 */
router.post('/login', authLimiter, validate(schemas.loginSchema), controller.login);

/** POST /auth/refresh-token - Body: { refreshToken }. Rotates one-use. */
router.post('/refresh-token', validate(schemas.refreshTokenSchema), controller.refreshToken);

/**
 * POST /auth/logout - Body: { refreshToken?, fcmToken?, allDevices? }
 * optionalAuth, so logging out still works when the access token has expired.
 */
router.post('/logout', optionalAuth, validate(schemas.logoutSchema), controller.logout);

/** POST /auth/forgot-password - Body: { phone? | email? }. Response is neutral. */
router.post(
  '/forgot-password',
  otpLimiter,
  validate(schemas.forgotPasswordSchema),
  controller.forgotPassword
);

/**
 * POST /auth/reset-password
 * Body: { phone? | email?, verificationToken, password, confirmPassword? }
 */
router.post(
  '/reset-password',
  authLimiter,
  validate(schemas.resetPasswordSchema),
  controller.resetPassword
);

module.exports = router;
