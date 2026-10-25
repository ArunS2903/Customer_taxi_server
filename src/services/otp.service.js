'use strict';

const { env } = require('../config/env');
const Otp = require('../models/Otp');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');
const { sha256, randomNumericCode, randomToken } = require('../utils/password');
const { OTP_CHANNEL } = require('../constants/domain');
const smsProvider = require('./sms.provider');
const emailProvider = require('./email.provider');
const { maskPhone, maskEmail } = require('../utils/phone');

/**
 * OTP issue / verify, with the policy limits that keep it from being an SMS
 * money pit or a brute-force target:
 *
 *   - a per-destination resend cooldown (OTP_RESEND_COOLDOWN_SECONDS)
 *   - a per-destination hourly cap (OTP_MAX_PER_HOUR)
 *   - a per-code attempt cap (OTP_MAX_ATTEMPTS)
 *   - expiry (OTP_TTL_SECONDS), enforced in code and by a TTL index
 *
 * Codes are stored only as SHA-256 digests. A verified code is exchanged for a
 * single-use `verificationToken` that authorises exactly one follow-up action,
 * so "verify OTP" and "set my new password" can be two separate requests
 * without leaving an open window on the account.
 */

const VERIFICATION_TOKEN_TTL_MS = 10 * 60 * 1000;

function messageFor(purpose, code) {
  const minutes = Math.round(env.otp.ttlSeconds / 60);
  switch (purpose) {
    case 'reset_password':
      return `${code} is your password reset code. It expires in ${minutes} minutes. Do not share it with anyone.`;
    case 'login':
      return `${code} is your login code. It expires in ${minutes} minutes. Do not share it with anyone.`;
    default:
      return `${code} is your verification code. It expires in ${minutes} minutes. Do not share it with anyone.`;
  }
}

function subjectFor(purpose) {
  switch (purpose) {
    case 'reset_password':
      return 'Your password reset code';
    case 'login':
      return 'Your login code';
    default:
      return 'Verify your email address';
  }
}

/**
 * Creates and delivers an OTP.
 *
 * Returns `{ maskedDestination, expiresAt, resendAfter, devOtp }`. `devOtp` is
 * only populated when the provider is mocked AND we are not in production, so a
 * developer can complete the flow without an SMS gateway; it is never present
 * in a production response.
 */
async function requestOtp({ channel, destination, purpose, requestIp, userAgent }) {
  const now = Date.now();
  const normalizedDestination = String(destination).toLowerCase();

  // Resend cooldown: look at the most recent unconsumed code for this target.
  const latest = await Otp.findOne({ destination: normalizedDestination, purpose })
    .sort({ createdAt: -1 })
    .lean();

  if (latest && !latest.consumedAt && new Date(latest.resendAfter).getTime() > now) {
    const waitSeconds = Math.ceil((new Date(latest.resendAfter).getTime() - now) / 1000);
    throw ApiError.tooManyRequests(
      `Please wait ${waitSeconds} more second${waitSeconds === 1 ? '' : 's'} before requesting another code.`,
      'OTP_COOLDOWN',
      { retryAfterSeconds: waitSeconds }
    );
  }

  // Hourly cap per destination.
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const recentCount = await Otp.countDocuments({
    destination: normalizedDestination,
    createdAt: { $gte: oneHourAgo },
  });

  if (recentCount >= env.otp.maxPerHour) {
    throw ApiError.tooManyRequests(
      'Too many verification codes requested for this number. Please try again in an hour.',
      'OTP_LIMIT_REACHED'
    );
  }

  const code = randomNumericCode(env.otp.length);
  const expiresAt = new Date(now + env.otp.ttlSeconds * 1000);
  const resendAfter = new Date(now + env.otp.resendCooldownSeconds * 1000);

  // Any older live code for the same purpose is retired, so only the newest
  // code works. Without this, a resend would leave two valid codes.
  await Otp.updateMany(
    { destination: normalizedDestination, purpose, consumedAt: null },
    { $set: { consumedAt: new Date() } }
  );

  const record = await Otp.create({
    channel,
    destination: normalizedDestination,
    purpose,
    codeHash: sha256(code),
    expiresAt,
    resendAfter,
    maxAttempts: env.otp.maxAttempts,
    requestIp,
    userAgent,
  });

  let mocked = false;
  try {
    if (channel === OTP_CHANNEL.SMS) {
      const result = await smsProvider.sendSms({
        to: normalizedDestination,
        message: messageFor(purpose, code),
      });
      mocked = Boolean(result.mocked);
    } else {
      const result = await emailProvider.sendEmail({
        to: normalizedDestination,
        subject: subjectFor(purpose),
        text: messageFor(purpose, code),
      });
      mocked = Boolean(result.mocked);
    }
  } catch (err) {
    // Delivery failed, so the code is unusable. Retire it rather than leaving
    // the customer staring at a screen waiting for an SMS that will not arrive.
    await Otp.deleteOne({ _id: record._id });
    logger.error(`OTP delivery failed for ${normalizedDestination}: ${err.message}`);
    throw ApiError.internal(
      'We could not send the verification code right now. Please try again.',
      'OTP_DELIVERY_FAILED'
    );
  }

  return {
    maskedDestination:
      channel === OTP_CHANNEL.SMS ? maskPhone(normalizedDestination) : maskEmail(normalizedDestination),
    expiresAt,
    resendAfter,
    expiresInSeconds: env.otp.ttlSeconds,
    resendInSeconds: env.otp.resendCooldownSeconds,
    // Development affordance only; see the note on this function.
    devOtp: mocked && !env.isProduction ? code : undefined,
  };
}

/**
 * Verifies a code and, on success, consumes it and returns a one-use
 * `verificationToken` the caller must present to the follow-up endpoint.
 */
async function verifyOtp({ destination, purpose, code }) {
  const normalizedDestination = String(destination).toLowerCase();

  const record = await Otp.findOne({
    destination: normalizedDestination,
    purpose,
    consumedAt: null,
  }).sort({ createdAt: -1 });

  if (!record) {
    throw ApiError.badRequest(
      'No active verification code for this number. Please request a new one.',
      'OTP_NOT_FOUND'
    );
  }

  if (record.isExpired()) {
    throw ApiError.badRequest('That code has expired. Please request a new one.', 'OTP_EXPIRED');
  }

  if (record.attempts >= record.maxAttempts) {
    throw ApiError.tooManyRequests(
      'Too many incorrect attempts. Please request a new code.',
      'OTP_ATTEMPTS_EXCEEDED'
    );
  }

  if (record.codeHash !== sha256(String(code).trim())) {
    record.attempts += 1;
    await record.save();
    const remaining = Math.max(0, record.maxAttempts - record.attempts);
    throw ApiError.badRequest(
      remaining > 0
        ? `That code is not correct. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`
        : 'That code is not correct. Please request a new code.',
      'OTP_INCORRECT',
      { attemptsRemaining: remaining }
    );
  }

  const verificationToken = randomToken(32);
  record.consumedAt = new Date();
  record.verificationToken = sha256(verificationToken);
  record.verificationTokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
  await record.save();

  return {
    verificationToken,
    verificationTokenExpiresAt: record.verificationTokenExpiresAt,
  };
}

/**
 * Redeems a verificationToken produced by `verifyOtp`. Throws unless the token
 * matches a consumed, unexpired OTP for this destination and purpose. The token
 * is cleared on success so it cannot be replayed.
 */
async function consumeVerificationToken({ destination, purpose, verificationToken }) {
  if (!verificationToken) {
    throw ApiError.badRequest(
      'Verify your code before completing this step.',
      'VERIFICATION_TOKEN_MISSING'
    );
  }

  const normalizedDestination = String(destination).toLowerCase();
  const record = await Otp.findOne({
    destination: normalizedDestination,
    purpose,
    verificationToken: sha256(verificationToken),
  }).select('+verificationToken');

  if (!record) {
    throw ApiError.badRequest(
      'That verification is no longer valid. Please request a new code.',
      'VERIFICATION_TOKEN_INVALID'
    );
  }

  if (!record.verificationTokenExpiresAt || record.verificationTokenExpiresAt.getTime() <= Date.now()) {
    throw ApiError.badRequest(
      'That verification has expired. Please request a new code.',
      'VERIFICATION_TOKEN_EXPIRED'
    );
  }

  record.verificationToken = null;
  record.verificationTokenExpiresAt = null;
  await record.save();

  return true;
}

module.exports = { requestOtp, verifyOtp, consumeVerificationToken };
