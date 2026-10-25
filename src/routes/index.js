'use strict';

const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { bookingLimiter } = require('../middleware/rateLimit');
const schemas = require('../validators');

const authRoutes = require('./auth.routes');
const customerController = require('../controllers/customer.controller');
const vehicleController = require('../controllers/vehicle.controller');
const fareController = require('../controllers/fare.controller');
const bookingController = require('../controllers/booking.controller');
const publicController = require('../controllers/public.controller');
const notificationController = require('../controllers/notification.controller');

const router = express.Router();

// --- Public -----------------------------------------------------------------

router.get('/public/health', publicController.health);
router.get('/public/app-config', publicController.getAppConfig);
router.get('/public/business-contact', publicController.getBusinessContact);

// --- Authentication ---------------------------------------------------------

router.use('/auth', authRoutes);

// --- Customer ---------------------------------------------------------------

const customerRouter = express.Router();
customerRouter.use(requireAuth);

customerRouter.get('/me', customerController.getMe);
customerRouter.put('/me', validate(schemas.updateProfileSchema), customerController.updateMe);
customerRouter.put(
  '/me/password',
  validate(schemas.changePasswordSchema),
  customerController.changePassword
);
customerRouter.get(
  '/me/bookings',
  validate(schemas.listBookingsQuerySchema, 'query'),
  customerController.getMyBookings
);

customerRouter.get('/me/addresses', customerController.listAddresses);
customerRouter.post(
  '/me/addresses',
  validate(schemas.savedAddressSchema),
  customerController.addAddress
);
customerRouter.delete(
  '/me/addresses/:addressId',
  validate(schemas.addressIdParamSchema, 'params'),
  customerController.deleteAddress
);

customerRouter.put(
  '/me/notification-preferences',
  validate(schemas.notificationPrefsSchema),
  customerController.updateNotificationPrefs
);
customerRouter.post(
  '/me/devices',
  validate(schemas.registerDeviceSchema),
  customerController.registerDevice
);

customerRouter.delete(
  '/me',
  validate(schemas.deleteAccountSchema),
  customerController.requestAccountDeletion
);

router.use('/customers', customerRouter);

// --- Vehicles and fares -----------------------------------------------------

/**
 * The catalogue is readable without a session so the home screen can render
 * categories during onboarding. Pricing a route requires authentication, since
 * it costs a Routes API call.
 */
router.get('/vehicles/types', vehicleController.listVehicleTypes);
router.post(
  '/fares/estimate',
  requireAuth,
  validate(schemas.fareEstimateSchema),
  fareController.estimate
);

// --- Bookings ---------------------------------------------------------------

const bookingRouter = express.Router();
bookingRouter.use(requireAuth);

bookingRouter.post(
  '/',
  bookingLimiter,
  validate(schemas.createBookingSchema),
  bookingController.createBooking
);
bookingRouter.get(
  '/',
  validate(schemas.listBookingsQuerySchema, 'query'),
  bookingController.listBookings
);
bookingRouter.get(
  '/:bookingId',
  validate(schemas.bookingIdParamSchema, 'params'),
  bookingController.getBooking
);
bookingRouter.get(
  '/:bookingId/cancellation-policy',
  validate(schemas.bookingIdParamSchema, 'params'),
  bookingController.getCancellationPolicy
);
bookingRouter.post(
  '/:bookingId/cancel',
  validate(schemas.bookingIdParamSchema, 'params'),
  validate(schemas.cancelBookingSchema),
  bookingController.cancelBooking
);

router.use('/bookings', bookingRouter);

// --- Notifications ----------------------------------------------------------

const notificationRouter = express.Router();
notificationRouter.use(requireAuth);

notificationRouter.get(
  '/',
  validate(schemas.listNotificationsQuerySchema, 'query'),
  notificationController.listNotifications
);
notificationRouter.get('/unread-count', notificationController.getUnreadCount);
notificationRouter.post('/read-all', notificationController.markAllRead);
notificationRouter.post(
  '/:notificationId/read',
  validate(schemas.notificationIdParamSchema, 'params'),
  notificationController.markRead
);

router.use('/notifications', notificationRouter);

module.exports = router;
