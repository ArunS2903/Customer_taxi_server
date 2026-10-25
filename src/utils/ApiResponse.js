'use strict';

/**
 * Every successful response uses this envelope so the Dio layer can unwrap it
 * with one generic helper:  { success: true, message, data }
 */
function ok(res, data = null, message = 'OK', statusCode = 200) {
  return res.status(statusCode).json({ success: true, message, data });
}

function created(res, data = null, message = 'Created') {
  return ok(res, data, message, 201);
}

/** Cursor-free page envelope: { items, page, limit, total, hasMore }. */
function paginated(res, items, { page, limit, total }, message = 'OK') {
  return ok(res, {
    items,
    page,
    limit,
    total,
    hasMore: page * limit < total,
  }, message);
}

module.exports = { ok, created, paginated };
