'use strict';

const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');
const { env } = require('../config/env');

/** 404 for any path that no route matched. */
function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`No route for ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

/**
 * Terminal error handler. Produces the same envelope as ApiResponse so the
 * client has exactly one response shape to parse:
 *   { success: false, message, code, details? }
 *
 * Unexpected errors are logged with their stack but reported generically - the
 * client never sees a Mongo error string or a file path.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let apiError = err;

  if (!(err instanceof ApiError)) {
    // Mongoose validation: report the field messages, they are user-meaningful.
    if (err.name === 'ValidationError') {
      const fields = Object.fromEntries(
        Object.entries(err.errors || {}).map(([key, detail]) => [key, detail.message])
      );
      apiError = ApiError.badRequest('Some details are not valid.', 'VALIDATION_ERROR', { fields });
    } else if (err.name === 'CastError') {
      apiError = ApiError.badRequest(`"${err.value}" is not a valid ${err.path}.`, 'INVALID_ID');
    } else if (err.code === 11000) {
      // Duplicate key. Name the field without echoing the value back.
      const field = Object.keys(err.keyPattern || {})[0] || 'value';
      const labels = { phone: 'mobile number', email: 'email address' };
      apiError = ApiError.conflict(
        `That ${labels[field] || field} is already registered.`,
        'DUPLICATE_KEY',
        { field }
      );
    } else if (err.type === 'entity.parse.failed') {
      apiError = ApiError.badRequest('Request body is not valid JSON.', 'MALFORMED_JSON');
    } else if (err.type === 'entity.too.large') {
      apiError = ApiError.badRequest('Request body is too large.', 'PAYLOAD_TOO_LARGE');
    } else {
      logger.error(`Unhandled ${err.name || 'Error'} on ${req.method} ${req.originalUrl}:`, err.stack || err.message);
      apiError = ApiError.internal();
    }
  }

  if (apiError.statusCode >= 500) {
    logger.error(`${apiError.code} on ${req.method} ${req.originalUrl}: ${err.message}`);
  }

  const body = {
    success: false,
    message: apiError.message,
    code: apiError.code,
  };

  if (apiError.details) body.details = apiError.details;
  // Stacks are a development aid only.
  if (env.isDevelopment && apiError.statusCode >= 500) body.stack = err.stack;

  res.status(apiError.statusCode || 500).json(body);
}

module.exports = { notFoundHandler, errorHandler };
