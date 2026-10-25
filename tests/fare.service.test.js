'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test_access_secret_value';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_value';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/test';

const { priceRoute, isNightTime } = require('../src/services/fare.service');

/**
 * Pricing is the one place where a bug costs real money in both directions, so
 * these tests pin the order of operations the service documents:
 * base + distance + time -> minimum floor -> multipliers -> flat fees -> tax.
 */

/** A plain rule object; the service only reads fields, never Mongoose methods. */
function rule(overrides = {}) {
  return {
    _id: 'rule1',
    currency: 'INR',
    currencySymbol: '₹',
    baseFare: 50,
    baseDistanceKm: 2,
    perKmRate: 10,
    perMinuteRate: 0,
    minimumFare: 0,
    waitingChargePerMinute: 2,
    freeWaitingMinutes: 5,
    platformFee: 0,
    additionalCharges: [],
    nightSurcharge: { enabled: false, startHour: 23, endHour: 5, multiplier: 1.25 },
    surgeMultiplier: 1,
    taxPercent: 0,
    cancellationFee: 0,
    freeCancellationMinutes: 2,
    ...overrides,
  };
}

/** Midday, so the night window is never accidentally in play. */
const noon = new Date('2026-03-14T12:00:00');

test('base fare covers the included distance', () => {
  const fare = priceRoute({ rule: rule(), distanceKm: 2, durationMinutes: 10, at: noon });

  assert.equal(fare.baseFare, 50);
  assert.equal(fare.distanceFare, 0);
  assert.equal(fare.total, 50);
});

test('distance beyond the included allowance is charged per km', () => {
  const fare = priceRoute({ rule: rule(), distanceKm: 12, durationMinutes: 25, at: noon });

  // (12 - 2) * 10 = 100, plus the 50 base.
  assert.equal(fare.distanceFare, 100);
  assert.equal(fare.total, 150);
});

test('a trip shorter than the included distance is never negative', () => {
  const fare = priceRoute({ rule: rule(), distanceKm: 0.5, durationMinutes: 3, at: noon });

  assert.equal(fare.distanceFare, 0);
  assert.equal(fare.total, 50);
});

test('per-minute rate is applied to the trip duration', () => {
  const fare = priceRoute({
    rule: rule({ perMinuteRate: 2 }),
    distanceKm: 2,
    durationMinutes: 20,
    at: noon,
  });

  assert.equal(fare.timeFare, 40);
  assert.equal(fare.total, 90);
});

test('minimum fare lifts a cheap trip and is flagged', () => {
  const fare = priceRoute({
    rule: rule({ minimumFare: 80 }),
    distanceKm: 1,
    durationMinutes: 5,
    at: noon,
  });

  assert.equal(fare.minimumFareApplied, true);
  assert.equal(fare.total, 80);
});

test('minimum fare does not reduce an expensive trip', () => {
  const fare = priceRoute({
    rule: rule({ minimumFare: 80 }),
    distanceKm: 20,
    durationMinutes: 40,
    at: noon,
  });

  assert.equal(fare.minimumFareApplied, false);
  // 50 + (18 * 10) = 230.
  assert.equal(fare.total, 230);
});

test('surge multiplies the ride charges', () => {
  const fare = priceRoute({
    rule: rule({ surgeMultiplier: 1.5 }),
    distanceKm: 12,
    durationMinutes: 25,
    at: noon,
  });

  // (50 + 100) * 1.5 = 225.
  assert.equal(fare.total, 225);
  assert.equal(fare.surgeMultiplier, 1.5);
});

test('flat fees are added after the multipliers, so surge does not inflate them', () => {
  const withoutSurge = priceRoute({
    rule: rule({ platformFee: 20 }),
    distanceKm: 12,
    durationMinutes: 25,
    at: noon,
  });
  const withSurge = priceRoute({
    rule: rule({ platformFee: 20, surgeMultiplier: 2 }),
    distanceKm: 12,
    durationMinutes: 25,
    at: noon,
  });

  assert.equal(withoutSurge.total, 170); // 150 + 20
  // Ride charges double to 300; the booking fee stays 20.
  assert.equal(withSurge.total, 320);
  assert.equal(withSurge.platformFee, 20);
});

test('additional charges are itemised and included', () => {
  const fare = priceRoute({
    rule: rule({ additionalCharges: [{ label: 'Airport levy', amount: 25 }] }),
    distanceKm: 12,
    durationMinutes: 25,
    at: noon,
  });

  assert.equal(fare.additionalCharges.length, 1);
  assert.equal(fare.additionalCharges[0].label, 'Airport levy');
  assert.equal(fare.total, 175);
});

test('tax is applied to the whole subtotal', () => {
  const fare = priceRoute({
    rule: rule({ taxPercent: 5, platformFee: 10 }),
    distanceKm: 12,
    durationMinutes: 25,
    at: noon,
  });

  assert.equal(fare.subtotal, 160);
  assert.equal(fare.taxAmount, 8);
  assert.equal(fare.total, 168);
});

test('waiting time is free up to the allowance, then charged', () => {
  const withinAllowance = priceRoute({
    rule: rule(),
    distanceKm: 12,
    durationMinutes: 25,
    waitingMinutes: 5,
    at: noon,
  });
  assert.equal(withinAllowance.waitingCharge, 0);

  const overAllowance = priceRoute({
    rule: rule(),
    distanceKm: 12,
    durationMinutes: 25,
    waitingMinutes: 12,
    at: noon,
  });
  // (12 - 5) * 2 = 14.
  assert.equal(overAllowance.waitingCharge, 14);
  assert.equal(overAllowance.total, 164);
});

test('breakdown components always sum to the subtotal', () => {
  const fare = priceRoute({
    rule: rule({
      taxPercent: 5,
      platformFee: 10,
      perMinuteRate: 1,
      additionalCharges: [{ label: 'Extra', amount: 15 }],
      surgeMultiplier: 1.2,
      nightSurcharge: { enabled: true, startHour: 0, endHour: 23, multiplier: 1.1 },
    }),
    distanceKm: 14,
    durationMinutes: 30,
    waitingMinutes: 10,
    at: noon,
  });

  const components =
    fare.baseFare +
    fare.distanceFare +
    fare.timeFare +
    fare.nightSurcharge +
    fare.waitingCharge +
    fare.platformFee +
    fare.additionalCharges.reduce((sum, charge) => sum + charge.amount, 0);

  // The surge applies to the ride charges, so account for it before comparing.
  const rideCharges = fare.baseFare + fare.distanceFare + fare.timeFare;
  const surgeUplift = rideCharges * (fare.surgeMultiplier - 1);

  assert.ok(
    Math.abs(components + surgeUplift - fare.subtotal) < 0.02,
    `components ${components} + surge ${surgeUplift} should equal subtotal ${fare.subtotal}`
  );
});

test('total equals subtotal plus tax, rounded to a whole unit', () => {
  const fare = priceRoute({
    rule: rule({ taxPercent: 18 }),
    distanceKm: 7.3,
    durationMinutes: 19,
    at: noon,
  });

  assert.equal(fare.total, Math.round(fare.subtotal + fare.taxAmount));
  assert.equal(fare.total, Math.round(fare.total), 'fares are charged in whole units');
});

test('fares are monotonic in distance', () => {
  const shorter = priceRoute({ rule: rule(), distanceKm: 5, durationMinutes: 15, at: noon });
  const longer = priceRoute({ rule: rule(), distanceKm: 15, durationMinutes: 35, at: noon });

  assert.ok(longer.total > shorter.total);
});

test.describe('night surcharge', () => {
  const nightRule = rule({
    nightSurcharge: { enabled: true, startHour: 23, endHour: 5, multiplier: 1.25 },
  });

  test('applies inside a window that wraps midnight', () => {
    const lateNight = priceRoute({
      rule: nightRule,
      distanceKm: 12,
      durationMinutes: 25,
      at: new Date('2026-03-14T23:30:00'),
    });
    const earlyMorning = priceRoute({
      rule: nightRule,
      distanceKm: 12,
      durationMinutes: 25,
      at: new Date('2026-03-14T02:00:00'),
    });

    // 150 * 1.25 = 187.5 -> 188.
    assert.equal(lateNight.total, 188);
    assert.equal(earlyMorning.total, 188);
    assert.ok(lateNight.nightSurcharge > 0);
  });

  test('does not apply during the day', () => {
    const daytime = priceRoute({
      rule: nightRule,
      distanceKm: 12,
      durationMinutes: 25,
      at: noon,
    });

    assert.equal(daytime.nightSurcharge, 0);
    assert.equal(daytime.total, 150);
  });

  test('is ignored when disabled, whatever the hour', () => {
    const fare = priceRoute({
      rule: rule(),
      distanceKm: 12,
      durationMinutes: 25,
      at: new Date('2026-03-14T23:30:00'),
    });

    assert.equal(fare.nightSurcharge, 0);
  });

  test('handles a non-wrapping window', () => {
    const windowRule = rule({
      nightSurcharge: { enabled: true, startHour: 1, endHour: 5, multiplier: 2 },
    });

    assert.equal(isNightTime(windowRule.nightSurcharge, new Date('2026-03-14T03:00:00')), true);
    assert.equal(isNightTime(windowRule.nightSurcharge, new Date('2026-03-14T06:00:00')), false);
    assert.equal(isNightTime(windowRule.nightSurcharge, new Date('2026-03-14T00:30:00')), false);
  });

  test('treats the end hour as exclusive', () => {
    const nightWindow = { enabled: true, startHour: 23, endHour: 5, multiplier: 1.25 };

    assert.equal(isNightTime(nightWindow, new Date('2026-03-14T04:59:00')), true);
    assert.equal(isNightTime(nightWindow, new Date('2026-03-14T05:00:00')), false);
    assert.equal(isNightTime(nightWindow, new Date('2026-03-14T23:00:00')), true);
  });

  test('a zero-width window never applies', () => {
    const nightWindow = { enabled: true, startHour: 5, endHour: 5, multiplier: 2 };
    assert.equal(isNightTime(nightWindow, new Date('2026-03-14T05:00:00')), false);
  });
});
