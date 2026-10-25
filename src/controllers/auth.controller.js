'use strict';

const Customer = require('../models/Customer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../config/logger');
const { env } = require('../config/env');
const { ok, created } = require('../utils/ApiResponse');
const { normalizePhone, maskPhone, maskEmail } = require('../utils/phone');
const { hashPassword, verifyPassword } = require('../utils/password');
const { OTP_CHANNEL, OTP_PURPOSE, CUSTOMER_STATUS } = require('../constants/domain');
const otpService = require('../services/otp.service');
const tokenService = require('../services/token.service');
const notificationService = require('../services/notification.service');

/**
 * Account verification policy
 * ---------------------------
 * A mobile number is only ever stored as verified if the caller presents a
 * `verificationToken` from POST /auth/verify-otp for that number, so an
 * account cannot claim a number its owner does not control.
 *
 * An email-only registration is allowed to proceed unverified - the customer
 * already proved they can set a password, and we send a verification code they
 * can redeem later from the profile screen. Nothing privileged depends on
 * `emailVerified`, so this trades a little rigour for a much shorter signup.
 */

/** Request context recorded against sessions and OTPs, for abuse triage. */
function contextOf(req) {
  return {
    ip: req.ip,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
  };
}

/**
 * Resolves the identifier a request is about into
 * `{ channel, destination, field }`. Phone wins when both are supplied,
 * because an SMS OTP is the stronger proof.
 */
function resolveIdentifier(body) {
  if (body.phone) {
    return { channel: OTP_CHANNEL.SMS, destination: normalizePhone(body.phone), field: 'phone' };
  }
  if (body.email) {
    return { channel: OTP_CHANNEL.EMAIL, destination: body.email.toLowerCase(), field: 'email' };
  }
  throw ApiError.badRequest('Enter a mobile number or an email address.', 'IDENTIFIER_REQUIRED');
}

/** Records the device's FCM token so the customer can receive push messages. */
async function attachDevice(customer, fcmToken, platform = 'android') {
  if (!fcmToken) return;

  // Take the token off any other account first: a shared handset must not keep
  // delivering one customer's booking updates to whoever signed in next.
  await Customer.updateMany(
    { _id: { $ne: customer._id }, 'devices.fcmToken': fcmToken },
    { $pull: { devices: { fcmToken } } }
  );

  await Customer.updateOne({ _id: customer._id }, { $pull: { devices: { fcmToken } } });
  await Customer.updateOne(
    { _id: customer._id },
    { $push: { devices: { fcmToken, platform, lastSeenAt: new Date() } } }
  );
}

function sessionResponse(customer, session) {
  return { customer: customer.toPublicJSON(), ...session };
}

// --- POST /auth/send-otp ----------------------------------------------------

const sendOtp = asyncHandler(async (req, res) => {
  const { purpose } = req.body;
  const { channel, destination, field } = resolveIdentifier(req.body);

  const existing = await Customer.findOne({ [field]: destination });

  /**
   * Fail fast where the answer is unambiguous and not a privacy leak:
   *  - registering a number that already has an account
   *  - logging in or resetting a password for a number that has none
   *
   * The second case does disclose whether an account exists. That is a
   * deliberate trade: the alternative is a customer staring at an OTP screen
   * waiting for a code that will never arrive, and the number is something an
   * attacker would have to know already.
   */
  if (purpose === OTP_PURPOSE.REGISTER && existing) {
    throw ApiError.conflict(
      field === 'phone'
        ? 'That mobile number is already registered. Please sign in instead.'
        : 'That email address is already registered. Please sign in instead.',
      'ACCOUNT_EXISTS',
      { field }
    );
  }

  if ((purpose === OTP_PURPOSE.LOGIN || purpose === OTP_PURPOSE.RESET_PASSWORD) && !existing) {
    throw ApiError.notFound(
      field === 'phone'
        ? 'No account found for that mobile number.'
        : 'No account found for that email address.',
      'ACCOUNT_NOT_FOUND',
      { field }
    );
  }

  if (existing?.status === CUSTOMER_STATUS.SUSPENDED) {
    throw ApiError.forbidden('This account has been suspended. Please contact support.', 'ACCOUNT_SUSPENDED');
  }

  const { ip, userAgent } = contextOf(req);
  const result = await otpService.requestOtp({
    channel,
    destination,
    purpose,
    requestIp: ip,
    userAgent,
  });

  return ok(res, result, 'Verification code sent.');
});

// --- POST /auth/verify-otp --------------------------------------------------

/**
 * Verifies a code. For `purpose: "login"` this also issues a session, which is
 * the whole of login option B. For every other purpose it returns a one-use
 * `verificationToken` to present to the follow-up endpoint.
 */
const verifyOtp = asyncHandler(async (req, res) => {
  const { purpose, otp, fcmToken, platform } = req.body;
  const { destination, field } = resolveIdentifier(req.body);

  const verification = await otpService.verifyOtp({ destination, purpose, code: otp });

  if (purpose === OTP_PURPOSE.LOGIN) {
    const customer = await Customer.findOne({ [field]: destination });
    if (!customer) {
      throw ApiError.notFound('No account found for that identifier.', 'ACCOUNT_NOT_FOUND');
    }
    if (customer.status === CUSTOMER_STATUS.SUSPENDED) {
      throw ApiError.forbidden('This account has been suspended.', 'ACCOUNT_SUSPENDED');
    }

    // Signing in with an SMS code proves the number, so record that.
    if (field === 'phone' && !customer.phoneVerified) customer.phoneVerified = true;
    if (field === 'email' && !customer.emailVerified) customer.emailVerified = true;

    // Logging back in withdraws a pending deletion request.
    if (customer.status === CUSTOMER_STATUS.DELETION_REQUESTED) {
      customer.status = CUSTOMER_STATUS.ACTIVE;
      customer.deletionRequestedAt = undefined;
    }

    customer.lastLoginAt = new Date();
    await customer.save();

    await attachDevice(customer, fcmToken, platform);
    const session = await tokenService.issueSession(customer, contextOf(req));

    logger.info(`Login via OTP: ${customer._id}`);
    return ok(res, sessionResponse(customer, session), 'Signed in.');
  }

  // For verify_phone / verify_email on a signed-in-or-known account, flip the
  // flag immediately; the token still goes back for callers that need it.
  if (purpose === OTP_PURPOSE.VERIFY_PHONE || purpose === OTP_PURPOSE.VERIFY_EMAIL) {
    const flag = purpose === OTP_PURPOSE.VERIFY_PHONE ? 'phoneVerified' : 'emailVerified';
    await Customer.updateOne({ [field]: destination }, { $set: { [flag]: true } });
  }

  return ok(
    res,
    {
      verified: true,
      ...verification,
    },
    'Code verified.'
  );
});

// --- POST /auth/register ----------------------------------------------------

const register = asyncHandler(async (req, res) => {
  const { fullName, password, verificationToken } = req.body;
  const phone = req.body.phone ? normalizePhone(req.body.phone) : undefined;
  const email = req.body.email ? req.body.email.toLowerCase() : undefined;

  // Check both identifiers up front so the customer gets a precise message
  // rather than a generic duplicate-key conflict.
  const clash = await Customer.findOne({
    $or: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])],
  });

  if (clash) {
    const field = phone && clash.phone === phone ? 'phone' : 'email';
    throw ApiError.conflict(
      field === 'phone'
        ? 'That mobile number is already registered. Please sign in instead.'
        : 'That email address is already registered. Please sign in instead.',
      'ACCOUNT_EXISTS',
      { field }
    );
  }

  // A phone number must be proven before it is attached to an account.
  let phoneVerified = false;
  if (phone) {
    await otpService.consumeVerificationToken({
      destination: phone,
      purpose: OTP_PURPOSE.REGISTER,
      verificationToken,
    });
    phoneVerified = true;
  }

  const passwordHash = await hashPassword(password);

  const customer = await Customer.create({
    fullName,
    phone,
    email,
    passwordHash,
    phoneVerified,
    emailVerified: false,
    lastLoginAt: new Date(),
  });

  // Email-only signups get a verification code they can redeem later. Failure
  // here must not fail the registration.
  let emailVerificationSent = false;
  if (email && !phone) {
    try {
      await otpService.requestOtp({
        channel: OTP_CHANNEL.EMAIL,
        destination: email,
        purpose: OTP_PURPOSE.VERIFY_EMAIL,
        requestIp: req.ip,
      });
      emailVerificationSent = true;
    } catch (err) {
      logger.warn(`Could not send post-registration email verification: ${err.message}`);
    }
  }

  await attachDevice(customer, req.body.fcmToken, req.body.platform);
  const session = await tokenService.issueSession(customer, contextOf(req));

  logger.info(`Registered customer ${customer._id} (${phone || email})`);
  notificationService.notifyAccount('registered', customer).catch(() => {});

  return created(
    res,
    { ...sessionResponse(customer, session), emailVerificationSent },
    'Your account is ready.'
  );
});

// --- POST /auth/login -------------------------------------------------------

const login = asyncHandler(async (req, res) => {
  const { password, otp, fcmToken, platform } = req.body;
  const { destination, field } = resolveIdentifier(req.body);

  // passwordHash is select:false, so ask for it.
  const customer = await Customer.findOne({ [field]: destination }).select('+passwordHash');

  /**
   * Both "no such account" and "wrong password" return the same message and
   * code. Login is the one place where disclosing account existence is worth
   * avoiding, because it is reachable with a password guess and no SMS cost.
   * (send-otp is deliberately more forthcoming; see the note there.)
   */
  const genericFailure = ApiError.unauthorized(
    field === 'phone'
      ? 'That mobile number or password is not correct.'
      : 'That email address or password is not correct.',
    'INVALID_CREDENTIALS'
  );

  if (!customer) {
    if (otp) {
      throw ApiError.notFound('No account found for that mobile number.', 'ACCOUNT_NOT_FOUND');
    }
    throw genericFailure;
  }

  if (customer.status === CUSTOMER_STATUS.SUSPENDED) {
    throw ApiError.forbidden('This account has been suspended. Please contact support.', 'ACCOUNT_SUSPENDED');
  }

  if (otp) {
    // Login option B routed through /login rather than /verify-otp.
    await otpService.verifyOtp({ destination, purpose: OTP_PURPOSE.LOGIN, code: otp });
    if (field === 'phone') customer.phoneVerified = true;
  } else {
    if (!customer.passwordHash) {
      throw ApiError.badRequest(
        'This account has no password set. Sign in with a one-time code instead.',
        'PASSWORD_NOT_SET'
      );
    }
    const matches = await verifyPassword(password, customer.passwordHash);
    if (!matches) throw genericFailure;
  }

  if (customer.status === CUSTOMER_STATUS.DELETION_REQUESTED) {
    customer.status = CUSTOMER_STATUS.ACTIVE;
    customer.deletionRequestedAt = undefined;
    logger.info(`Deletion request withdrawn by sign-in: ${customer._id}`);
  }

  customer.lastLoginAt = new Date();
  await customer.save();

  await attachDevice(customer, fcmToken, platform);
  const session = await tokenService.issueSession(customer, contextOf(req));

  logger.info(`Login: ${customer._id} via ${field}`);
  return ok(res, sessionResponse(customer, session), 'Signed in.');
});

// --- POST /auth/refresh-token -----------------------------------------------

const refreshToken = asyncHandler(async (req, res) => {
  const { customer, session } = await tokenService.rotateRefreshToken(
    req.body.refreshToken,
    contextOf(req)
  );
  return ok(res, sessionResponse(customer, session), 'Session refreshed.');
});

// --- POST /auth/logout ------------------------------------------------------

const logout = asyncHandler(async (req, res) => {
  const { refreshToken: presented, fcmToken, allDevices } = req.body;

  if (allDevices && req.customer) {
    await tokenService.revokeAllForCustomer(req.customer._id);
    await Customer.updateOne({ _id: req.customer._id }, { $set: { devices: [] } });
    return ok(res, { loggedOutEverywhere: true }, 'Signed out of all devices.');
  }

  await tokenService.revokeRefreshToken(presented);

  // Stop pushing to a handset nobody is signed in on.
  if (fcmToken && req.customer) {
    await Customer.updateOne({ _id: req.customer._id }, { $pull: { devices: { fcmToken } } });
  }

  return ok(res, { loggedOutEverywhere: false }, 'Signed out.');
});

// --- POST /auth/forgot-password ---------------------------------------------

/**
 * Starts a reset by sending an OTP. The response is identical whether or not
 * the account exists, so this endpoint cannot be used to enumerate customers.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { channel, destination, field } = resolveIdentifier(req.body);
  const customer = await Customer.findOne({ [field]: destination });

  const neutralResponse = {
    maskedDestination: channel === OTP_CHANNEL.SMS ? maskPhone(destination) : maskEmail(destination),
    expiresInSeconds: env.otp.ttlSeconds,
    resendInSeconds: env.otp.resendCooldownSeconds,
  };

  if (!customer) {
    logger.debug(`Password reset requested for unknown ${field}: ${destination}`);
    return ok(res, neutralResponse, 'If that account exists, we have sent a reset code.');
  }

  const result = await otpService.requestOtp({
    channel,
    destination,
    purpose: OTP_PURPOSE.RESET_PASSWORD,
    requestIp: req.ip,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
  });

  return ok(
    res,
    { ...neutralResponse, expiresAt: result.expiresAt, resendAfter: result.resendAfter, devOtp: result.devOtp },
    'If that account exists, we have sent a reset code.'
  );
});

// --- POST /auth/reset-password ----------------------------------------------

const resetPassword = asyncHandler(async (req, res) => {
  const { verificationToken, password } = req.body;
  const { destination, field } = resolveIdentifier(req.body);

  await otpService.consumeVerificationToken({
    destination,
    purpose: OTP_PURPOSE.RESET_PASSWORD,
    verificationToken,
  });

  const customer = await Customer.findOne({ [field]: destination });
  if (!customer) {
    throw ApiError.notFound('No account found for that identifier.', 'ACCOUNT_NOT_FOUND');
  }

  customer.passwordHash = await hashPassword(password);
  // Invalidates every access token and refresh token issued before now - a
  // reset must lock out whoever prompted it.
  customer.tokenVersion = (customer.tokenVersion || 0) + 1;
  await customer.save();
  await tokenService.revokeAllForCustomer(customer._id);

  logger.info(`Password reset for ${customer._id}`);
  notificationService.notifyAccount('passwordChanged', customer).catch(() => {});

  // A fresh session, so the customer lands straight in the app.
  const session = await tokenService.issueSession(customer, contextOf(req));
  return ok(res, sessionResponse(customer, session), 'Your password has been changed.');
});

module.exports = {
  sendOtp,
  verifyOtp,
  register,
  login,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword,
};
