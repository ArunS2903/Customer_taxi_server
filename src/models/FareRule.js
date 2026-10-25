'use strict';

const mongoose = require('mongoose');

/**
 * Administrator-configured pricing for one vehicle category.
 *
 * Kept in its own collection (rather than embedded in VehicleType) so the admin
 * app can schedule a new price list with `effectiveFrom` without destroying the
 * one that priced earlier bookings. The fare service always picks the newest
 * active rule whose `effectiveFrom` is already in the past.
 */
const nightSurchargeSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    // Inclusive start hour, exclusive end hour, server local time, 0-23.
    // A window that wraps midnight (23 through 5) is supported.
    startHour: { type: Number, min: 0, max: 23, default: 23 },
    endHour: { type: Number, min: 0, max: 23, default: 5 },
    multiplier: { type: Number, min: 1, max: 5, default: 1.25 },
  },
  { _id: false }
);

const additionalChargeSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 60 },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const fareRuleSchema = new mongoose.Schema(
  {
    vehicleTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VehicleType',
      required: true,
      index: true,
    },

    currency: { type: String, required: true, default: 'INR', uppercase: true, maxlength: 3 },
    currencySymbol: { type: String, default: '₹', maxlength: 4 },

    // What the meter starts at, and how much distance that already buys.
    baseFare: { type: Number, required: true, min: 0 },
    baseDistanceKm: { type: Number, required: true, min: 0, default: 2 },

    perKmRate: { type: Number, required: true, min: 0 },
    perMinuteRate: { type: Number, min: 0, default: 0 },

    minimumFare: { type: Number, min: 0, default: 0 },

    waitingChargePerMinute: { type: Number, min: 0, default: 0 },
    freeWaitingMinutes: { type: Number, min: 0, default: 5 },

    // Flat additions, for example a booking fee or an airport levy.
    platformFee: { type: Number, min: 0, default: 0 },
    additionalCharges: { type: [additionalChargeSchema], default: [] },

    nightSurcharge: { type: nightSurchargeSchema, default: () => ({}) },

    // Demand multiplier the admin can raise during peak hours.
    surgeMultiplier: { type: Number, min: 1, max: 5, default: 1 },

    taxPercent: { type: Number, min: 0, max: 100, default: 5 },

    // Cancellation policy, surfaced to the customer before they confirm.
    cancellationFee: { type: Number, min: 0, default: 0 },
    freeCancellationMinutes: { type: Number, min: 0, default: 2 },

    effectiveFrom: { type: Date, required: true, default: Date.now, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

fareRuleSchema.index({ vehicleTypeId: 1, isActive: 1, effectiveFrom: -1 });

module.exports = mongoose.model('FareRule', fareRuleSchema);
