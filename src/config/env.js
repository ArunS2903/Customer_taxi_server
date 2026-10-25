'use strict';

require('dotenv').config();

/** Parse a comma separated env var into a trimmed, non-empty array. */
function list(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function float(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 5000),
  apiPrefix: process.env.API_PREFIX || '/api/v1',
  mongoUri: process.env.MONGODB_URI || '',
  corsOrigins: list(process.env.CORS_ORIGINS),

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || '',
    refreshSecret: process.env.JWT_REFRESH_SECRET || '',
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '30d',
  },

  sms: {
    provider: (process.env.SMS_PROVIDER || 'mock').toLowerCase(),
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },

  email: {
    provider: (process.env.EMAIL_PROVIDER || 'mock').toLowerCase(),
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: int(process.env.SMTP_PORT, 587),
    smtpUser: process.env.SMTP_USER || '',
    smtpPassword: process.env.SMTP_PASSWORD || '',
    from: process.env.EMAIL_FROM || 'no-reply@example.com',
  },

  maps: {
    serverKey: process.env.GOOGLE_MAPS_SERVER_KEY || '',
    roadFactor: float(process.env.HAVERSINE_ROAD_FACTOR, 1.35),
    fallbackSpeedKmph: float(process.env.FALLBACK_AVG_SPEED_KMPH, 26),
  },

  firebase: {
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
  },

  otp: {
    length: int(process.env.OTP_LENGTH, 6),
    ttlSeconds: int(process.env.OTP_TTL_SECONDS, 300),
    maxAttempts: int(process.env.OTP_MAX_ATTEMPTS, 5),
    resendCooldownSeconds: int(process.env.OTP_RESEND_COOLDOWN_SECONDS, 30),
    maxPerHour: int(process.env.OTP_MAX_PER_HOUR, 6),
  },

  booking: {
    freeCancelWindowSeconds: int(process.env.BOOKING_FREE_CANCEL_WINDOW_SECONDS, 120),
    lateCancelFee: float(process.env.BOOKING_LATE_CANCEL_FEE, 30),
  },
};

env.isProduction = env.nodeEnv === 'production';
env.isDevelopment = !env.isProduction;

/**
 * Fails fast on misconfiguration instead of booting a server that cannot sign
 * or verify tokens. Called from server.js before the HTTP listener opens.
 */
function assertRequiredConfig() {
  const missing = [];
  if (!env.mongoUri) missing.push('MONGODB_URI');
  if (!env.jwt.accessSecret) missing.push('JWT_ACCESS_SECRET');
  if (!env.jwt.refreshSecret) missing.push('JWT_REFRESH_SECRET');

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy backend/.env.example to backend/.env and fill them in.'
    );
  }

  if (env.jwt.accessSecret === env.jwt.refreshSecret) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
  }

  if (env.isProduction) {
    if (env.sms.provider === 'mock') {
      throw new Error('SMS_PROVIDER=mock is not allowed in production - OTPs would never be delivered.');
    }
    if (!env.maps.serverKey) {
      throw new Error('GOOGLE_MAPS_SERVER_KEY is required in production - fares must not rely on the straight-line estimator.');
    }
  }
}

/** Human readable report of optional integrations that are running on mocks. */
function configWarnings() {
  const warnings = [];
  if (env.sms.provider === 'mock') {
    warnings.push('SMS_PROVIDER=mock - OTP codes are logged to the console, not texted.');
  }
  if (env.email.provider === 'mock') {
    warnings.push('EMAIL_PROVIDER=mock - verification emails are logged to the console, not sent.');
  }
  if (!env.maps.serverKey) {
    warnings.push('GOOGLE_MAPS_SERVER_KEY is empty - distances use the haversine estimator.');
  }
  if (!env.firebase.serviceAccountPath) {
    warnings.push('FIREBASE_SERVICE_ACCOUNT_PATH is empty - push delivery disabled, in-app history still works.');
  }
  return warnings;
}

module.exports = { env, assertRequiredConfig, configWarnings };
