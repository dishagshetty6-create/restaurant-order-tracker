import { getDb, isMongoReady } from '../db/mongo.js';
import { logger } from '../lib/logger.js';

/**
 * Append-only activity trail, stored in MongoDB.
 *
 * Why Mongo and not Postgres: this is high-volume, write-only, never joined, and
 * the shape differs per event type (a rejected transition carries different
 * fields from a login). That is exactly the workload a document store is good
 * at, and keeping it out of Postgres means audit writes never contend with the
 * transactional tables that the concurrency control depends on.
 *
 * Failures here are swallowed on purpose: losing an audit line is bad, but
 * failing a customer's order because the audit database hiccuped is worse.
 */
export async function record(event) {
  if (!isMongoReady()) {
    logger.warn('activity.skipped_mongo_down', { type: event.type });
    return;
  }
  try {
    await getDb().collection('activity_logs').insertOne({ ...event, ts: new Date() });
  } catch (err) {
    logger.warn('activity.write_failed', { type: event.type, error: err.message });
  }
}

export async function listForOrder(orderId, limit = 50) {
  if (!isMongoReady()) return [];
  try {
    return await getDb()
      .collection('activity_logs')
      .find({ orderId })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    logger.warn('activity.read_failed', { orderId, error: err.message });
    return [];
  }
}

export async function listRecent(limit = 100) {
  if (!isMongoReady()) return [];
  try {
    return await getDb().collection('activity_logs').find({}).sort({ ts: -1 }).limit(limit).toArray();
  } catch (err) {
    logger.warn('activity.read_failed', { error: err.message });
    return [];
  }
}
