'use strict';

const { env } = require('../config/env');
const logger = require('../config/logger');

/**
 * SMS delivery. Two implementations behind one `send` function.
 *
 * The mock provider exists so the whole OTP flow is testable without an SMS
 * account: it logs the code and reports `mocked: true`, which the auth
 * controller uses to decide whether it may echo the code back in the response.
 * `assertRequiredConfig()` refuses to boot production with the mock selected.
 *
 * To add a different gateway (MSG91, Gupshup, AWS SNS), add a branch here and a
 * matching value for SMS_PROVIDER. Nothing outside this file needs to change.
 */

async function sendViaMock({ to, message }) {
  logger.warn('--------------------------------------------------------');
  logger.warn(`[MOCK SMS] to: ${to}`);
  logger.warn(`[MOCK SMS] ${message}`);
  logger.warn('--------------------------------------------------------');
  return { mocked: true, providerMessageId: `mock_${Date.now()}` };
}

async function sendViaTwilio({ to, message }) {
  const { twilioAccountSid, twilioAuthToken, twilioFromNumber } = env.sms;

  if (!twilioAccountSid || !twilioAuthToken || !twilioFromNumber) {
    throw new Error(
      'SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER are not all set.'
    );
  }

  // Called over plain fetch rather than the twilio SDK to keep the dependency
  // list small; this is the whole of the Messages API we need.
  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
  const body = new URLSearchParams({ To: to, From: twilioFromNumber, Body: message });
  const auth = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(10000),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = payload?.message || `HTTP ${response.status}`;
    throw new Error(`Twilio rejected the message: ${detail}`);
  }

  return { mocked: false, providerMessageId: payload.sid };
}

async function sendSms({ to, message }) {
  switch (env.sms.provider) {
    case 'twilio':
      return sendViaTwilio({ to, message });
    case 'mock':
      return sendViaMock({ to, message });
    default:
      throw new Error(`Unknown SMS_PROVIDER "${env.sms.provider}". Use "mock" or "twilio".`);
  }
}

const isMocked = () => env.sms.provider === 'mock';

module.exports = { sendSms, isMocked };
