'use strict';

const mongoose = require('mongoose');
const { env } = require('./env');
const logger = require('./logger');

mongoose.set('strictQuery', true);

async function connectDatabase() {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('error', (err) => logger.error('MongoDB error', err.message));

  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 20,
  });

  // Build the indexes declared on the schemas. In production this is usually a
  // deploy step instead, but the collections here are small enough to do at boot.
  await Promise.all(
    Object.values(mongoose.connection.models).map((model) => model.syncIndexes().catch((err) => {
      logger.warn(`Index sync failed for ${model.modelName}: ${err.message}`);
    }))
  );

  return mongoose.connection;
}

async function disconnectDatabase() {
  await mongoose.connection.close(false);
}

/** True when the deployment is a replica set / Atlas, i.e. transactions work. */
function supportsTransactions() {
  const topology = mongoose.connection.client?.topology;
  if (!topology) return false;
  const description = topology.description;
  return description?.type === 'ReplicaSetWithPrimary' || description?.type === 'Sharded';
}

module.exports = { connectDatabase, disconnectDatabase, supportsTransactions };
