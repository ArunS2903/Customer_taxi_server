'use strict';

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const logger = require('../config/logger');

/**
 * Firebase Cloud Messaging through the HTTP v1 API.
 *
 * Implemented directly rather than via firebase-admin: all we need is a
 * service-account-signed JWT exchanged for an access token, and one POST per
 * message. That keeps the dependency tree small and the failure modes visible.
 *
 * Push is strictly best-effort. Every notification is persisted first (see
 * notification.service.js), so a missing FIREBASE_SERVICE_ACCOUNT_PATH, an
 * expired token or an FCM outage costs real-time delivery and nothing else.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let serviceAccount = null;
let serviceAccountLoadFailed = false;
let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

function loadServiceAccount() {
  if (serviceAccount || serviceAccountLoadFailed) return serviceAccount;

  const configuredPath = env.firebase.serviceAccountPath;
  if (!configuredPath) {
    serviceAccountLoadFailed = true;
    return null;
  }

  try {
    const resolved = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(process.cwd(), configuredPath);
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));

    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new Error('service account JSON is missing project_id, client_email or private_key');
    }

    serviceAccount = parsed;
    logger.info(`FCM configured for project ${parsed.project_id}`);
    return serviceAccount;
  } catch (err) {
    serviceAccountLoadFailed = true;
    logger.error(
      `Could not load FIREBASE_SERVICE_ACCOUNT_PATH ("${configuredPath}"): ${err.message}. ` +
        'Push notifications are disabled; in-app notification history still works.'
    );
    return null;
  }
}

function isEnabled() {
  return Boolean(loadServiceAccount());
}

/** Exchanges a signed assertion for an OAuth access token, cached until expiry. */
async function getAccessToken() {
  const account = loadServiceAccount();
  if (!account) return null;

  // Refresh a minute early so a token never expires mid-flight.
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 60_000) {
    return cachedAccessToken;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    },
    account.private_key,
    { algorithm: 'RS256' }
  );

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(10000),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    throw new Error(`FCM token exchange failed: ${payload.error_description || response.status}`);
  }

  cachedAccessToken = payload.access_token;
  cachedAccessTokenExpiry = Date.now() + (payload.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

/**
 * Sends one message to one device token.
 *
 * Returns `{ ok, unregistered, error }`. `unregistered: true` means the token
 * is dead (app uninstalled, token rotated) and the caller should drop it from
 * the customer's device list rather than retrying forever.
 */
async function sendToToken({ fcmToken, title, body, data = {} }) {
  const account = loadServiceAccount();
  if (!account) return { ok: false, unregistered: false, error: 'FCM not configured' };

  try {
    const accessToken = await getAccessToken();

    // FCM data values must all be strings.
    const stringData = Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, value == null ? '' : String(value)])
    );

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            notification: { title, body },
            data: stringData,
            android: {
              priority: 'HIGH',
              notification: {
                channel_id: 'booking_updates',
                sound: 'default',
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
              },
            },
            apns: {
              payload: { aps: { sound: 'default', badge: 1 } },
            },
          },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (response.ok) {
      return { ok: true, unregistered: false, error: null };
    }

    const payload = await response.json().catch(() => ({}));
    const status = payload?.error?.status;
    const unregistered = status === 'NOT_FOUND' || status === 'UNREGISTERED' || response.status === 404;

    return {
      ok: false,
      unregistered,
      error: payload?.error?.message || `HTTP ${response.status}`,
    };
  } catch (err) {
    return { ok: false, unregistered: false, error: err.message };
  }
}

module.exports = { isEnabled, sendToToken };
