'use strict';

const { env } = require('./env');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[env.isProduction ? 'info' : 'debug'];

function emit(level, args) {
  if (LEVELS[level] > threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
  // eslint-disable-next-line no-console
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line, ...args);
}

module.exports = {
  error: (...args) => emit('error', args),
  warn: (...args) => emit('warn', args),
  info: (...args) => emit('info', args),
  debug: (...args) => emit('debug', args),
};
