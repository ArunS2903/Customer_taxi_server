'use strict';

const jwt = require('jsonwebtoken');
const ms = require('../utils/ms');
const { env } = require('../config/env');
const RefreshToken = require('../models/RefreshToken');
const ApiError = require('../utils/ApiError');
const { sha256, randomToken } = require('../utils/password');

/**
 * Access tokens are short-lived JWTs carrying the customer id and a
 * `tokenVersion`. Refresh tokens are opaque random strings stored hashed, and
 * rotate on every use.
 */

function signAccessToken(customer) {
  return jwt.sign(
    {
      sub: customer._id.toString(),
      tv: customer.tokenVersion || 0,
      typ: 'access',
    },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessTtl }
  );
}

function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.jwt.accessSecret);
    if (payload.typ !== 'access') {
      throw ApiError.unauthorized('Wrong token type.', 'TOKEN_INVALID');
    }
    return payload;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'TokenExpiredError') {
      // The client's Dio interceptor keys its refresh-and-retry on this code.
      throw ApiError.unauthorized('Your session has expired.', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid access token.', 'TOKEN_INVALID');
  }
}

async function issueRefreshToken(customer, { userAgent, ip } = {}) {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + ms(env.jwt.refreshTtl));

  await RefreshToken.create({
    customerId: customer._id,
    tokenHash: sha256(token),
    expiresAt,
    userAgent,
    ip,
  });

  return { token, expiresAt };
}

/** Issues a fresh access + refresh pair. Used by login, register and verify. */
async function issueSession(customer, context = {}) {
  const accessToken = signAccessToken(customer);
  const { token: refreshToken, expiresAt } = await issueRefreshToken(customer, context);

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresIn: Math.floor(ms(env.jwt.accessTtl) / 1000),
    refreshTokenExpiresAt: expiresAt,
    tokenType: 'Bearer',
  };
}

/**
 * One-use rotation. Presenting a token revokes it and returns a new pair.
 *
 * If a token that was already revoked is presented, that is either a replay or
 * a stolen token being used after the legitimate client rotated it. We cannot
 * tell which, so we revoke the whole family for that customer and force a
 * fresh login.
 */
async function rotateRefreshToken(presentedToken, context = {}) {
  if (!presentedToken || typeof presentedToken !== 'string') {
    throw ApiError.unauthorized('Refresh token is required.', 'REFRESH_TOKEN_MISSING');
  }

  const presentedHash = sha256(presentedToken);
  const stored = await RefreshToken.findOne({ tokenHash: presentedHash });

  if (!stored) {
    throw ApiError.unauthorized('Refresh token is not recognised.', 'REFRESH_TOKEN_INVALID');
  }

  if (stored.revokedAt) {
    await RefreshToken.updateMany(
      { customerId: stored.customerId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    throw ApiError.unauthorized(
      'This session was already refreshed elsewhere. Please sign in again.',
      'REFRESH_TOKEN_REUSED'
    );
  }

  if (!stored.isActive()) {
    throw ApiError.unauthorized('Your session has expired. Please sign in again.', 'REFRESH_TOKEN_EXPIRED');
  }

  // Load the customer lazily to avoid a circular require at module load.
  const Customer = require('../models/Customer');
  const customer = await Customer.findById(stored.customerId);
  if (!customer) {
    throw ApiError.unauthorized('Account no longer exists.', 'ACCOUNT_NOT_FOUND');
  }
  if (customer.status === 'suspended') {
    throw ApiError.forbidden('This account has been suspended.', 'ACCOUNT_SUSPENDED');
  }

  const accessToken = signAccessToken(customer);
  const { token: newRefreshToken, expiresAt } = await issueRefreshToken(customer, context);

  stored.revokedAt = new Date();
  stored.replacedByHash = sha256(newRefreshToken);
  await stored.save();

  return {
    customer,
    session: {
      accessToken,
      refreshToken: newRefreshToken,
      accessTokenExpiresIn: Math.floor(ms(env.jwt.accessTtl) / 1000),
      refreshTokenExpiresAt: expiresAt,
      tokenType: 'Bearer',
    },
  };
}

/** Revokes one refresh token (logout on this device). */
async function revokeRefreshToken(token) {
  if (!token) return false;
  const result = await RefreshToken.updateOne(
    { tokenHash: sha256(token), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

/** Revokes every refresh token for a customer (logout everywhere). */
async function revokeAllForCustomer(customerId) {
  await RefreshToken.updateMany(
    { customerId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueSession,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForCustomer,
};
