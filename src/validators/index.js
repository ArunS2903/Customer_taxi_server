'use strict';

const { z } = require('zod');
const {
  PAYMENT_METHOD_VALUES,
  OTP_PURPOSE_VALUES,
  CANCELLATION_REASONS,
  ADDRESS_LABEL,
} = require('../constants/domain');

/**
 * Request schemas. Every schema is `.strict()` by default via zod's object
 * stripping, so unknown keys are dropped rather than passed through to Mongoose.
 *
 * Phone numbers are accepted loosely here and normalised to E.164 by
 * utils/phone.js inside the controller, so that "9876543210",
 * "+91 98765 43210" and "098765 43210" all reach the same account.
 */

const phoneInput = z
  .string({ required_error: 'Mobile number is required.' })
  .trim()
  .min(7, 'Mobile number is too short.')
  .max(20, 'Mobile number is too long.');

const emailInput = z
  .string({ required_error: 'Email address is required.' })
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(160);

const passwordInput = z
  .string({ required_error: 'Password is required.' })
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be 128 characters or fewer.');

const fullNameInput = z
  .string({ required_error: 'Full name is required.' })
  .trim()
  .min(2, 'Enter your full name.')
  .max(80, 'Name must be 80 characters or fewer.')
  .regex(/^[\p{L}\p{M}\s.'-]+$/u, 'Name can only contain letters, spaces, apostrophes and hyphens.');

const otpCodeInput = z
  .string({ required_error: 'Enter the code we sent you.' })
  .trim()
  .regex(/^\d{4,8}$/, 'The code should be 4 to 8 digits.');

const latitude = z
  .number({ required_error: 'Latitude is required.', invalid_type_error: 'Latitude must be a number.' })
  .min(-90, 'Latitude is out of range.')
  .max(90, 'Latitude is out of range.');

const longitude = z
  .number({ required_error: 'Longitude is required.', invalid_type_error: 'Longitude must be a number.' })
  .min(-180, 'Longitude is out of range.')
  .max(180, 'Longitude is out of range.');

const objectId = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Not a valid id.');

const placeInput = z.object({
  address: z
    .string({ required_error: 'Address is required.' })
    .trim()
    .min(3, 'Address is too short.')
    .max(500, 'Address is too long.'),
  latitude,
  longitude,
  placeId: z.string().trim().max(200).optional(),
});

// --- Authentication ---------------------------------------------------------

/**
 * Registration accepts a phone, an email, or both, but needs at least one.
 * A password is always required so the customer can sign in without an OTP.
 */
const registerSchema = z
  .object({
    fullName: fullNameInput,
    phone: phoneInput.optional(),
    email: emailInput.optional(),
    password: passwordInput,
    confirmPassword: z.string().optional(),
    // Issued by POST /auth/verify-otp. Required when the deployment verifies
    // the identifier before allowing the account to be created.
    verificationToken: z.string().trim().max(200).optional(),
    fcmToken: z.string().trim().max(500).optional(),
    platform: z.enum(['android', 'ios', 'web']).optional(),
  })
  .refine((data) => data.phone || data.email, {
    message: 'Enter a mobile number or an email address.',
    path: ['phone'],
  })
  .refine((data) => !data.confirmPassword || data.confirmPassword === data.password, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

/** Login by phone+password, email+password, or phone+OTP. */
const loginSchema = z
  .object({
    phone: phoneInput.optional(),
    email: emailInput.optional(),
    password: z.string().max(128).optional(),
    otp: otpCodeInput.optional(),
    fcmToken: z.string().trim().max(500).optional(),
    platform: z.enum(['android', 'ios', 'web']).optional(),
  })
  .refine((data) => data.phone || data.email, {
    message: 'Enter your mobile number or email address.',
    path: ['phone'],
  })
  .refine((data) => data.password || data.otp, {
    message: 'Enter your password, or request a one-time code.',
    path: ['password'],
  })
  .refine((data) => !(data.otp && !data.phone), {
    message: 'One-time codes are sent to your mobile number.',
    path: ['phone'],
  });

const sendOtpSchema = z
  .object({
    phone: phoneInput.optional(),
    email: emailInput.optional(),
    purpose: z.enum(OTP_PURPOSE_VALUES, {
      errorMap: () => ({ message: `Purpose must be one of: ${OTP_PURPOSE_VALUES.join(', ')}.` }),
    }),
  })
  .refine((data) => data.phone || data.email, {
    message: 'Enter a mobile number or an email address.',
    path: ['phone'],
  });

const verifyOtpSchema = z
  .object({
    phone: phoneInput.optional(),
    email: emailInput.optional(),
    purpose: z.enum(OTP_PURPOSE_VALUES),
    otp: otpCodeInput,
    // Present when verifying an OTP that should also log the customer in.
    fcmToken: z.string().trim().max(500).optional(),
    platform: z.enum(['android', 'ios', 'web']).optional(),
  })
  .refine((data) => data.phone || data.email, {
    message: 'Enter a mobile number or an email address.',
    path: ['phone'],
  });

const refreshTokenSchema = z.object({
  refreshToken: z.string({ required_error: 'Refresh token is required.' }).trim().min(16),
});

const logoutSchema = z.object({
  refreshToken: z.string().trim().min(16).optional(),
  // Drops the FCM token so a signed-out device stops receiving pushes.
  fcmToken: z.string().trim().max(500).optional(),
  allDevices: z.boolean().optional(),
});

const forgotPasswordSchema = z
  .object({
    phone: phoneInput.optional(),
    email: emailInput.optional(),
  })
  .refine((data) => data.phone || data.email, {
    message: 'Enter your mobile number or email address.',
    path: ['phone'],
  });

const resetPasswordSchema = z
  .object({
    phone: phoneInput.optional(),
    email: emailInput.optional(),
    verificationToken: z
      .string({ required_error: 'Verify the code we sent you first.' })
      .trim()
      .min(16),
    password: passwordInput,
    confirmPassword: z.string().optional(),
  })
  .refine((data) => data.phone || data.email, {
    message: 'Enter your mobile number or email address.',
    path: ['phone'],
  })
  .refine((data) => !data.confirmPassword || data.confirmPassword === data.password, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

// --- Customer ---------------------------------------------------------------

const updateProfileSchema = z
  .object({
    fullName: fullNameInput.optional(),
    // Changing a verified identifier needs a fresh OTP verification token; the
    // controller enforces that, the schema only carries it.
    email: emailInput.optional(),
    phone: phoneInput.optional(),
    verificationToken: z.string().trim().max(200).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Nothing to update.' });

const changePasswordSchema = z
  .object({
    currentPassword: z.string().max(128).optional(),
    newPassword: passwordInput,
    confirmPassword: z.string().optional(),
  })
  .refine((data) => !data.confirmPassword || data.confirmPassword === data.newPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'Your new password must be different from the current one.',
    path: ['newPassword'],
  });

const savedAddressSchema = z.object({
  label: z
    .string()
    .trim()
    .max(40)
    .default(ADDRESS_LABEL.OTHER),
  address: z.string().trim().min(3, 'Address is too short.').max(300),
  latitude,
  longitude,
  placeId: z.string().trim().max(200).optional(),
});

const notificationPrefsSchema = z
  .object({
    push: z.boolean().optional(),
    email: z.boolean().optional(),
    sms: z.boolean().optional(),
    promotions: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Nothing to update.' });

const registerDeviceSchema = z.object({
  fcmToken: z.string({ required_error: 'FCM token is required.' }).trim().min(10).max(500),
  platform: z.enum(['android', 'ios', 'web']).default('android'),
});

const deleteAccountSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  // Typed confirmation, so an accidental call cannot start a deletion.
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'Set confirm to true to request account deletion.' }),
  }),
});

// --- Fare and booking -------------------------------------------------------

const fareEstimateSchema = z.object({
  // Omit to price every active category (the vehicle selection screen).
  vehicleTypeId: objectId.optional(),
  pickup: placeInput,
  destination: placeInput,
});

const createBookingSchema = z.object({
  vehicleTypeId: objectId,
  pickup: placeInput,
  destination: placeInput,
  paymentMethod: z.enum(PAYMENT_METHOD_VALUES, {
    errorMap: () => ({ message: `Payment method must be one of: ${PAYMENT_METHOD_VALUES.join(', ')}.` }),
  }),
  specialInstructions: z.string().trim().max(500).optional(),
  scheduledAt: z
    .string()
    .datetime({ message: 'Scheduled time must be an ISO 8601 timestamp.' })
    .optional()
    .refine(
      (value) => value === undefined || new Date(value).getTime() > Date.now() - 60_000,
      { message: 'A scheduled pickup must be in the future.' }
    ),
  /**
   * Deduplicates repeat submissions. The client generates a UUID per booking
   * attempt and reuses it across retries - see BookingRepository in the app.
   */
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

const cancelBookingSchema = z.object({
  reason: z
    .string({ required_error: 'Choose a reason for cancelling.' })
    .trim()
    .min(2)
    .max(200)
    .refine((value) => CANCELLATION_REASONS.includes(value) || value.length >= 3, {
      message: 'Choose one of the listed reasons, or describe your own.',
    }),
  remarks: z.string().trim().max(500).optional(),
});

const listBookingsQuerySchema = z.object({
  tab: z.enum(['upcoming', 'active', 'completed', 'cancelled', 'all']).optional(),
  status: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const listNotificationsQuerySchema = z.object({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const bookingIdParamSchema = z.object({
  bookingId: objectId,
});

const addressIdParamSchema = z.object({
  addressId: objectId,
});

const notificationIdParamSchema = z.object({
  notificationId: objectId,
});

module.exports = {
  registerSchema,
  loginSchema,
  sendOtpSchema,
  verifyOtpSchema,
  refreshTokenSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
  changePasswordSchema,
  savedAddressSchema,
  notificationPrefsSchema,
  registerDeviceSchema,
  deleteAccountSchema,
  fareEstimateSchema,
  createBookingSchema,
  cancelBookingSchema,
  listBookingsQuerySchema,
  listNotificationsQuerySchema,
  bookingIdParamSchema,
  addressIdParamSchema,
  notificationIdParamSchema,
};
