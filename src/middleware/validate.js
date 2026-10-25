'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Validates `req.body` / `req.query` / `req.params` against a zod schema and
 * replaces the raw value with the parsed one.
 *
 * Replacing rather than merely checking matters: zod strips unknown keys, so a
 * client cannot smuggle extra fields (`bookingStatus`, `estimatedFare`,
 * `customerId`) into a document by adding them to the body.
 */
function validate(schema, source = 'body') {
  return function validator(req, res, next) {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const fields = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || source;
        // Keep the first message per field; later ones are usually noise.
        if (!fields[key]) fields[key] = issue.message;
      }

      return next(
        ApiError.badRequest('Please check the highlighted fields.', 'VALIDATION_ERROR', { fields })
      );
    }

    req[source] = result.data;
    return next();
  };
}

module.exports = { validate };
