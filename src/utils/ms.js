'use strict';

const UNITS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Converts a duration string like `15m`, `30d` or `900s` to milliseconds.
 *
 * Exists so the JWT TTL env vars can be written in the same notation
 * jsonwebtoken accepts, while we can still compute an absolute expiry date for
 * the refresh-token document. A bare number is treated as milliseconds.
 */
module.exports = function ms(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(String(value));
  if (!match) {
    throw new Error(`Cannot parse duration "${value}". Use a form like 15m, 24h or 30d.`);
  }

  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  return amount * UNITS[unit];
};
