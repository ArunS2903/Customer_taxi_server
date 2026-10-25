'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const ApiError = require('./ApiError');

const BCRYPT_ROUNDS = 12;

/** Minimum policy: 8+ chars with at least one letter and one digit. */
function assertPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw ApiError.badRequest('Password must be at least 8 characters.', 'WEAK_PASSWORD');
  }
  if (password.length > 128) {
    throw ApiError.badRequest('Password must be 128 characters or fewer.', 'WEAK_PASSWORD');
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw ApiError.badRequest(
      'Password must contain at least one letter and one number.',
      'WEAK_PASSWORD'
    );
  }
}

async function hashPassword(password) {
  assertPasswordStrength(password);
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash || typeof password !== 'string') return false;
  return bcrypt.compare(password, hash);
}

/** SHA-256 hex digest - used for OTP codes and refresh tokens at rest. */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time comparison for already-hashed values. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Cryptographically random numeric code of the requested length. */
function randomNumericCode(length = 6) {
  let out = '';
  while (out.length < length) {
    out += crypto.randomInt(0, 10).toString();
  }
  return out;
}

module.exports = {
  assertPasswordStrength,
  hashPassword,
  verifyPassword,
  sha256,
  safeEqual,
  randomToken,
  randomNumericCode,
};
