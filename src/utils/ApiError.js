'use strict';

/**
 * Error type carrying an HTTP status and a stable machine-readable `code`.
 * The Flutter client switches on `code`, never on the message text.
 */
class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, code = 'BAD_REQUEST', details) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(message = 'Authentication required.', code = 'UNAUTHORIZED', details) {
    return new ApiError(401, code, message, details);
  }

  static forbidden(message = 'You are not allowed to do that.', code = 'FORBIDDEN', details) {
    return new ApiError(403, code, message, details);
  }

  static notFound(message = 'Resource not found.', code = 'NOT_FOUND', details) {
    return new ApiError(404, code, message, details);
  }

  static conflict(message, code = 'CONFLICT', details) {
    return new ApiError(409, code, message, details);
  }

  static tooManyRequests(message = 'Too many requests. Please try again later.', code = 'RATE_LIMITED', details) {
    return new ApiError(429, code, message, details);
  }

  static internal(message = 'Something went wrong on our side.', code = 'INTERNAL_ERROR', details) {
    return new ApiError(500, code, message, details);
  }
}

module.exports = ApiError;
