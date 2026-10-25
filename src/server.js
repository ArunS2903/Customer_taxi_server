'use strict';

const http = require('http');

const { env, assertRequiredConfig, configWarnings } = require('./config/env');
const logger = require('./config/logger');
const { connectDatabase, disconnectDatabase } = require('./config/db');
const { createApp } = require('./app');
const { initSocket } = require('./services/socket');

// Importing the models before syncIndexes() runs in connectDatabase() is what
// registers them with the connection, so the indexes actually get built.
require('./models/Customer');
require('./models/Otp');
require('./models/RefreshToken');
require('./models/VehicleType');
require('./models/FareRule');
require('./models/Booking');
require('./models/BusinessContact');
require('./models/Notification');
require('./models/Counter');

let server;

async function start() {
  // Fail before opening a port rather than serving 500s for every request.
  assertRequiredConfig();

  for (const warning of configWarnings()) {
    logger.warn(`CONFIG: ${warning}`);
  }

  await connectDatabase();

  const app = createApp();
  server = http.createServer(app);
  initSocket(server);

  // Bind publicly for cloud web-service hosts (which route traffic to the
  // service's PORT). The omitted host can bind an IPv6-only listener on some
  // platforms, making an otherwise healthy service unreachable over IPv4.
  await new Promise((resolve) => server.listen(env.port, '0.0.0.0', resolve));

  logger.info(`Taxi Customer API listening on port ${env.port} (${env.nodeEnv})`);
  logger.info(`Base URL: http://localhost:${env.port}${env.apiPrefix}`);
}

/**
 * Stops accepting connections, lets in-flight requests finish, then closes the
 * database. The 10s cap stops a hung request from blocking a deploy forever.
 */
async function shutdown(signal) {
  logger.info(`${signal} received, shutting down.`);

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 10s, exiting.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectDatabase();
    logger.info('Shutdown complete.');
    process.exit(0);
  } catch (err) {
    logger.error(`Error during shutdown: ${err.message}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  // The process state is no longer trustworthy after this; log and let the
  // supervisor restart us.
  logger.error('Uncaught exception:', err.stack || err.message);
  process.exit(1);
});

start().catch((err) => {
  logger.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
