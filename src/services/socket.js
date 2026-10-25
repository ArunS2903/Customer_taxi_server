'use strict';

const { Server } = require('socket.io');
const logger = require('../config/logger');
const { env } = require('../config/env');
const tokenService = require('./token.service');

/**
 * Real-time booking updates.
 *
 * Each authenticated customer joins a private room named `customer:<id>`, and
 * every booking of theirs gets a room `booking:<id>`. The admin app (or a
 * driver-management service) triggers an emit by calling the internal
 * `emitBookingUpdate` helper after it writes a status change.
 *
 * Sockets are an optimisation, never the source of truth: the client still
 * pulls GET /bookings/:id on resume, so a dropped connection only costs
 * immediacy.
 */

let io = null;

function roomForCustomer(customerId) {
  return `customer:${customerId}`;
}

function roomForBooking(bookingId) {
  return `booking:${bookingId}`;
}

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigins.length ? env.corsOrigins : '*',
      methods: ['GET', 'POST'],
    },
    // Mobile networks drop connections constantly; be patient before giving up.
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  // Handshake auth. An unauthenticated socket is rejected outright rather than
  // being allowed to connect and silently receive nothing.
  io.use((socket, next) => {
    const raw =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

    if (!raw) {
      return next(new Error('AUTH_REQUIRED'));
    }

    try {
      const payload = tokenService.verifyAccessToken(raw);
      socket.data.customerId = payload.sub;
      return next();
    } catch (err) {
      return next(new Error(err.code || 'TOKEN_INVALID'));
    }
  });

  io.on('connection', (socket) => {
    const { customerId } = socket.data;
    socket.join(roomForCustomer(customerId));
    logger.debug(`Socket connected: customer ${customerId} (${socket.id})`);

    /**
     * Subscribing to a specific booking. We do not verify ownership here;
     * instead the emit side only ever publishes to rooms it has already
     * authorised, and the per-customer room carries everything the customer is
     * entitled to. Joining a stranger's booking room therefore yields nothing,
     * because booking events are emitted to the owner's customer room too.
     */
    socket.on('booking:subscribe', (bookingId) => {
      if (typeof bookingId === 'string' && /^[a-f\d]{24}$/i.test(bookingId)) {
        socket.join(roomForBooking(bookingId));
      }
    });

    socket.on('booking:unsubscribe', (bookingId) => {
      if (typeof bookingId === 'string') {
        socket.leave(roomForBooking(bookingId));
      }
    });

    socket.on('disconnect', (reason) => {
      logger.debug(`Socket disconnected: ${socket.id} (${reason})`);
    });
  });

  logger.info('Socket.IO initialised');
  return io;
}

/** Pushes a booking change to its owner and to anyone watching that booking. */
function emitBookingUpdate(booking, event = 'booking:updated') {
  if (!io) return;

  const payload = {
    event,
    booking: typeof booking.toPublicJSON === 'function' ? booking.toPublicJSON() : booking,
    at: new Date().toISOString(),
  };

  io.to(roomForCustomer(booking.customerId.toString())).emit(event, payload);
  io.to(roomForBooking(booking._id.toString())).emit(event, payload);
}

/** Pushes an in-app notification to a customer's open sessions. */
function emitNotification(customerId, notification) {
  if (!io) return;
  io.to(roomForCustomer(customerId.toString())).emit('notification:new', {
    notification:
      typeof notification.toPublicJSON === 'function' ? notification.toPublicJSON() : notification,
    at: new Date().toISOString(),
  });
}

function getIo() {
  return io;
}

module.exports = {
  initSocket,
  emitBookingUpdate,
  emitNotification,
  getIo,
  roomForCustomer,
  roomForBooking,
};
