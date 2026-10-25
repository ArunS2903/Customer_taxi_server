'use strict';

const mongoose = require('mongoose');
const {
  BOOKING_STATUS,
  BOOKING_STATUS_VALUES,
  PAYMENT_METHOD_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  TERMINAL_STATUSES,
} = require('../constants/domain');

const placeSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, trim: true, maxlength: 500 },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    placeId: { type: String, trim: true },
  },
  { _id: false }
);

/**
 * The priced fare, itemised. Stored as computed by the server so the booking
 * can always explain its own number, even after the admin edits the price list.
 */
const fareBreakdownSchema = new mongoose.Schema(
  {
    currency: { type: String, default: 'INR' },
    currencySymbol: { type: String, default: '₹' },
    baseFare: { type: Number, default: 0 },
    baseDistanceKm: { type: Number, default: 0 },
    distanceFare: { type: Number, default: 0 },
    timeFare: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    additionalCharges: {
      type: [
        new mongoose.Schema(
          {
            label: { type: String, required: true },
            amount: { type: Number, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    waitingCharge: { type: Number, default: 0 },
    nightSurcharge: { type: Number, default: 0 },
    surgeMultiplier: { type: Number, default: 1 },
    subtotal: { type: Number, default: 0 },
    minimumFareApplied: { type: Boolean, default: false },
    taxPercent: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    // Which FareRule produced these numbers, for admin-side auditing.
    fareRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'FareRule' },
  },
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: BOOKING_STATUS_VALUES, required: true },
    at: { type: Date, required: true, default: Date.now },
    // 'customer' | 'admin' | 'driver' | 'system'
    byRole: { type: String, default: 'system' },
    byId: { type: String, default: null },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false }
);

/**
 * Driver details are written by the admin app or the driver-management system,
 * never by the customer app. The customer app reads them to show "your driver".
 */
const driverSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    photoUrl: { type: String, trim: true },
    rating: { type: Number, min: 0, max: 5 },
    vehicleNumber: { type: String, trim: true },
    vehicleModel: { type: String, trim: true },
    assignedAt: { type: Date },
  },
  { _id: false }
);

const businessContactSnapshotSchema = new mongoose.Schema(
  {
    businessName: { type: String, trim: true },
    adminContactName: { type: String, trim: true },
    adminPhone: { type: String, trim: true },
    adminEmail: { type: String, trim: true },
    supportPhone: { type: String, trim: true },
    supportEmail: { type: String, trim: true },
    capturedAt: { type: Date },
  },
  { _id: false }
);

const cancellationSchema = new mongoose.Schema(
  {
    reason: { type: String, trim: true, maxlength: 200 },
    remarks: { type: String, trim: true, maxlength: 500 },
    // 'customer' | 'admin' | 'driver' | 'system'
    cancelledByRole: { type: String, trim: true },
    cancelledById: { type: String, trim: true },
    cancelledAt: { type: Date },
    fee: { type: Number, default: 0, min: 0 },
    feeWaived: { type: Boolean, default: false },
  },
  { _id: false }
);

const bookingSchema = new mongoose.Schema(
  {
    // Human-readable reference shown to the customer, e.g. TX-000001.
    bookingCode: { type: String, required: true, unique: true, trim: true },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },

    // Denormalised contact details, captured at booking time. The admin app
    // reads these to reach the customer without a second lookup, and they stay
    // correct even if the customer later edits their profile.
    customerName: { type: String, required: true, trim: true },
    customerPhone: { type: String, trim: true },
    customerEmail: { type: String, trim: true, lowercase: true },

    vehicleTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VehicleType',
      required: true,
      index: true,
    },
    vehicleTypeName: { type: String, required: true, trim: true },
    vehicleTypeCode: { type: String, trim: true, uppercase: true },

    pickup: { type: placeSchema, required: true },
    destination: { type: placeSchema, required: true },

    distanceKm: { type: Number, required: true, min: 0 },
    durationMinutes: { type: Number, required: true, min: 0 },
    // Encoded Google polyline for redrawing the route on the details screen.
    routePolyline: { type: String, default: null },
    // 'google' when priced off Distance Matrix, 'haversine' for the dev fallback.
    distanceSource: { type: String, default: 'haversine' },

    estimatedFare: { type: Number, required: true, min: 0 },
    finalFare: { type: Number, default: null, min: 0 },
    fareBreakdown: { type: fareBreakdownSchema, default: () => ({}) },

    bookingStatus: {
      type: String,
      enum: BOOKING_STATUS_VALUES,
      default: BOOKING_STATUS.PENDING,
      required: true,
      index: true,
    },
    statusHistory: { type: [statusHistorySchema], default: [] },

    paymentMethod: { type: String, enum: PAYMENT_METHOD_VALUES, required: true },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUS_VALUES,
      default: PAYMENT_STATUS.PENDING,
      index: true,
    },

    // Null for "ride now"; a future timestamp for a scheduled pickup.
    scheduledAt: { type: Date, default: null },
    specialInstructions: { type: String, trim: true, maxlength: 500 },

    driver: { type: driverSchema, default: null },
    businessContactSnapshot: { type: businessContactSnapshotSchema, default: null },
    cancellation: { type: cancellationSchema, default: null },

    /**
     * Client-supplied key that makes POST /bookings idempotent. A repeated tap
     * or a Dio retry re-sends the same key and gets the original booking back
     * instead of creating a second one. Unique + sparse so bookings written by
     * other systems (admin, phone orders) need not carry one.
     */
    idempotencyKey: { type: String, default: undefined, trim: true },

    completedAt: { type: Date, default: null },
    source: { type: String, default: 'customer_app' },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

bookingSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
// Drives My Bookings: newest first, filtered by customer and status.
bookingSchema.index({ customerId: 1, createdAt: -1 });
bookingSchema.index({ customerId: 1, bookingStatus: 1, createdAt: -1 });
// Drives the admin queue.
bookingSchema.index({ bookingStatus: 1, createdAt: -1 });

bookingSchema.virtual('isTerminal').get(function isTerminal() {
  return TERMINAL_STATUSES.includes(this.bookingStatus);
});

/** The number to display: the final fare once known, otherwise the estimate. */
bookingSchema.virtual('displayFare').get(function displayFare() {
  return this.finalFare == null ? this.estimatedFare : this.finalFare;
});

/** Appends to statusHistory and moves bookingStatus in one place. */
bookingSchema.methods.applyStatus = function applyStatus(status, { byRole = 'system', byId = null, note } = {}) {
  this.bookingStatus = status;
  this.statusHistory.push({ status, at: new Date(), byRole, byId, note });
  if (status === BOOKING_STATUS.COMPLETED) {
    this.completedAt = new Date();
  }
  return this;
};

bookingSchema.methods.toPublicJSON = function toPublicJSON() {
  const breakdown = this.fareBreakdown || {};
  return {
    id: this._id.toString(),
    bookingCode: this.bookingCode,

    customer: {
      id: this.customerId?.toString?.() ?? String(this.customerId),
      name: this.customerName,
      phone: this.customerPhone || null,
      email: this.customerEmail || null,
    },

    vehicleType: {
      id: this.vehicleTypeId?.toString?.() ?? String(this.vehicleTypeId),
      name: this.vehicleTypeName,
      code: this.vehicleTypeCode || null,
    },

    pickup: {
      address: this.pickup.address,
      latitude: this.pickup.latitude,
      longitude: this.pickup.longitude,
      placeId: this.pickup.placeId || null,
    },
    destination: {
      address: this.destination.address,
      latitude: this.destination.latitude,
      longitude: this.destination.longitude,
      placeId: this.destination.placeId || null,
    },

    distanceKm: this.distanceKm,
    durationMinutes: this.durationMinutes,
    routePolyline: this.routePolyline || null,

    estimatedFare: this.estimatedFare,
    finalFare: this.finalFare,
    displayFare: this.displayFare,
    fareBreakdown: {
      currency: breakdown.currency || 'INR',
      currencySymbol: breakdown.currencySymbol || '₹',
      baseFare: breakdown.baseFare || 0,
      distanceFare: breakdown.distanceFare || 0,
      timeFare: breakdown.timeFare || 0,
      waitingCharge: breakdown.waitingCharge || 0,
      nightSurcharge: breakdown.nightSurcharge || 0,
      platformFee: breakdown.platformFee || 0,
      additionalCharges: (breakdown.additionalCharges || []).map((c) => ({
        label: c.label,
        amount: c.amount,
      })),
      surgeMultiplier: breakdown.surgeMultiplier || 1,
      subtotal: breakdown.subtotal || 0,
      minimumFareApplied: Boolean(breakdown.minimumFareApplied),
      taxPercent: breakdown.taxPercent || 0,
      taxAmount: breakdown.taxAmount || 0,
      total: breakdown.total || 0,
    },

    bookingStatus: this.bookingStatus,
    paymentMethod: this.paymentMethod,
    paymentStatus: this.paymentStatus,

    scheduledAt: this.scheduledAt,
    specialInstructions: this.specialInstructions || null,

    driver: this.driver
      ? {
          name: this.driver.name || null,
          phone: this.driver.phone || null,
          photoUrl: this.driver.photoUrl || null,
          rating: this.driver.rating ?? null,
          vehicleNumber: this.driver.vehicleNumber || null,
          vehicleModel: this.driver.vehicleModel || null,
          assignedAt: this.driver.assignedAt || null,
        }
      : null,

    businessContact: this.businessContactSnapshot
      ? {
          businessName: this.businessContactSnapshot.businessName || null,
          adminContactName: this.businessContactSnapshot.adminContactName || null,
          adminPhone: this.businessContactSnapshot.adminPhone || null,
          adminEmail: this.businessContactSnapshot.adminEmail || null,
          supportPhone: this.businessContactSnapshot.supportPhone || null,
          supportEmail: this.businessContactSnapshot.supportEmail || null,
        }
      : null,

    cancellation: this.cancellation
      ? {
          reason: this.cancellation.reason || null,
          remarks: this.cancellation.remarks || null,
          cancelledByRole: this.cancellation.cancelledByRole || null,
          cancelledAt: this.cancellation.cancelledAt || null,
          fee: this.cancellation.fee || 0,
          feeWaived: Boolean(this.cancellation.feeWaived),
        }
      : null,

    statusHistory: (this.statusHistory || []).map((h) => ({
      status: h.status,
      at: h.at,
      note: h.note || null,
    })),

    isTerminal: this.isTerminal,
    completedAt: this.completedAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

/** Compact shape for the My Bookings list; avoids shipping history and breakdown. */
bookingSchema.methods.toListJSON = function toListJSON() {
  return {
    id: this._id.toString(),
    bookingCode: this.bookingCode,
    pickupAddress: this.pickup.address,
    destinationAddress: this.destination.address,
    vehicleTypeName: this.vehicleTypeName,
    vehicleTypeCode: this.vehicleTypeCode || null,
    distanceKm: this.distanceKm,
    estimatedFare: this.estimatedFare,
    finalFare: this.finalFare,
    displayFare: this.displayFare,
    currencySymbol: this.fareBreakdown?.currencySymbol || '₹',
    bookingStatus: this.bookingStatus,
    paymentStatus: this.paymentStatus,
    paymentMethod: this.paymentMethod,
    scheduledAt: this.scheduledAt,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('Booking', bookingSchema);
