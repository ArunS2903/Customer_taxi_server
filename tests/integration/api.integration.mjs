/**
 * End-to-end integration test against a running API and a real MongoDB.
 *
 *   1. start MongoDB and the API      (npm run dev)
 *   2. seed the catalogue             (npm run seed)
 *   3. run this                       (npm run test:integration)
 *
 * It needs SMS_PROVIDER=mock, because it reads the `devOtp` the backend only
 * returns when SMS is mocked outside production - that is what makes the OTP
 * flows testable without an SMS gateway.
 *
 * Each run creates fresh accounts keyed on the clock, so it is safe to re-run
 * against the same database. It never deletes data.
 *
 * Covers: health and config, business contact, the vehicle catalogue, OTP
 * registration, all three login paths, token rotation and reuse detection,
 * profile and saved addresses, fare estimation and its arithmetic, booking
 * creation including five-way concurrent idempotency, ownership isolation
 * between customers, the cancellation policy and cancelling, notifications,
 * password reset and session revocation, and error envelopes.
 *
 * Override the target with API_BASE_URL.
 */

const BASE = process.env.API_BASE_URL || 'http://127.0.0.1:5055/api/v1';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` -> ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}

async function call(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

const uniquePhone = `+9198${String(Date.now()).slice(-8)}`;
const password = 'Password123';

const PICKUP = {
  address: '12 Gandhipuram, Coimbatore, Tamil Nadu',
  latitude: 11.0183,
  longitude: 76.9725,
};
const DESTINATION = {
  address: 'Tidel Park, Coimbatore, Tamil Nadu',
  latitude: 11.03,
  longitude: 77.0434,
};

async function main() {
  section('Public endpoints');
  const health = await call('GET', '/public/health');
  check('health returns 200', health.status === 200, health.body);
  check('health reports connected db', health.body?.data?.database === 'connected', health.body?.data);

  const config = await call('GET', '/public/app-config');
  check('app-config returns payment methods', Array.isArray(config.body?.data?.paymentMethods), config.body);
  check(
    'app-config flags mocked SMS',
    config.body?.data?.features?.smsOtp === false,
    config.body?.data?.features
  );
  check(
    'app-config flags haversine distances',
    config.body?.data?.features?.routeAccurateDistances === false,
    config.body?.data?.features
  );

  const contact = await call('GET', '/public/business-contact');
  check('business-contact returns 200', contact.status === 200, contact.body);
  check(
    'business-contact has businessName',
    typeof contact.body?.data?.businessContact?.businessName === 'string',
    contact.body
  );
  check(
    'business-contact exposes no private fields',
    contact.body?.data?.businessContact &&
      !('_id' in contact.body.data.businessContact) &&
      !('isActive' in contact.body.data.businessContact),
    Object.keys(contact.body?.data?.businessContact || {})
  );

  section('Vehicle catalogue');
  const vehicles = await call('GET', '/vehicles/types');
  check('vehicles/types returns 4 categories', vehicles.body?.data?.items?.length === 4, vehicles.body);
  const sedan = vehicles.body?.data?.items?.find((v) => v.code === 'SEDAN');
  check('sedan is present and bookable', sedan?.isBookable === true, sedan);
  check('sedan carries an admin rate card', typeof sedan?.rateCard?.perKmRate === 'number', sedan?.rateCard);
  check(
    'catalogue returns no trip total (needs a route)',
    sedan && !('fare' in sedan),
    Object.keys(sedan || {})
  );

  section('Registration requires a verified OTP');
  const premature = await call('POST', '/auth/register', {
    body: { fullName: 'No OTP', phone: uniquePhone, password },
  });
  check(
    'register without verificationToken is rejected',
    premature.status === 400 && premature.body?.code === 'VERIFICATION_TOKEN_MISSING',
    premature.body
  );

  const sendOtp = await call('POST', '/auth/send-otp', {
    body: { phone: uniquePhone, purpose: 'register' },
  });
  check('send-otp returns 200', sendOtp.status === 200, sendOtp.body);
  check('send-otp masks the destination', typeof sendOtp.body?.data?.maskedDestination === 'string', sendOtp.body);
  const devOtp = sendOtp.body?.data?.devOtp;
  check('send-otp echoes devOtp while mocked', typeof devOtp === 'string', sendOtp.body?.data);

  const wrongCode = await call('POST', '/auth/verify-otp', {
    body: { phone: uniquePhone, purpose: 'register', otp: '000000' },
  });
  check(
    'wrong OTP is rejected with attempt count',
    wrongCode.status === 400 && wrongCode.body?.code === 'OTP_INCORRECT',
    wrongCode.body
  );

  const verify = await call('POST', '/auth/verify-otp', {
    body: { phone: uniquePhone, purpose: 'register', otp: devOtp },
  });
  check('correct OTP verifies', verify.status === 200 && verify.body?.data?.verified === true, verify.body);
  const verificationToken = verify.body?.data?.verificationToken;
  check('verify returns a verificationToken', typeof verificationToken === 'string', verify.body?.data);

  const weak = await call('POST', '/auth/register', {
    body: { fullName: 'Weak Pass', phone: uniquePhone, password: 'short', verificationToken },
  });
  check('weak password is rejected', weak.status === 400, weak.body);

  const register = await call('POST', '/auth/register', {
    body: {
      fullName: 'Smoke Test',
      phone: uniquePhone,
      email: `smoke.${Date.now()}@example.com`,
      password,
      confirmPassword: password,
      verificationToken,
    },
  });
  check('register returns 201', register.status === 201, register.body);
  check('register returns an access token', typeof register.body?.data?.accessToken === 'string', register.body);
  check('phone is marked verified', register.body?.data?.customer?.phoneVerified === true, register.body?.data?.customer);
  check(
    'register never returns a password hash',
    !JSON.stringify(register.body || {}).includes('passwordHash'),
    Object.keys(register.body?.data?.customer || {})
  );

  const replay = await call('POST', '/auth/register', {
    body: { fullName: 'Replay', phone: uniquePhone, password, verificationToken },
  });
  check(
    'verificationToken cannot be replayed',
    replay.status === 409 || replay.status === 400,
    replay.body
  );

  section('Login');
  const badLogin = await call('POST', '/auth/login', {
    body: { phone: uniquePhone, password: 'WrongPassword9' },
  });
  check(
    'wrong password returns a generic 401',
    badLogin.status === 401 && badLogin.body?.code === 'INVALID_CREDENTIALS',
    badLogin.body
  );

  const unknownLogin = await call('POST', '/auth/login', {
    body: { phone: '+919999999998', password: 'WrongPassword9' },
  });
  check(
    'unknown account returns the same code (no enumeration)',
    unknownLogin.status === 401 && unknownLogin.body?.code === 'INVALID_CREDENTIALS',
    unknownLogin.body
  );

  const login = await call('POST', '/auth/login', {
    body: { phone: uniquePhone, password },
  });
  check('password login succeeds', login.status === 200, login.body);
  let token = login.body?.data?.accessToken;
  const refreshToken = login.body?.data?.refreshToken;
  check('login returns a refresh token', typeof refreshToken === 'string', login.body?.data);

  // Login option B: phone + OTP.
  const loginOtpSend = await call('POST', '/auth/send-otp', {
    body: { phone: uniquePhone, purpose: 'login' },
  });
  const loginOtpVerify = await call('POST', '/auth/verify-otp', {
    body: { phone: uniquePhone, purpose: 'login', otp: loginOtpSend.body?.data?.devOtp },
  });
  check(
    'OTP login issues a session directly',
    loginOtpVerify.status === 200 && typeof loginOtpVerify.body?.data?.accessToken === 'string',
    loginOtpVerify.body
  );

  section('Token handling');
  const noAuth = await call('GET', '/customers/me');
  check('protected route rejects anonymous', noAuth.status === 401 && noAuth.body?.code === 'AUTH_REQUIRED', noAuth.body);

  const badToken = await call('GET', '/customers/me', { token: 'not-a-real-token' });
  check('garbage token is rejected', badToken.status === 401, badToken.body);

  const refreshed = await call('POST', '/auth/refresh-token', { body: { refreshToken } });
  check('refresh-token rotates', refreshed.status === 200 && refreshed.body?.data?.refreshToken !== refreshToken, refreshed.body);
  const rotatedRefresh = refreshed.body?.data?.refreshToken;
  token = refreshed.body?.data?.accessToken;

  const reuse = await call('POST', '/auth/refresh-token', { body: { refreshToken } });
  check(
    'reusing an old refresh token is detected',
    reuse.status === 401 && reuse.body?.code === 'REFRESH_TOKEN_REUSED',
    reuse.body
  );

  // That reuse revoked the whole family, so re-login for a clean session.
  const relogin = await call('POST', '/auth/login', { body: { phone: uniquePhone, password } });
  token = relogin.body?.data?.accessToken;
  check('re-login after reuse lockout works', relogin.status === 200, relogin.body);

  section('Profile');
  const me = await call('GET', '/customers/me', { token });
  check('customers/me returns the profile', me.body?.data?.customer?.phone === uniquePhone, me.body);

  const renamed = await call('PUT', '/customers/me', { token, body: { fullName: 'Smoke Tested' } });
  check('name updates', renamed.body?.data?.customer?.fullName === 'Smoke Tested', renamed.body);

  const stealPhone = await call('PUT', '/customers/me', {
    token,
    body: { phone: '+919876500001' },
  });
  check(
    'changing phone without a verified OTP is refused',
    stealPhone.status === 400 && stealPhone.body?.code === 'VERIFICATION_TOKEN_MISSING',
    stealPhone.body
  );

  const addr = await call('POST', '/customers/me/addresses', {
    token,
    body: { label: 'Home', ...PICKUP },
  });
  check('saved address added', addr.body?.data?.savedAddresses?.length === 1, addr.body);

  const addrAgain = await call('POST', '/customers/me/addresses', {
    token,
    body: { label: 'Home', address: 'Another home', latitude: 11.02, longitude: 76.98 },
  });
  check(
    'Home is a singleton (replaced, not duplicated)',
    addrAgain.body?.data?.savedAddresses?.length === 1,
    addrAgain.body?.data?.savedAddresses
  );

  const prefs = await call('PUT', '/customers/me/notification-preferences', {
    token,
    body: { promotions: true },
  });
  check('notification prefs update', prefs.body?.data?.notificationPrefs?.promotions === true, prefs.body);

  section('Fare estimation');
  const badCoords = await call('POST', '/fares/estimate', {
    token,
    body: { pickup: { ...PICKUP, latitude: 0, longitude: 0 }, destination: DESTINATION },
  });
  check(
    'uninitialised (0,0) pickup is rejected',
    badCoords.status === 400 && badCoords.body?.code === 'INVALID_COORDINATES',
    badCoords.body
  );

  const samePlace = await call('POST', '/fares/estimate', {
    token,
    body: { pickup: PICKUP, destination: PICKUP },
  });
  check(
    'identical pickup and destination is rejected',
    samePlace.status === 400 && samePlace.body?.code === 'SAME_LOCATION',
    samePlace.body
  );

  const allEstimates = await call('POST', '/fares/estimate', {
    token,
    body: { pickup: PICKUP, destination: DESTINATION },
  });
  check('estimate for all categories returns 200', allEstimates.status === 200, allEstimates.body);
  check('all four categories are priced', allEstimates.body?.data?.estimates?.length === 4, allEstimates.body?.data?.estimates?.length);
  check('response is flagged as an estimate', allEstimates.body?.data?.isEstimate === true, allEstimates.body?.data);
  check(
    'route is flagged approximate without a Maps key',
    allEstimates.body?.data?.route?.isApproximate === true,
    allEstimates.body?.data?.route
  );

  const est = allEstimates.body?.data?.estimates || [];
  const mini = est.find((e) => e.code === 'MINI');
  const premium = est.find((e) => e.code === 'PREMIUM');
  check('Mini is cheaper than Premium', mini?.fare?.total < premium?.fare?.total, {
    mini: mini?.fare?.total,
    premium: premium?.fare?.total,
  });
  check('fare carries an itemised breakdown', typeof mini?.fare?.breakdown?.taxAmount === 'number', mini?.fare?.breakdown);

  const breakdown = mini.fare.breakdown;
  const recomputedSubtotal =
    Math.round(
      (breakdown.baseFare +
        breakdown.distanceFare +
        breakdown.timeFare +
        breakdown.waitingCharge +
        breakdown.nightSurcharge +
        breakdown.platformFee +
        breakdown.additionalCharges.reduce((s, c) => s + c.amount, 0)) *
        100
    ) / 100;
  check(
    'breakdown components sum to the subtotal',
    Math.abs(recomputedSubtotal - breakdown.subtotal) < 0.02,
    { recomputedSubtotal, subtotal: breakdown.subtotal }
  );
  check(
    'total equals subtotal plus tax (rounded)',
    breakdown.total === Math.round(breakdown.subtotal + breakdown.taxAmount),
    { subtotal: breakdown.subtotal, tax: breakdown.taxAmount, total: breakdown.total }
  );

  const sedanId = sedan.id;
  const oneEstimate = await call('POST', '/fares/estimate', {
    token,
    body: { vehicleTypeId: sedanId, pickup: PICKUP, destination: DESTINATION },
  });
  check('single-category estimate returns 200', oneEstimate.status === 200, oneEstimate.body);
  const quotedSedanFare = oneEstimate.body?.data?.fare?.total;
  check('single-category fare matches the list fare', quotedSedanFare === est.find((e) => e.code === 'SEDAN')?.fare?.total, {
    single: quotedSedanFare,
    inList: est.find((e) => e.code === 'SEDAN')?.fare?.total,
  });

  section('Booking creation');
  const clientLie = await call('POST', '/bookings', {
    token,
    body: {
      vehicleTypeId: sedanId,
      pickup: PICKUP,
      destination: DESTINATION,
      paymentMethod: 'Cash',
      // All of these must be ignored by the server.
      estimatedFare: 1,
      bookingStatus: 'Completed',
      paymentStatus: 'Paid',
      customerId: '000000000000000000000000',
      bookingCode: 'TX-HACKED',
      idempotencyKey: `smoke-lie-${Date.now()}`,
    },
  });
  check('booking created despite extra fields', clientLie.status === 201, clientLie.body);
  const lied = clientLie.body?.data?.booking;
  check('client-supplied fare is ignored', lied?.estimatedFare === quotedSedanFare, {
    stored: lied?.estimatedFare,
    quoted: quotedSedanFare,
  });
  check('client-supplied status is ignored', lied?.bookingStatus === 'Pending', lied?.bookingStatus);
  check('client-supplied paymentStatus is ignored', lied?.paymentStatus === 'Pending', lied?.paymentStatus);
  check('client-supplied bookingCode is ignored', lied?.bookingCode !== 'TX-HACKED', lied?.bookingCode);
  check(
    'booking is owned by the token holder',
    lied?.customer?.id === me.body?.data?.customer?.id,
    { booking: lied?.customer?.id, me: me.body?.data?.customer?.id }
  );
  check('booking code follows TX-###### format', /^TX-\d{6}$/.test(lied?.bookingCode || ''), lied?.bookingCode);
  check(
    'booking carries a business contact snapshot',
    typeof lied?.businessContact?.businessName === 'string',
    lied?.businessContact
  );

  const idemKey = `smoke-idem-${Date.now()}`;
  const bookingBody = {
    vehicleTypeId: sedanId,
    pickup: PICKUP,
    destination: DESTINATION,
    paymentMethod: 'Cash',
    specialInstructions: 'Call on arrival.',
    idempotencyKey: idemKey,
  };

  const first = await call('POST', '/bookings', { token, body: bookingBody });
  check('first booking returns 201', first.status === 201, first.body);
  const bookingId = first.body?.data?.booking?.id;

  const second = await call('POST', '/bookings', { token, body: bookingBody });
  check('repeat submission returns 200, not 201', second.status === 200, second.body);
  check('repeat submission is flagged deduplicated', second.body?.data?.deduplicated === true, second.body?.data);
  check(
    'repeat submission returns the same booking',
    second.body?.data?.booking?.id === bookingId,
    { first: bookingId, second: second.body?.data?.booking?.id }
  );

  // Concurrent duplicates: five simultaneous requests, one booking.
  const raceKey = `smoke-race-${Date.now()}`;
  const raceBody = { ...bookingBody, idempotencyKey: raceKey };
  const raced = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', '/bookings', { token, body: raceBody })));
  const racedIds = new Set(raced.map((r) => r.body?.data?.booking?.id).filter(Boolean));
  check('five concurrent duplicate taps create one booking', racedIds.size === 1, {
    ids: [...racedIds],
    statuses: raced.map((r) => r.status),
  });

  section('Booking retrieval');
  const list = await call('GET', '/bookings?page=1&limit=10', { token });
  check('bookings list returns items', Array.isArray(list.body?.data?.items), list.body);
  check('list includes a pagination envelope', typeof list.body?.data?.hasMore === 'boolean', list.body?.data);

  const upcoming = await call('GET', '/bookings?tab=upcoming', { token });
  check('upcoming tab filters to Pending/Confirmed', (upcoming.body?.data?.items || []).every((b) => ['Pending', 'Confirmed'].includes(b.bookingStatus)), upcoming.body?.data?.items?.map((b) => b.bookingStatus));

  const completedTab = await call('GET', '/bookings?tab=completed', { token });
  check('completed tab is empty for a new account', completedTab.body?.data?.items?.length === 0, completedTab.body?.data);

  const detail = await call('GET', `/bookings/${bookingId}`, { token });
  check('booking detail returns 200', detail.status === 200, detail.body);
  check('detail includes cancellation metadata', detail.body?.data?.cancellation?.canCancel === true, detail.body?.data?.cancellation);
  check('detail lists cancellation reasons', Array.isArray(detail.body?.data?.cancellation?.reasons), detail.body?.data?.cancellation);
  check(
    'detail includes the admin contact for this booking',
    typeof detail.body?.data?.booking?.businessContact?.adminPhone === 'string',
    detail.body?.data?.booking?.businessContact
  );

  const missing = await call('GET', '/bookings/000000000000000000000000', { token });
  check('unknown booking id returns 404', missing.status === 404 && missing.body?.code === 'BOOKING_NOT_FOUND', missing.body);

  const malformed = await call('GET', '/bookings/not-an-id', { token });
  check('malformed booking id returns a validation error', malformed.status === 400, malformed.body);

  // Another customer must not be able to read this booking.
  const otherPhone = `+9197${String(Date.now()).slice(-8)}`;
  const otherOtp = await call('POST', '/auth/send-otp', { body: { phone: otherPhone, purpose: 'register' } });
  const otherVerify = await call('POST', '/auth/verify-otp', {
    body: { phone: otherPhone, purpose: 'register', otp: otherOtp.body?.data?.devOtp },
  });
  const otherReg = await call('POST', '/auth/register', {
    body: {
      fullName: 'Other Person',
      phone: otherPhone,
      password,
      verificationToken: otherVerify.body?.data?.verificationToken,
    },
  });
  const otherToken = otherReg.body?.data?.accessToken;

  const crossRead = await call('GET', `/bookings/${bookingId}`, { token: otherToken });
  check(
    "another customer cannot read someone else's booking",
    crossRead.status === 404,
    crossRead.body
  );

  const crossCancel = await call('POST', `/bookings/${bookingId}/cancel`, {
    token: otherToken,
    body: { reason: 'Booked by mistake' },
  });
  check(
    "another customer cannot cancel someone else's booking",
    crossCancel.status === 404,
    crossCancel.body
  );

  section('Cancellation');
  const policy = await call('GET', `/bookings/${bookingId}/cancellation-policy`, { token });
  check('cancellation policy returns 200', policy.status === 200, policy.body);
  check('Pending booking cancels free', policy.body?.data?.estimatedFee === 0, policy.body?.data);

  const noReason = await call('POST', `/bookings/${bookingId}/cancel`, { token, body: {} });
  check('cancel without a reason is rejected', noReason.status === 400, noReason.body);

  const cancelled = await call('POST', `/bookings/${bookingId}/cancel`, {
    token,
    body: { reason: 'Plans changed', remarks: 'Smoke test' },
  });
  check('cancel returns 200', cancelled.status === 200, cancelled.body);
  check('status becomes Cancelled', cancelled.body?.data?.booking?.bookingStatus === 'Cancelled', cancelled.body?.data?.booking);
  check('no fee for a Pending cancellation', cancelled.body?.data?.cancellationFee === 0, cancelled.body?.data);
  check('cancellation reason is stored', cancelled.body?.data?.booking?.cancellation?.reason === 'Plans changed', cancelled.body?.data?.booking?.cancellation);

  const doubleCancel = await call('POST', `/bookings/${bookingId}/cancel`, {
    token,
    body: { reason: 'Plans changed' },
  });
  check(
    'cancelling twice returns a conflict',
    doubleCancel.status === 409 && doubleCancel.body?.code === 'BOOKING_ALREADY_CANCELLED',
    doubleCancel.body
  );

  const policyAfter = await call('GET', `/bookings/${bookingId}/cancellation-policy`, { token });
  check(
    'cancellation policy on a cancelled booking is a conflict',
    policyAfter.status === 409,
    policyAfter.body
  );

  const cancelledTab = await call('GET', '/bookings?tab=cancelled', { token });
  check(
    'cancelled booking appears in the Cancelled tab',
    (cancelledTab.body?.data?.items || []).some((b) => b.id === bookingId),
    cancelledTab.body?.data?.items?.length
  );

  section('Notifications');
  const notifications = await call('GET', '/notifications', { token });
  check('notifications list returns 200', notifications.status === 200, notifications.body);
  const types = (notifications.body?.data?.items || []).map((n) => n.type);
  check('registration produced a notification', types.includes('account'), types);
  check('booking creation produced a notification', types.includes('booking_created'), types);
  check('cancellation produced a notification', types.includes('booking_cancelled'), types);

  const unread = await call('GET', '/notifications/unread-count', { token });
  check('unread count is positive', unread.body?.data?.unreadCount > 0, unread.body?.data);

  const firstNotification = notifications.body?.data?.items?.[0]?.id;
  const markRead = await call('POST', `/notifications/${firstNotification}/read`, { token });
  check('marking read works', markRead.body?.data?.notification?.isRead === true, markRead.body);

  const readAll = await call('POST', '/notifications/read-all', { token });
  check('read-all returns a count', typeof readAll.body?.data?.markedCount === 'number', readAll.body);
  const unreadAfter = await call('GET', '/notifications/unread-count', { token });
  check('unread count is zero after read-all', unreadAfter.body?.data?.unreadCount === 0, unreadAfter.body?.data);

  section('Password reset');
  const forgot = await call('POST', '/auth/forgot-password', { body: { phone: uniquePhone } });
  check('forgot-password returns 200', forgot.status === 200, forgot.body);

  const forgotUnknown = await call('POST', '/auth/forgot-password', { body: { phone: '+919999999997' } });
  check(
    'forgot-password is neutral for unknown accounts',
    forgotUnknown.status === 200 && forgotUnknown.body?.message === forgot.body?.message,
    { known: forgot.body?.message, unknown: forgotUnknown.body?.message }
  );

  const resetVerify = await call('POST', '/auth/verify-otp', {
    body: { phone: uniquePhone, purpose: 'reset_password', otp: forgot.body?.data?.devOtp },
  });
  const newPassword = 'NewPassword456';
  const reset = await call('POST', '/auth/reset-password', {
    body: {
      phone: uniquePhone,
      verificationToken: resetVerify.body?.data?.verificationToken,
      password: newPassword,
      confirmPassword: newPassword,
    },
  });
  check('reset-password returns a new session', reset.status === 200 && typeof reset.body?.data?.accessToken === 'string', reset.body);

  const oldTokenAfterReset = await call('GET', '/customers/me', { token });
  check(
    'tokens issued before the reset are revoked',
    oldTokenAfterReset.status === 401 && oldTokenAfterReset.body?.code === 'TOKEN_REVOKED',
    oldTokenAfterReset.body
  );

  const oldPasswordLogin = await call('POST', '/auth/login', { body: { phone: uniquePhone, password } });
  check('old password no longer works', oldPasswordLogin.status === 401, oldPasswordLogin.body);

  const newPasswordLogin = await call('POST', '/auth/login', { body: { phone: uniquePhone, password: newPassword } });
  check('new password works', newPasswordLogin.status === 200, newPasswordLogin.body);
  const finalToken = newPasswordLogin.body?.data?.accessToken;

  section('Logout');
  const logout = await call('POST', '/auth/logout', {
    token: finalToken,
    body: { refreshToken: newPasswordLogin.body?.data?.refreshToken },
  });
  check('logout returns 200', logout.status === 200, logout.body);
  const usedRefresh = await call('POST', '/auth/refresh-token', {
    body: { refreshToken: newPasswordLogin.body?.data?.refreshToken },
  });
  check('a revoked refresh token cannot be used', usedRefresh.status === 401, usedRefresh.body);

  section('Validation and errors');
  const badJson = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  const badJsonBody = await badJson.json().catch(() => ({}));
  check('malformed JSON returns a clean error', badJson.status === 400 && badJsonBody.code === 'MALFORMED_JSON', badJsonBody);

  const unknownRoute = await call('GET', '/does-not-exist');
  check('unknown route returns 404 ROUTE_NOT_FOUND', unknownRoute.status === 404 && unknownRoute.body?.code === 'ROUTE_NOT_FOUND', unknownRoute.body);

  const badEnum = await call('POST', '/bookings', {
    token: finalToken,
    body: { vehicleTypeId: sedanId, pickup: PICKUP, destination: DESTINATION, paymentMethod: 'Bitcoin' },
  });
  check('invalid payment method is rejected with field detail', badEnum.status === 400 && badEnum.body?.details?.fields?.paymentMethod, badEnum.body);

  const missingFields = await call('POST', '/auth/register', { body: {} });
  check('empty register body reports per-field errors', missingFields.status === 400 && Object.keys(missingFields.body?.details?.fields || {}).length >= 2, missingFields.body);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`PASSED: ${pass}   FAILED: ${fail}`);
  if (fail) {
    console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  }
  console.log('='.repeat(60));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
