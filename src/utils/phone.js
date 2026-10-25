'use strict';

const ApiError = require('./ApiError');

/**
 * Normalises a user-typed phone number to E.164.
 *
 * Deliberately conservative: we only accept a number that already carries a
 * country code (leading `+`), or a 10-digit national number which we prefix
 * with the configured default country code. Anything else is rejected rather
 * than guessed, because a silently wrong number means an OTP that never lands.
 */
const DEFAULT_COUNTRY_CODE = '+91';

function normalizePhone(raw, { countryCode = DEFAULT_COUNTRY_CODE } = {}) {
  if (typeof raw !== 'string') {
    throw ApiError.badRequest('Mobile number is required.', 'INVALID_PHONE');
  }

  // Keep digits and a single leading plus.
  const trimmed = raw.trim().replace(/[\s()\-.]/g, '');
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (!digits) {
    throw ApiError.badRequest('Mobile number is required.', 'INVALID_PHONE');
  }

  let e164;
  if (hasPlus) {
    e164 = `+${digits}`;
  } else if (digits.length === 10) {
    e164 = `${countryCode}${digits}`;
  } else if (digits.length > 10 && digits.startsWith('0')) {
    // National trunk prefix, e.g. 0 98765 43210
    e164 = `${countryCode}${digits.replace(/^0+/, '')}`;
  } else {
    throw ApiError.badRequest(
      'Enter the mobile number with its country code, for example +919876543210.',
      'INVALID_PHONE'
    );
  }

  if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
    throw ApiError.badRequest('That does not look like a valid mobile number.', 'INVALID_PHONE');
  }

  return e164;
}

/** `+919876543210` -> `+91 98765 43210` for display in notifications. */
function formatPhoneForDisplay(e164) {
  if (typeof e164 !== 'string' || !e164.startsWith('+')) return e164;
  const digits = e164.slice(1);
  if (digits.length <= 4) return e164;
  const cc = digits.slice(0, digits.length - 10) || digits.slice(0, 2);
  const rest = digits.slice(cc.length);
  if (rest.length !== 10) return e164;
  return `+${cc} ${rest.slice(0, 5)} ${rest.slice(5)}`;
}

/** Masks all but the last two digits, for "we sent a code to +91 •••• ••10". */
function maskPhone(e164) {
  if (typeof e164 !== 'string' || e164.length < 4) return '';
  return `${e164.slice(0, 3)}${'•'.repeat(Math.max(0, e164.length - 5))}${e164.slice(-2)}`;
}

function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  const head = local.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

module.exports = {
  DEFAULT_COUNTRY_CODE,
  normalizePhone,
  formatPhoneForDisplay,
  maskPhone,
  maskEmail,
};
