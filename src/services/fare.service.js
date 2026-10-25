'use strict';

const VehicleType = require('../models/VehicleType');
const FareRule = require('../models/FareRule');
const ApiError = require('../utils/ApiError');
const geoService = require('./geo.service');

/**
 * Authoritative fare computation.
 *
 * The client sends only the route and the chosen category; every number below
 * comes from the admin-configured FareRule and is recomputed here on booking
 * creation. A fare quoted to the client is never trusted on the way back in.
 */

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Fares are charged in whole currency units. */
function roundFare(value) {
  return Math.round(value);
}

/**
 * True when `at` falls inside the configured night window. Handles a window
 * that wraps midnight (startHour 23, endHour 5) as well as one that does not.
 */
function isNightTime(nightSurcharge, at) {
  if (!nightSurcharge?.enabled) return false;

  const hour = at.getHours();
  const { startHour, endHour } = nightSurcharge;

  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/** Newest active rule whose effectiveFrom has already passed. */
async function resolveFareRule(vehicleTypeId, at = new Date()) {
  const rule = await FareRule.findOne({
    vehicleTypeId,
    isActive: true,
    effectiveFrom: { $lte: at },
  }).sort({ effectiveFrom: -1 });

  if (!rule) {
    throw ApiError.badRequest(
      'Pricing is not configured for this vehicle category yet. Please choose another or contact support.',
      'FARE_RULE_MISSING'
    );
  }

  return rule;
}

/**
 * Prices one route for one rule. Pure arithmetic - no I/O - so it is cheap to
 * call once per category when building the vehicle list.
 *
 * Order of operations matters and is deliberate:
 *   1. base fare covers the first `baseDistanceKm`
 *   2. distance beyond that is charged per km, plus any per-minute time charge
 *   3. the running subtotal is lifted to `minimumFare` if it fell short
 *   4. night surcharge and surge multiply the ride charges
 *   5. flat fees (platform, extras, waiting) are added after multipliers, so a
 *      surge does not inflate a fixed booking fee
 *   6. tax applies to everything
 */
function priceRoute({ rule, distanceKm, durationMinutes, waitingMinutes = 0, at = new Date() }) {
  const baseFare = rule.baseFare;
  const chargeableKm = Math.max(0, distanceKm - rule.baseDistanceKm);
  const distanceFare = chargeableKm * rule.perKmRate;
  const timeFare = (rule.perMinuteRate || 0) * durationMinutes;

  let rideCharges = baseFare + distanceFare + timeFare;

  const minimumFareApplied = rideCharges < (rule.minimumFare || 0);
  if (minimumFareApplied) {
    rideCharges = rule.minimumFare;
  }

  const nightApplies = isNightTime(rule.nightSurcharge, at);
  const nightMultiplier = nightApplies ? rule.nightSurcharge.multiplier : 1;
  const surgeMultiplier = rule.surgeMultiplier || 1;

  const multipliedRideCharges = rideCharges * nightMultiplier * surgeMultiplier;
  const nightSurchargeAmount = nightApplies
    ? round2(rideCharges * surgeMultiplier * (nightMultiplier - 1))
    : 0;

  const billableWaitingMinutes = Math.max(0, waitingMinutes - (rule.freeWaitingMinutes || 0));
  const waitingCharge = billableWaitingMinutes * (rule.waitingChargePerMinute || 0);

  const extras = (rule.additionalCharges || []).map((c) => ({
    label: c.label,
    amount: round2(c.amount),
  }));
  const extrasTotal = extras.reduce((sum, c) => sum + c.amount, 0);

  const subtotal = multipliedRideCharges + waitingCharge + (rule.platformFee || 0) + extrasTotal;
  const taxAmount = subtotal * ((rule.taxPercent || 0) / 100);
  const total = subtotal + taxAmount;

  return {
    currency: rule.currency,
    currencySymbol: rule.currencySymbol,

    baseFare: round2(baseFare),
    baseDistanceKm: rule.baseDistanceKm,
    distanceFare: round2(distanceFare),
    timeFare: round2(timeFare),

    waitingCharge: round2(waitingCharge),
    nightSurcharge: nightSurchargeAmount,
    surgeMultiplier,

    platformFee: round2(rule.platformFee || 0),
    additionalCharges: extras,

    minimumFareApplied,
    subtotal: round2(subtotal),
    taxPercent: rule.taxPercent || 0,
    taxAmount: round2(taxAmount),
    total: roundFare(total),

    fareRuleId: rule._id,
  };
}

/**
 * Estimates for every active category on one route - what the vehicle selection
 * screen renders. The route is measured once and reused across categories.
 */
async function estimateForAllVehicleTypes({ pickup, destination, at = new Date() }) {
  const route = await geoService.measureRoute(pickup, destination);

  const vehicleTypes = await VehicleType.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });

  if (!vehicleTypes.length) {
    throw ApiError.badRequest(
      'No vehicle categories are available right now. Please try again later.',
      'NO_VEHICLE_TYPES'
    );
  }

  const rules = await FareRule.find({
    vehicleTypeId: { $in: vehicleTypes.map((v) => v._id) },
    isActive: true,
    effectiveFrom: { $lte: at },
  }).sort({ effectiveFrom: -1 });

  // First rule per vehicle wins, because the query is sorted newest-first.
  const ruleByVehicle = new Map();
  for (const rule of rules) {
    const key = rule.vehicleTypeId.toString();
    if (!ruleByVehicle.has(key)) ruleByVehicle.set(key, rule);
  }

  const estimates = vehicleTypes.map((vehicle) => {
    const rule = ruleByVehicle.get(vehicle._id.toString());

    // A category with no price list is listed but not bookable, rather than
    // hidden - otherwise the customer just sees an unexplained gap.
    if (!rule) {
      return {
        ...vehicle.toPublicJSON(),
        isAvailable: false,
        unavailableReason: 'Pricing not configured',
        etaMinutes: null,
        fare: null,
      };
    }

    const breakdown = priceRoute({
      rule,
      distanceKm: route.distanceKm,
      durationMinutes: route.durationMinutes,
      at,
    });

    return {
      ...vehicle.toPublicJSON(),
      isAvailable: true,
      unavailableReason: null,
      etaMinutes: vehicle.defaultEtaMinutes,
      fare: {
        total: breakdown.total,
        currency: breakdown.currency,
        currencySymbol: breakdown.currencySymbol,
        breakdown,
      },
      cancellationPolicy: {
        fee: rule.cancellationFee || 0,
        freeCancellationMinutes: rule.freeCancellationMinutes || 0,
      },
    };
  });

  return {
    route: {
      distanceKm: route.distanceKm,
      durationMinutes: route.durationMinutes,
      polyline: route.polyline,
      source: route.source,
      // The client shows a "prices are approximate" note when this is true.
      isApproximate: route.source !== 'google',
    },
    estimates,
  };
}

/**
 * Single-category estimate, used by POST /fares/estimate and again inside
 * booking creation so the stored fare is computed the same way.
 */
async function estimateForVehicleType({ vehicleTypeId, pickup, destination, at = new Date(), route }) {
  const vehicleType = await VehicleType.findById(vehicleTypeId);

  if (!vehicleType) {
    throw ApiError.notFound('That vehicle category does not exist.', 'VEHICLE_TYPE_NOT_FOUND');
  }
  if (!vehicleType.isActive) {
    throw ApiError.badRequest(
      'That vehicle category is no longer available. Please choose another.',
      'VEHICLE_TYPE_INACTIVE'
    );
  }

  const measuredRoute = route || (await geoService.measureRoute(pickup, destination));
  const rule = await resolveFareRule(vehicleType._id, at);

  const breakdown = priceRoute({
    rule,
    distanceKm: measuredRoute.distanceKm,
    durationMinutes: measuredRoute.durationMinutes,
    at,
  });

  return {
    vehicleType,
    rule,
    route: measuredRoute,
    breakdown,
    cancellationPolicy: {
      fee: rule.cancellationFee || 0,
      freeCancellationMinutes: rule.freeCancellationMinutes || 0,
    },
  };
}

module.exports = {
  resolveFareRule,
  priceRoute,
  isNightTime,
  estimateForAllVehicleTypes,
  estimateForVehicleType,
};
