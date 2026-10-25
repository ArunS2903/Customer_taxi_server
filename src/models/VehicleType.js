'use strict';

const mongoose = require('mongoose');

/**
 * A bookable vehicle category (Mini / Sedan / SUV / Premium / ...).
 * Owned by the Admin Web Application; the mobile app only reads it.
 */
const vehicleTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
      maxlength: 30,
    },
    description: { type: String, trim: true, maxlength: 300 },

    // Absolute URL to a category illustration. The client falls back to a
    // built-in icon keyed by `code` when this is empty.
    imageUrl: { type: String, trim: true },
    iconName: { type: String, trim: true, maxlength: 40 },

    passengerCapacity: { type: Number, required: true, min: 1, max: 20 },
    luggageCapacity: { type: Number, min: 0, max: 20, default: 2 },

    // Admin toggle. A category can also be unavailable because no driver is in
    // range; that is reported separately per-estimate as `isAvailable`.
    isActive: { type: Boolean, default: true, index: true },

    // Typical minutes until pickup, shown as "5 min away" when there is no
    // live driver supply feed to query.
    defaultEtaMinutes: { type: Number, min: 0, max: 240, default: 5 },

    sortOrder: { type: Number, default: 100 },
  },
  { timestamps: true }
);

vehicleTypeSchema.index({ isActive: 1, sortOrder: 1 });

vehicleTypeSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    code: this.code,
    description: this.description || null,
    imageUrl: this.imageUrl || null,
    iconName: this.iconName || null,
    passengerCapacity: this.passengerCapacity,
    luggageCapacity: this.luggageCapacity,
    defaultEtaMinutes: this.defaultEtaMinutes,
    sortOrder: this.sortOrder,
  };
};

module.exports = mongoose.model('VehicleType', vehicleTypeSchema);
