import { MongoClient } from 'mongodb';
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';

// The native driver rather than an ODM: everything we put in Mongo is
// write-heavy, schemaless audit data, so a schema layer would only get in the way.
const client = new MongoClient(config.mongo.url, {
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 10,
});

let db = null;

export async function connectMongo() {
  await client.connect();
  db = client.db(config.mongo.db);
  await db.collection('activity_logs').createIndexes([
    { key: { orderId: 1, ts: -1 }, name: 'order_recent' },
    { key: { ts: -1 }, name: 'recent' },
    { key: { actorId: 1, ts: -1 }, name: 'actor_recent' },
    // Audit data is useful for a while, not forever: 90-day rolling retention.
    { key: { ts: 1 }, name: 'ttl_90d', expireAfterSeconds: 60 * 60 * 24 * 90 },
  ]);
  logger.info('mongo.connected', { db: config.mongo.db });
  return db;
}

export const getDb = () => {
  if (!db) throw new Error('Mongo has not been connected yet');
  return db;
};

export const isMongoReady = () => db !== null;

export async function pingMongo() {
  await client.db(config.mongo.db).command({ ping: 1 });
}

export const closeMongo = () => client.close();
