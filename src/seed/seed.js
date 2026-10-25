'use strict';

/**
 * Seeds the data the Admin Web Application would normally own: vehicle
 * categories, their price lists, and the business contact details.
 *
 * Idempotent - it upserts by `code` / `isActive`, so running it twice does not
 * duplicate anything. Safe to re-run after editing the numbers below.
 *
 *   npm run seed            seed vehicles, fares and contact
 *   npm run seed -- --demo  also create a demo customer and a sample booking
 *
 * These prices are placeholders for development. Replace them from the admin
 * app before taking real bookings.
 */

const mongoose = require('mongoose');
const { env, assertRequiredConfig } = require('../config/env');
const logger = require('../config/logger');
const VehicleType = require('../models/VehicleType');
const FareRule = require('../models/FareRule');
const BusinessContact = require('../models/BusinessContact');
const Customer = require('../models/Customer');
const Booking = require('../models/Booking');
const Counter = require('../models/Counter');
const { hashPassword } = require('../utils/password');
const { BOOKING_STATUS, PAYMENT_METHOD, PAYMENT_STATUS } = require('../constants/domain');
const fareService = require('../services/fare.service');

const VEHICLE_TYPES = [
  {
    code: 'MINI',
    name: 'Mini',
    description: 'Compact hatchback, best value for short city trips.',
    passengerCapacity: 4,
    luggageCapacity: 1,
    iconName: 'mini',
    defaultEtaMinutes: 3,
    sortOrder: 10,
    fare: {
      baseFare: 40,
      baseDistanceKm: 2,
      perKmRate: 12,
      perMinuteRate: 1,
      minimumFare: 60,
      waitingChargePerMinute: 1.5,
      freeWaitingMinutes: 5,
      platformFee: 10,
      taxPercent: 5,
      cancellationFee: 25,
      freeCancellationMinutes: 2,
    },
  },
  {
    code: 'SEDAN',
    name: 'Sedan',
    description: 'Comfortable saloon with room for luggage.',
    passengerCapacity: 4,
    luggageCapacity: 2,
    iconName: 'sedan',
    defaultEtaMinutes: 5,
    sortOrder: 20,
    fare: {
      baseFare: 55,
      baseDistanceKm: 2,
      perKmRate: 16,
      perMinuteRate: 1.5,
      minimumFare: 85,
      waitingChargePerMinute: 2,
      freeWaitingMinutes: 5,
      platformFee: 10,
      taxPercent: 5,
      cancellationFee: 30,
      freeCancellationMinutes: 2,
    },
  },
  {
    code: 'SUV',
    name: 'SUV',
    description: 'Seven seats for groups, hills and heavy luggage.',
    passengerCapacity: 6,
    luggageCapacity: 4,
    iconName: 'suv',
    defaultEtaMinutes: 7,
    sortOrder: 30,
    fare: {
      baseFare: 80,
      baseDistanceKm: 2,
      perKmRate: 22,
      perMinuteRate: 2,
      minimumFare: 130,
      waitingChargePerMinute: 2.5,
      freeWaitingMinutes: 5,
      platformFee: 15,
      taxPercent: 5,
      cancellationFee: 40,
      freeCancellationMinutes: 3,
    },
  },
  {
    code: 'PREMIUM',
    name: 'Premium',
    description: 'Top-end cars with professional chauffeurs.',
    passengerCapacity: 4,
    luggageCapacity: 3,
    iconName: 'premium',
    defaultEtaMinutes: 9,
    sortOrder: 40,
    fare: {
      baseFare: 120,
      baseDistanceKm: 3,
      perKmRate: 30,
      perMinuteRate: 3,
      minimumFare: 200,
      waitingChargePerMinute: 4,
      freeWaitingMinutes: 7,
      platformFee: 20,
      additionalCharges: [{ label: 'Premium service fee', amount: 25 }],
      nightSurcharge: { enabled: true, startHour: 23, endHour: 5, multiplier: 1.25 },
      taxPercent: 5,
      cancellationFee: 60,
      freeCancellationMinutes: 3,
    },
  },
];

const BUSINESS_CONTACT = {
  businessName: 'Your Taxi Service',
  adminContactName: 'Customer Support',
  adminPhone: '+919000000000',
  adminEmail: 'support@example.com',
  supportPhone: '+919000000001',
  supportEmail: 'help@example.com',
  whatsappNumber: '+919000000001',
  addressLine: '1 Example Road',
  city: 'Coimbatore',
  state: 'Tamil Nadu',
  postalCode: '641001',
  country: 'India',
  websiteUrl: 'https://example.com',
  termsUrl: 'https://example.com/terms',
  privacyUrl: 'https://example.com/privacy',
  workingHours: 'Mon-Sun, 24 hours',
  supportHours: 'Mon-Sun, 6:00 to 23:00',
  isActive: true,
};

async function seedVehiclesAndFares() {
  const results = [];

  for (const definition of VEHICLE_TYPES) {
    const { fare, ...vehicleFields } = definition;

    const vehicle = await VehicleType.findOneAndUpdate(
      { code: definition.code },
      { $set: { ...vehicleFields, isActive: true } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // One active rule per vehicle. Replacing it rather than inserting a new one
    // keeps re-runs from stacking up price lists.
    await FareRule.findOneAndUpdate(
      { vehicleTypeId: vehicle._id, isActive: true },
      {
        $set: {
          vehicleTypeId: vehicle._id,
          currency: 'INR',
          currencySymbol: '₹',
          surgeMultiplier: 1,
          effectiveFrom: new Date(Date.now() - 60_000),
          isActive: true,
          ...fare,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    results.push(`${vehicle.code} (${vehicle.name})`);
  }

  logger.info(`Vehicle categories and fare rules: ${results.join(', ')}`);
}

async function seedBusinessContact() {
  const existing = await BusinessContact.findOne({ isActive: true });

  if (existing) {
    logger.info(`Business contact already configured: ${existing.businessName} (left unchanged)`);
    return existing;
  }

  const contact = await BusinessContact.create(BUSINESS_CONTACT);
  logger.info(`Business contact created: ${contact.businessName}`);
  logger.warn(
    'Business contact holds placeholder numbers. Replace them from the Admin Web App before going live.'
  );
  return contact;
}

/** Demo customer + one booking, so the app has something to show on first run. */
async function seedDemoData() {
  const phone = '+919876543210';
  const password = 'Password123';

  let customer = await Customer.findOne({ phone });

  if (!customer) {
    customer = await Customer.create({
      fullName: 'Demo Customer',
      phone,
      email: 'demo.customer@example.com',
      passwordHash: await hashPassword(password),
      phoneVerified: true,
      emailVerified: true,
      savedAddresses: [
        {
          label: 'Home',
          address: '12 Gandhipuram, Coimbatore, Tamil Nadu',
          latitude: 11.0183,
          longitude: 76.9725,
        },
        {
          label: 'Office',
          address: 'Tidel Park, Coimbatore, Tamil Nadu',
          latitude: 11.03,
          longitude: 77.0434,
        },
      ],
    });
    logger.info(`Demo customer created: ${phone} / ${password}`);
  } else {
    logger.info(`Demo customer already exists: ${phone}`);
  }

  const existingBooking = await Booking.findOne({ customerId: customer._id });
  if (existingBooking) {
    logger.info(`Demo booking already exists: ${existingBooking.bookingCode}`);
    return;
  }

  const sedan = await VehicleType.findOne({ code: 'SEDAN' });
  const pickup = {
    address: '12 Gandhipuram, Coimbatore, Tamil Nadu',
    latitude: 11.0183,
    longitude: 76.9725,
  };
  const destination = {
    address: 'Tidel Park, Coimbatore, Tamil Nadu',
    latitude: 11.03,
    longitude: 77.0434,
  };

  const quote = await fareService.estimateForVehicleType({
    vehicleTypeId: sedan._id,
    pickup,
    destination,
  });
  const contact = await BusinessContact.findOne({ isActive: true });
  const seq = await Counter.next('bookingCode');

  const booking = await Booking.create({
    bookingCode: `TX-${String(seq).padStart(6, '0')}`,
    customerId: customer._id,
    customerName: customer.fullName,
    customerPhone: customer.phone,
    customerEmail: customer.email,
    vehicleTypeId: sedan._id,
    vehicleTypeName: sedan.name,
    vehicleTypeCode: sedan.code,
    pickup,
    destination,
    distanceKm: quote.route.distanceKm,
    durationMinutes: quote.route.durationMinutes,
    routePolyline: quote.route.polyline,
    distanceSource: quote.route.source,
    estimatedFare: quote.breakdown.total,
    finalFare: quote.breakdown.total,
    fareBreakdown: quote.breakdown,
    bookingStatus: BOOKING_STATUS.COMPLETED,
    statusHistory: [
      { status: BOOKING_STATUS.PENDING, at: new Date(Date.now() - 86_400_000) },
      { status: BOOKING_STATUS.COMPLETED, at: new Date(Date.now() - 82_800_000) },
    ],
    paymentMethod: PAYMENT_METHOD.CASH,
    paymentStatus: PAYMENT_STATUS.PAID,
    businessContactSnapshot: contact ? contact.toSnapshot() : null,
    completedAt: new Date(Date.now() - 82_800_000),
    source: 'seed',
  });

  logger.info(`Demo booking created: ${booking.bookingCode}`);
}

async function main() {
  const withDemo = process.argv.includes('--demo');

  assertRequiredConfig();
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000 });
  logger.info(`Connected to MongoDB (${env.nodeEnv})`);

  await seedVehiclesAndFares();
  await seedBusinessContact();

  if (withDemo) {
    await seedDemoData();
  } else {
    logger.info('Skipping demo customer and booking. Pass --demo to create them.');
  }

  await mongoose.disconnect();
  logger.info('Seed complete.');
}

main().catch(async (err) => {
  logger.error(`Seed failed: ${err.message}`);
  logger.error(err.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
