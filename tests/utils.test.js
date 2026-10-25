'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test_access_secret_value';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_value';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/test';

const { normalizePhone, maskPhone, maskEmail, formatPhoneForDisplay } = require('../src/utils/phone');
const { assertPasswordStrength, sha256, randomNumericCode, randomToken } = require('../src/utils/password');
const ms = require('../src/utils/ms');
const { haversineKm, assertValidPoint } = require('../src/services/geo.service');
const ApiError = require('../src/utils/ApiError');

test.describe('normalizePhone', () => {
  test('prefixes a bare 10-digit national number', () => {
    assert.equal(normalizePhone('9876543210'), '+919876543210');
  });

  test('keeps an existing country code', () => {
    assert.equal(normalizePhone('+919876543210'), '+919876543210');
  });

  test('strips separators', () => {
    assert.equal(normalizePhone('+91 98765-43210'), '+919876543210');
    assert.equal(normalizePhone('(98765) 43210'), '+919876543210');
    assert.equal(normalizePhone('98765.43210'), '+919876543210');
  });

  test('drops a national trunk prefix', () => {
    assert.equal(normalizePhone('09876543210'), '+919876543210');
  });

  test('honours a different default country code', () => {
    assert.equal(normalizePhone('7700900123', { countryCode: '+44' }), '+447700900123');
  });

  test('is idempotent', () => {
    const once = normalizePhone('9876543210');
    assert.equal(normalizePhone(once), once);
  });

  test('rejects an ambiguous number with no country code', () => {
    // Nine digits with no '+' cannot be safely guessed either way.
    assert.throws(() => normalizePhone('98765432'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'INVALID_PHONE');
      return true;
    });
  });

  test('rejects empty and non-string input', () => {
    assert.throws(() => normalizePhone(''), ApiError);
    assert.throws(() => normalizePhone(null), ApiError);
    assert.throws(() => normalizePhone(undefined), ApiError);
    assert.throws(() => normalizePhone(1234567890), ApiError);
  });

  test('rejects a number that is too long for E.164', () => {
    assert.throws(() => normalizePhone('+9198765432109876'), ApiError);
  });

  test('rejects a country code starting with zero', () => {
    assert.throws(() => normalizePhone('+09876543210'), ApiError);
  });
});

test.describe('masking', () => {
  test('masks a phone number but keeps enough to recognise it', () => {
    const masked = maskPhone('+919876543210');

    assert.ok(masked.startsWith('+91'));
    assert.ok(masked.endsWith('10'));
    assert.ok(!masked.includes('98765'), 'the middle digits must not leak');
  });

  test('masks an email local part', () => {
    const masked = maskEmail('customer@example.com');

    assert.ok(masked.startsWith('cu'));
    assert.ok(masked.endsWith('@example.com'));
    assert.ok(!masked.includes('customer'));
  });

  test('handles malformed input without throwing', () => {
    assert.equal(maskPhone(''), '');
    assert.equal(maskPhone(null), '');
    assert.equal(maskEmail('not-an-email'), '');
    assert.equal(maskEmail(null), '');
  });
});

test.describe('formatPhoneForDisplay', () => {
  test('groups an Indian number', () => {
    assert.equal(formatPhoneForDisplay('+919876543210'), '+91 98765 43210');
  });

  test('passes through anything it cannot group', () => {
    assert.equal(formatPhoneForDisplay('12345'), '12345');
    assert.equal(formatPhoneForDisplay('+1555'), '+1555');
  });
});

test.describe('password policy', () => {
  test('accepts a password meeting the policy', () => {
    assert.doesNotThrow(() => assertPasswordStrength('Password123'));
  });

  test('rejects short passwords', () => {
    assert.throws(() => assertPasswordStrength('Pass1'), (error) => {
      assert.equal(error.code, 'WEAK_PASSWORD');
      return true;
    });
  });

  test('requires both a letter and a digit', () => {
    assert.throws(() => assertPasswordStrength('12345678'), ApiError);
    assert.throws(() => assertPasswordStrength('abcdefgh'), ApiError);
  });

  test('rejects a password long enough to be a bcrypt DoS', () => {
    assert.throws(() => assertPasswordStrength('a1'.repeat(70)), ApiError);
  });

  test('rejects non-string input', () => {
    assert.throws(() => assertPasswordStrength(null), ApiError);
    assert.throws(() => assertPasswordStrength(12345678), ApiError);
  });
});

test.describe('crypto helpers', () => {
  test('sha256 is stable and differs per input', () => {
    assert.equal(sha256('123456'), sha256('123456'));
    assert.notEqual(sha256('123456'), sha256('123457'));
    assert.equal(sha256('x').length, 64);
  });

  test('randomNumericCode is the requested length and digits only', () => {
    for (const length of [4, 6, 8]) {
      const code = randomNumericCode(length);
      assert.equal(code.length, length);
      assert.match(code, /^\d+$/);
    }
  });

  test('randomNumericCode does not repeat in practice', () => {
    const codes = new Set(Array.from({ length: 200 }, () => randomNumericCode(6)));
    // 200 draws from a million values should essentially never collide twice.
    assert.ok(codes.size > 195, `expected near-unique codes, got ${codes.size}/200`);
  });

  test('randomToken is hex of the expected width', () => {
    assert.match(randomToken(16), /^[0-9a-f]{32}$/);
    assert.notEqual(randomToken(), randomToken());
  });
});

test.describe('ms', () => {
  test('parses every supported unit', () => {
    assert.equal(ms('500ms'), 500);
    assert.equal(ms('30s'), 30_000);
    assert.equal(ms('15m'), 900_000);
    assert.equal(ms('24h'), 86_400_000);
    assert.equal(ms('30d'), 2_592_000_000);
    assert.equal(ms('2w'), 1_209_600_000);
  });

  test('treats a bare number as milliseconds', () => {
    assert.equal(ms(1500), 1500);
    assert.equal(ms('1500'), 1500);
  });

  test('is case-insensitive and tolerates whitespace', () => {
    assert.equal(ms(' 15M '), 900_000);
    assert.equal(ms('24H'), 86_400_000);
  });

  test('throws on nonsense rather than silently returning NaN', () => {
    assert.throws(() => ms('soon'));
    assert.throws(() => ms('15 years'));
    assert.throws(() => ms(''));
  });
});

test.describe('haversineKm', () => {
  test('is zero for the same point', () => {
    const point = { latitude: 11.0183, longitude: 76.9725 };
    assert.equal(haversineKm(point, point), 0);
  });

  test('matches a known distance', () => {
    // Gandhipuram to Tidel Park, Coimbatore: roughly 8 km straight line.
    const distance = haversineKm(
      { latitude: 11.0183, longitude: 76.9725 },
      { latitude: 11.03, longitude: 77.0434 }
    );

    assert.ok(distance > 7 && distance < 9, `expected ~8km, got ${distance}`);
  });

  test('is symmetric', () => {
    const a = { latitude: 11.0183, longitude: 76.9725 };
    const b = { latitude: 11.03, longitude: 77.0434 };

    assert.ok(Math.abs(haversineKm(a, b) - haversineKm(b, a)) < 1e-9);
  });

  test('handles antipodal points without NaN', () => {
    const distance = haversineKm(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 180 }
    );

    assert.ok(Number.isFinite(distance));
    // Half the Earth's circumference.
    assert.ok(distance > 20_000 && distance < 20_100, `got ${distance}`);
  });
});

test.describe('assertValidPoint', () => {
  test('accepts real coordinates and returns numbers', () => {
    const point = assertValidPoint({ latitude: '11.0183', longitude: '76.9725' }, 'Pickup');

    assert.equal(point.latitude, 11.0183);
    assert.equal(typeof point.longitude, 'number');
  });

  test('rejects the uninitialised (0, 0) pair', () => {
    // This is the one that would otherwise price a trip to the Gulf of Guinea.
    assert.throws(() => assertValidPoint({ latitude: 0, longitude: 0 }, 'Pickup'), (error) => {
      assert.equal(error.code, 'INVALID_COORDINATES');
      return true;
    });
  });

  test('rejects out-of-range values', () => {
    assert.throws(() => assertValidPoint({ latitude: 91, longitude: 0 }, 'Pickup'), ApiError);
    assert.throws(() => assertValidPoint({ latitude: 0, longitude: 181 }, 'Pickup'), ApiError);
  });

  test('rejects missing or non-numeric values', () => {
    assert.throws(() => assertValidPoint({}, 'Pickup'), ApiError);
    assert.throws(() => assertValidPoint({ latitude: 'abc', longitude: 1 }, 'Pickup'), ApiError);
    assert.throws(() => assertValidPoint(null, 'Pickup'), ApiError);
  });

  test('names the offending field in the message', () => {
    assert.throws(() => assertValidPoint({}, 'Destination'), (error) => {
      assert.match(error.message, /Destination/);
      return true;
    });
  });
});
