'use strict';

const mongoose = require('mongoose');
const { CUSTOMER_STATUS, ADDRESS_LABEL } = require('../constants/domain');

const savedAddressSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
      default: ADDRESS_LABEL.OTHER,
    },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    placeId: { type: String, trim: true },
  },
  { timestamps: true }
);

const notificationPrefsSchema = new mongoose.Schema(
  {
    push: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    sms: { type: Boolean, default: true },
    promotions: { type: Boolean, default: false },
  },
  { _id: false }
);

const deviceSchema = new mongoose.Schema(
  {
    fcmToken: { type: String, required: true, trim: true },
    platform: { type: String, enum: ['android', 'ios', 'web'], default: 'android' },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },

    // Either phone or email must be present; enforced in the pre-validate hook.
    // `sparse` keeps the unique index from colliding on multiple nulls.
    phone: {
      type: String,
      trim: true,
      default: undefined,
      match: [/^\+[1-9]\d{7,14}$/, 'Phone must be stored in E.164 format.'],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: undefined,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Email address is not valid.'],
    },

    // `select: false` keeps the hash out of every ordinary query result.
    passwordHash: { type: String, select: false },

    phoneVerified: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },

    status: {
      type: String,
      enum: Object.values(CUSTOMER_STATUS),
      default: CUSTOMER_STATUS.ACTIVE,
      index: true,
    },

    savedAddresses: { type: [savedAddressSchema], default: [] },
    notificationPrefs: { type: notificationPrefsSchema, default: () => ({}) },
    devices: { type: [deviceSchema], default: [], select: false },

    // Bumped on password change / "log out everywhere" so that access tokens
    // issued before the change stop validating (see middleware/auth.js).
    tokenVersion: { type: Number, default: 0 },

    lastLoginAt: { type: Date },
    deletionRequestedAt: { type: Date },
    deletionReason: { type: String, trim: true, maxlength: 500 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

customerSchema.index({ phone: 1 }, { unique: true, sparse: true });
customerSchema.index({ email: 1 }, { unique: true, sparse: true });
customerSchema.index({ createdAt: -1 });

customerSchema.pre('validate', function requireOneIdentifier(next) {
  if (!this.phone && !this.email) {
    this.invalidate('phone', 'A customer needs either a mobile number or an email address.');
  }
  next();
});

/** Shape sent to the mobile client. Never includes passwordHash or devices. */
customerSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    fullName: this.fullName,
    phone: this.phone || null,
    email: this.email || null,
    phoneVerified: this.phoneVerified,
    emailVerified: this.emailVerified,
    status: this.status,
    savedAddresses: (this.savedAddresses || []).map((a) => ({
      id: a._id.toString(),
      label: a.label,
      address: a.address,
      latitude: a.latitude,
      longitude: a.longitude,
      placeId: a.placeId || null,
    })),
    notificationPrefs: {
      push: this.notificationPrefs?.push ?? true,
      email: this.notificationPrefs?.email ?? true,
      sms: this.notificationPrefs?.sms ?? true,
      promotions: this.notificationPrefs?.promotions ?? false,
    },
    hasPassword: Boolean(this.passwordHash),
    deletionRequestedAt: this.deletionRequestedAt || null,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('Customer', customerSchema);
