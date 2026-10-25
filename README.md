# Backend — Taxi Customer API

Express + Mongoose REST API for the customer app. Writes bookings to MongoDB so
an Admin Web Application reading the same database can manage them.

Endpoint reference and JSON shapes: [`../docs/API.md`](../docs/API.md).

## Run it

```bash
npm install
cp .env.example .env     # then fill in MONGODB_URI and the two JWT secrets
npm run seed             # vehicle categories, fare rules, business contact
npm run dev              # watch mode on http://localhost:5000/api/v1
```

| Script | Does |
|---|---|
| `npm start` | Production start. |
| `npm run dev` | `node --watch`, restarts on edit. |
| `npm run seed` | Upserts the reference data the admin app owns. Idempotent. |
| `npm run seed -- --demo` | Also a demo customer (`+919876543210` / `Password123`) and one completed booking. |
| `npm test` | 57 unit tests. No database needed. |
| `npm run test:integration` | 108 assertions against a running server. |

`assertRequiredConfig()` runs before the HTTP listener opens, so a
misconfiguration fails at boot rather than turning every request into a 500. It
refuses to start if `MONGODB_URI` or either JWT secret is missing, if the two
secrets are identical, or — in production only — if `SMS_PROVIDER=mock` or
`GOOGLE_MAPS_SERVER_KEY` is empty.

At boot it prints a `CONFIG:` warning per integration running on a mock, so what
is live is visible at a glance:

```
WARN CONFIG: SMS_PROVIDER=mock - OTP codes are logged to the console, not texted.
WARN CONFIG: GOOGLE_MAPS_SERVER_KEY is empty - distances use the haversine estimator.
```

## Layout

```
src/
├── server.js          boot, graceful shutdown, signal handling
├── app.js             express assembly: helmet, cors, limits, routes
├── config/            env contract + validation, mongo connection, logger
├── constants/         domain.js — the enums that cross the API boundary
├── models/            Mongoose schemas; toPublicJSON controls what is exposed
├── middleware/        auth, zod validation, rate limits, error translation
├── services/          business logic (see below)
├── controllers/       HTTP handlers; thin, no business rules
├── routes/            route tables with the request shape in a comment
├── validators/        zod schemas — also the field whitelist
├── utils/             ApiError, ApiResponse, phone, password, ms
└── seed/              reference data
```

### The services

| Service | Responsibility |
|---|---|
| `fare.service` | The authoritative fare. Pure arithmetic in `priceRoute`, so it is cheap to call per category and easy to test. |
| `geo.service` | Measures routes via the Google Routes API, with a haversine fallback. Validates coordinates. |
| `booking.service` | Creation (idempotent), the cancellation compare-and-set, fee policy, listing. |
| `token.service` | JWT signing, refresh-token rotation and reuse detection. |
| `otp.service` | Issue, verify, and exchange for a one-use verification token. Owns the rate policy. |
| `notification.service` | Persist, emit over socket, then attempt push. Never throws into the caller. |
| `push.service` | FCM HTTP v1, implemented over `fetch` with a service-account JWT. |
| `socket.js` | Socket.IO rooms and emit helpers. |
| `sms.provider` / `email.provider` | One `send` function each, with a console mock and a real transport behind it. |

Adding another SMS gateway means one branch in `sms.provider.js` and one new
value for `SMS_PROVIDER`. Nothing outside that file changes.

## Design notes

**Nothing the client sends about money or identity is trusted.** zod schemas
strip unknown keys, so extra fields in a request body cannot reach a document.
`customerId` comes from the token. Distance is measured server-side. The fare is
recomputed from the admin's `FareRule` at creation time, ignoring whatever the
client was shown. `bookingStatus` and `paymentStatus` always start at `Pending`.

**Secrets are never stored recoverably.** Passwords are bcrypt with cost 12.
OTP codes and refresh tokens are stored only as SHA-256 digests, so a database
leak hands out neither sessions nor codes. `passwordHash` and `devices` are
`select: false`, which keeps them out of query results by default rather than
relying on every call site to remember.

**`toPublicJSON()` is the exposure boundary.** Models decide their own public
shape; controllers never spread a raw document into a response. That is why
`GET /public/business-contact` cannot leak an internal field even if one is
added to the schema later.

**Error codes are the contract, messages are for humans.** `ApiError` carries a
stable `code`; the client switches on it. The error middleware also translates
Mongoose validation errors, cast errors and duplicate-key errors into the same
envelope, and names the offending field without echoing its value back.

**Booking codes come from an atomic counter.** `findOneAndUpdate` with `$inc` on
the `counters` collection, so two concurrent bookings can never draw the same
`TX-NNNNNN`. The one duplicate case that should be impossible is still handled
with a single retry rather than failing the customer's booking.

**No transactions.** Booking creation is a single document insert, and
cancellation is a single conditional update, so neither needs one. That keeps the
API working against a standalone `mongod` as well as a replica set.

## Testing

```bash
npm test                 # 57 unit tests, no database
```

Covers the fare arithmetic in detail — the order of operations, the minimum-fare
floor, surge and night surcharge (including a window wrapping midnight and the
exclusive end hour), flat fees landing after multipliers, waiting-time
allowance, and that the breakdown always sums to the subtotal. Also phone
normalisation against the client's copy of the same rules, password policy,
haversine distance, coordinate validation, and the duration parser.

```bash
npm run seed && npm run dev    # one shell
npm run test:integration       # another
```

Needs `SMS_PROVIDER=mock`, because it reads the `devOtp` the server only returns
when SMS is mocked. Creates fresh clock-keyed accounts each run, so it is safe to
re-run; it never deletes data. Point it elsewhere with `API_BASE_URL`.

The assertions worth knowing about:

- a booking submitted with `estimatedFare: 1`, `bookingStatus: "Completed"`,
  `paymentStatus: "Paid"`, a forged `customerId` and a forged `bookingCode` — all
  five ignored
- five concurrent identical submissions producing exactly one booking
- a second customer getting 404 on both read and cancel of someone else's booking
- the fare breakdown's components summing to the subtotal, and the total being
  subtotal + tax rounded
- a reused refresh token returning `REFRESH_TOKEN_REUSED`
- a password reset making previously issued access tokens return `TOKEN_REVOKED`
- `forgot-password` returning byte-identical messages for known and unknown
  accounts

## Deployment notes

- Set `NODE_ENV=production`. That alone tightens the rate limits, hides stack
  traces, and makes the mock SMS provider and a missing Maps key fatal at boot.
- Terminate TLS in front of the app. `trust proxy` is set to 1, so `req.ip` is
  the client address behind one proxy — adjust if you have more hops, or the rate
  limiters will key every request to the same address.
- `CORS_ORIGINS` is for the Admin Web App. Mobile clients send no `Origin`, and
  requests without one are allowed through: blocking them would break the app
  while stopping nobody, since a non-browser caller can set any origin it likes.
- Indexes are built at boot via `syncIndexes()`. Fine for collections this size;
  move it to a deploy step if they grow.
- `SIGTERM` and `SIGINT` stop the listener, let in-flight requests finish, then
  close the database, with a 10s cap so a hung request cannot block a deploy.
- Replace the seeded business contact before taking real bookings — it ships
  with placeholder numbers, and the seed logs a warning saying so.
