'use strict';

const VehicleType = require('../models/VehicleType');
const FareRule = require('../models/FareRule');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/ApiResponse');

/**
 * GET /vehicles/types
 *
 * The catalogue, without prices for any specific route. Each entry carries the
 * *rate card* (per-km rate, base fare, minimum fare) so the client can show
 * "from X per km" on a browse screen, but never a trip total - a trip total
 * only exists once a route does, and comes from POST /fares/estimate.
 *
 * The app holds no prices of its own; everything below is admin-configured.
 */
const listVehicleTypes = asyncHandler(async (req, res) => {
  const vehicleTypes = await VehicleType.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });

  const now = new Date();
  const rules = await FareRule.find({
    vehicleTypeId: { $in: vehicleTypes.map((v) => v._id) },
    isActive: true,
    effectiveFrom: { $lte: now },
  }).sort({ effectiveFrom: -1 });

  // Newest-first sort means the first rule seen per vehicle is the current one.
  const ruleByVehicle = new Map();
  for (const rule of rules) {
    const key = rule.vehicleTypeId.toString();
    if (!ruleByVehicle.has(key)) ruleByVehicle.set(key, rule);
  }

  const items = vehicleTypes.map((vehicle) => {
    const rule = ruleByVehicle.get(vehicle._id.toString());

    return {
      ...vehicle.toPublicJSON(),
      // Listed but not bookable when the admin has not priced it yet.
      isBookable: Boolean(rule),
      rateCard: rule
        ? {
            currency: rule.currency,
            currencySymbol: rule.currencySymbol,
            baseFare: rule.baseFare,
            baseDistanceKm: rule.baseDistanceKm,
            perKmRate: rule.perKmRate,
            perMinuteRate: rule.perMinuteRate,
            minimumFare: rule.minimumFare,
            waitingChargePerMinute: rule.waitingChargePerMinute,
            freeWaitingMinutes: rule.freeWaitingMinutes,
            taxPercent: rule.taxPercent,
            surgeMultiplier: rule.surgeMultiplier,
            cancellationFee: rule.cancellationFee,
            freeCancellationMinutes: rule.freeCancellationMinutes,
          }
        : null,
    };
  });

  return ok(res, { items, total: items.length });
});

module.exports = { listVehicleTypes };
