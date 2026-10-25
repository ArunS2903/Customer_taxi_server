'use strict';

const mongoose = require('mongoose');
const { NOTIFICATION_TYPE } = require('../constants/domain');

/**
 * Persisted copy of every notification we try to deliver. Push delivery through
 * FCM is best-effort and may be disabled entirely; this collection is what the
 * in-app notification history reads, so the customer never loses a message
 * because a token had expired.
 */
const notificationSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(NOTIFICATION_TYPE),
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, trim: true, maxlength: 500 },

    // Free-form payload the app uses for deep linking, e.g. { bookingId }.
    data: { type: mongoose.Schema.Types.Mixed, default: {} },

    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
      index: true,
    },

    readAt: { type: Date, default: null },
    pushSentAt: { type: Date, default: null },
    pushError: { type: String, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ customerId: 1, createdAt: -1 });
notificationSchema.index({ customerId: 1, readAt: 1 });

notificationSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    type: this.type,
    title: this.title,
    body: this.body,
    data: this.data || {},
    bookingId: this.bookingId ? this.bookingId.toString() : null,
    isRead: Boolean(this.readAt),
    readAt: this.readAt,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('Notification', notificationSchema);
