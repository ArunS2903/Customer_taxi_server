'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/ApiResponse');
const fareService = require('../services/fare.service');

/**
 * POST /fares/estimate
 *
 * With `vehicleTypeId`: prices that one category.
 * Without it: prices every active category on the same measured route, which is
 * what the vehicle selection screen renders in one call.
 *
 * Every figure here is an *estimate*. The response says so explicitly in
 * `isEstimate` and `disclaimer`, and the client labels the fare accordingly
 * until `finalFare` arrives on the booking. The route is measured server-side;
 * a distance sent by the client is ignored.
 */
const estimate = asyncHandler(async (req, res) => {
  const { vehicleTypeId, pickup, destination } = req.body;
  const at = new Date();

  if (!vehicleTypeId) {
    const result = await fareService.estimateForAllVehicleTypes({ pickup, destination, at });

    return ok(res, {
      route: result.route,
      estimates: result.estimates,
      isEstimate: true,
      disclaimer:
        'Fares are estimates based on the planned route. The final fare may differ if the route, waiting time or tolls change.',
      quotedAt: at,
    });
  }

  const quote = await fareService.estimateForVehicleType({
    vehicleTypeId,
    pickup,
    destination,
    at,
  });

  return ok(res, {
    route: {
      distanceKm: quote.route.distanceKm,
      durationMinutes: quote.route.durationMinutes,
      polyline: quote.route.polyline,
      source: quote.route.source,
      isApproximate: quote.route.source !== 'google',
    },
    vehicleType: quote.vehicleType.toPublicJSON(),
    fare: {
      total: quote.breakdown.total,
      currency: quote.breakdown.currency,
      currencySymbol: quote.breakdown.currencySymbol,
      breakdown: quote.breakdown,
    },
    cancellationPolicy: quote.cancellationPolicy,
    isEstimate: true,
    disclaimer:
      'This is an estimate based on the planned route. The final fare may differ if the route, waiting time or tolls change.',
    quotedAt: at,
  });
});

module.exports = { estimate };
