'use strict';

const mongoose = require('mongoose');
const { OTP_PURPOSE_VALUES, OTP_CHANNEL } = require('../constants/domain');

/**
 * One-time codes. Only a SHA-256 digest of the code is stored, and the document
 * is removed automatically by a TTL index once `expiresAt` passes.
 */
const otpSchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      enum: Object.values(OTP_CHANNEL),
      required: true,
    },
    // E.164 phone or lowercase email, depending on `channel`.
    destination: { type: String, required: true, trim: true, lowercase: true },
    purpose: { type: String, enum: OTP_PURPOSE_VALUES, required: true },

    codeHash: { type: String, required: true },

    expiresAt: { type: Date, required: true },
    resendAfter: { type: Date, required: true },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },

    consumedAt: { type: Date, default: null },

    // Short-lived handle the client echoes back on verify, so a verified OTP can
    // authorise exactly one follow-up action (register / reset password).
    verificationToken: { type: String, default: null, select: false },
    verificationTokenExpiresAt: { type: Date, default: null },

    requestIp: { type: String, trim: true },
    userAgent: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// Mongo removes the document ~60s after expiresAt. We still check expiry in
// code, because the reaper is not instantaneous.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ destination: 1, purpose: 1, createdAt: -1 });

otpSchema.methods.isExpired = function isExpired() {
  return this.expiresAt.getTime() <= Date.now();
};

otpSchema.methods.isUsable = function isUsable() {
  return !this.consumedAt && !this.isExpired() && this.attempts < this.maxAttempts;
};

module.exports = mongoose.model('Otp', otpSchema);
