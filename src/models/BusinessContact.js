'use strict';

const mongoose = require('mongoose');

/**
 * The official, customer-facing contact details of the business running the
 * service. Maintained by the Admin Web Application.
 *
 * Only one document is active at a time (`isActive: true`). Nothing private
 * belongs in here - no admin logins, no internal-only numbers - because every
 * field is served unauthenticated by GET /public/business-contact.
 */
const businessContactSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true, maxlength: 120 },

    // Optional named contact, such as "Customer Support" or a person name.
    adminContactName: { type: String, trim: true, maxlength: 120 },

    adminPhone: { type: String, trim: true, maxlength: 20 },
    adminEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },

    supportPhone: { type: String, trim: true, maxlength: 20 },
    supportEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
    whatsappNumber: { type: String, trim: true, maxlength: 20 },

    addressLine: { type: String, trim: true, maxlength: 300 },
    city: { type: String, trim: true, maxlength: 80 },
    state: { type: String, trim: true, maxlength: 80 },
    postalCode: { type: String, trim: true, maxlength: 20 },
    country: { type: String, trim: true, maxlength: 80 },

    websiteUrl: { type: String, trim: true, maxlength: 300 },
    termsUrl: { type: String, trim: true, maxlength: 300 },
    privacyUrl: { type: String, trim: true, maxlength: 300 },

    workingHours: { type: String, trim: true, maxlength: 120 },
    supportHours: { type: String, trim: true, maxlength: 120 },

    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

/** Full customer-facing payload for the support screen. */
businessContactSchema.methods.toPublicJSON = function toPublicJSON() {
  const address = [this.addressLine, this.city, this.state, this.postalCode, this.country]
    .filter(Boolean)
    .join(', ');

  return {
    businessName: this.businessName,
    adminContactName: this.adminContactName || null,
    adminPhone: this.adminPhone || null,
    adminEmail: this.adminEmail || null,
    supportPhone: this.supportPhone || this.adminPhone || null,
    supportEmail: this.supportEmail || this.adminEmail || null,
    whatsappNumber: this.whatsappNumber || null,
    address: address || null,
    websiteUrl: this.websiteUrl || null,
    termsUrl: this.termsUrl || null,
    privacyUrl: this.privacyUrl || null,
    workingHours: this.workingHours || null,
    supportHours: this.supportHours || null,
    updatedAt: this.updatedAt,
  };
};

/**
 * Trimmed copy embedded into each booking, so a booking from last year still
 * shows the number the customer was told to call at the time it was made.
 */
businessContactSchema.methods.toSnapshot = function toSnapshot() {
  return {
    businessName: this.businessName,
    adminContactName: this.adminContactName || null,
    adminPhone: this.adminPhone || null,
    adminEmail: this.adminEmail || null,
    supportPhone: this.supportPhone || this.adminPhone || null,
    supportEmail: this.supportEmail || this.adminEmail || null,
    capturedAt: new Date(),
  };
};

module.exports = mongoose.model('BusinessContact', businessContactSchema);
