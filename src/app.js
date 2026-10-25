'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');

const { env } = require('./config/env');
const logger = require('./config/logger');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { globalLimiter } = require('./middleware/rateLimit');

function createApp() {
  const app = express();

  // Needed for req.ip to be the client address rather than the proxy's when
  // deployed behind nginx / a platform load balancer. Without it the rate
  // limiters would key every request to the same address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());

  /**
   * CORS applies to the Admin Web App and any browser-based tooling. A Flutter
   * mobile client sends no Origin header, so requests with no origin are
   * allowed through - blocking them would break the app while stopping nobody,
   * since a non-browser caller can set any origin it likes.
   */
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (!env.corsOrigins.length) return callback(null, true);
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
      },
      credentials: true,
    })
  );

  app.use(compression());

  // 100kb is generous for every endpoint here; the largest body is a booking.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  app.use(
    morgan(env.isProduction ? 'combined' : 'dev', {
      stream: { write: (message) => logger.info(message.trim()) },
      // Health checks every few seconds would drown the log.
      skip: (req) => req.path.endsWith('/public/health'),
    })
  );

  app.use(globalLimiter);

  app.get('/', (req, res) =>
    res.json({
      success: true,
      message: 'Taxi Customer API',
      data: { apiPrefix: env.apiPrefix, health: `${env.apiPrefix}/public/health` },
    })
  );

  app.use(env.apiPrefix, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
