'use strict';

const { env } = require('../config/env');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

/**
 * Route measurement. The fare depends on this number, so it is measured on the
 * server and never taken from the client.
 *
 * With GOOGLE_MAPS_SERVER_KEY set we ask the Routes API for real driving
 * distance and duration. Without a key we fall back to a haversine estimate
 * scaled by HAVERSINE_ROAD_FACTOR, which is good enough to develop against but
 * will misprice real trips - `assertRequiredConfig()` therefore refuses to boot
 * production without a key, and every estimate reports which source produced it
 * so the client can label a fare that came from the fallback.
 */

const EARTH_RADIUS_KM = 6371;
const MAX_REASONABLE_DISTANCE_KM = 1000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in kilometres. */
function haversineKm(from, to) {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function assertValidPoint(point, label) {
  const lat = Number(point?.latitude);
  const lng = Number(point?.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw ApiError.badRequest(`${label} coordinates are missing or not numbers.`, 'INVALID_COORDINATES');
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw ApiError.badRequest(`${label} coordinates are out of range.`, 'INVALID_COORDINATES');
  }
  // Exactly (0, 0) is in the Gulf of Guinea; in practice it means "the client
  // sent an uninitialised location", which would otherwise price a 5000 km trip.
  if (lat === 0 && lng === 0) {
    throw ApiError.badRequest(`${label} location was not set.`, 'INVALID_COORDINATES');
  }
  return { latitude: lat, longitude: lng };
}

function estimateWithHaversine(pickup, destination) {
  const straightLineKm = haversineKm(pickup, destination);
  const distanceKm = straightLineKm * env.maps.roadFactor;
  const durationMinutes = (distanceKm / env.maps.fallbackSpeedKmph) * 60;

  return {
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationMinutes: Math.max(1, Math.round(durationMinutes)),
    polyline: null,
    source: 'haversine',
  };
}

/**
 * Google Routes API (`computeRoutes`). Chosen over the legacy Distance Matrix
 * because it returns the encoded polyline in the same call, which the booking
 * details screen reuses to redraw the route.
 */
async function estimateWithGoogle(pickup, destination) {
  const body = {
    origin: {
      location: { latLng: { latitude: pickup.latitude, longitude: pickup.longitude } },
    },
    destination: {
      location: { latLng: { latitude: destination.latitude, longitude: destination.longitude } },
    },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    units: 'METRIC',
  };

  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': env.maps.serverKey,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Routes API returned HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  const route = payload?.routes?.[0];

  if (!route || typeof route.distanceMeters !== 'number') {
    throw new Error('Routes API returned no drivable route.');
  }

  // `duration` comes back as a protobuf duration string, e.g. "1086s".
  const durationSeconds = Number.parseInt(String(route.duration || '0').replace('s', ''), 10) || 0;

  return {
    distanceKm: Math.round((route.distanceMeters / 1000) * 100) / 100,
    durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
    polyline: route.polyline?.encodedPolyline || null,
    source: 'google',
  };
}

/**
 * Measures a route between two points.
 *
 * A Google failure degrades to the haversine estimate rather than failing the
 * booking, because a customer who cannot get a price cannot ride. The returned
 * `source` tells the caller what happened, and the warning is logged.
 */
async function measureRoute(rawPickup, rawDestination) {
  const pickup = assertValidPoint(rawPickup, 'Pickup');
  const destination = assertValidPoint(rawDestination, 'Destination');

  const straightLineKm = haversineKm(pickup, destination);

  if (straightLineKm < 0.05) {
    throw ApiError.badRequest(
      'Pickup and destination are at the same place. Choose a different destination.',
      'SAME_LOCATION'
    );
  }
  if (straightLineKm > MAX_REASONABLE_DISTANCE_KM) {
    throw ApiError.badRequest(
      'That trip is too long to book in the app. Please contact support to arrange it.',
      'DISTANCE_TOO_LONG'
    );
  }

  if (!env.maps.serverKey) {
    return estimateWithHaversine(pickup, destination);
  }

  try {
    return await estimateWithGoogle(pickup, destination);
  } catch (err) {
    logger.warn(`Routes API failed, falling back to haversine: ${err.message}`);
    return estimateWithHaversine(pickup, destination);
  }
}

module.exports = {
  measureRoute,
  haversineKm,
  assertValidPoint,
  MAX_REASONABLE_DISTANCE_KM,
};
