'use strict';

const Customer = require('../models/Customer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const tokenService = require('../services/token.service');
const { CUSTOMER_STATUS } = require('../constants/domain');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Requires a valid access token and loads the customer onto `req.customer`.
 *
 * The token's `tv` claim is compared with the stored `tokenVersion`, so
 * changing a password or signing out everywhere invalidates access tokens that
 * were already issued - without this, a stolen token would stay usable until
 * its 15-minute expiry.
 */
const requireAuth = asyncHandler(async (req, res, next) => {
  const token = extractBearer(req);

  if (!token) {
    throw ApiError.unauthorized('Sign in to continue.', 'AUTH_REQUIRED');
  }

  const payload = tokenService.verifyAccessToken(token);
  const customer = await Customer.findById(payload.sub);

  if (!customer) {
    throw ApiError.unauthorized('Account no longer exists.', 'ACCOUNT_NOT_FOUND');
  }

  if ((customer.tokenVersion || 0) !== (payload.tv || 0)) {
    throw ApiError.unauthorized(
      'Your session is no longer valid. Please sign in again.',
      'TOKEN_REVOKED'
    );
  }

  if (customer.status === CUSTOMER_STATUS.SUSPENDED) {
    throw ApiError.forbidden(
      'This account has been suspended. Please contact support.',
      'ACCOUNT_SUSPENDED'
    );
  }

  req.customer = customer;
  req.accessToken = token;
  next();
});

/**
 * Attaches `req.customer` when a usable token is present but never rejects.
 * Used by endpoints that personalise their response for signed-in customers
 * while remaining public.
 */
const optionalAuth = asyncHandler(async (req, res, next) => {
  const token = extractBearer(req);
  if (!token) return next();

  try {
    const payload = tokenService.verifyAccessToken(token);
    const customer = await Customer.findById(payload.sub);
    if (customer && (customer.tokenVersion || 0) === (payload.tv || 0)) {
      req.customer = customer;
      req.accessToken = token;
    }
  } catch {
    // An invalid token on an optional route is simply ignored.
  }

  next();
});

module.exports = { requireAuth, optionalAuth, extractBearer };
