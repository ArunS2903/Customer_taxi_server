'use strict';

const mongoose = require('mongoose');

/**
 * Refresh tokens are opaque random strings; only their hash lives here, so a
 * database leak does not hand out sessions. Rotation is one-use: refreshing
 * revokes the presented token and records which token replaced it, which makes
 * replay of an old token detectable.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
    userAgent: { type: String, trim: true, maxlength: 300 },
    ip: { type: String, trim: true },
  },
  { timestamps: true }
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

refreshTokenSchema.methods.isActive = function isActive() {
  return !this.revokedAt && this.expiresAt.getTime() > Date.now();
};

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
