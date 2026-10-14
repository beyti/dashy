/**
 * MongoDB persistence for per-user override documents.
 * One client per process, reused across requests (the driver pools connections
 * internally). Optimistic concurrency via a per-document `revision`, enforced with
 * atomic compare-and-set updates - no transactions needed since every write only
 * ever touches the one document for the caller's own identity.
 *
 * `preferences` is stored as an opaque JSON string, not a native subdocument:
 * stableIds (and therefore `linkOrderBySection` object keys) allow '.' characters,
 * which are unsafe as literal BSON field names. The app never queries inside
 * preferences server-side, so there's nothing to gain from storing it unpacked.
 */
const { MongoClient } = require('mongodb');
const { migrateStoredPreferences, SCHEMA_VERSION } = require('./preferences');

class RevisionConflictError extends Error {
  constructor(currentRevision) {
    super('Preferences were changed elsewhere');
    this.status = 409;
    this.currentRevision = currentRevision;
  }
}

const log = (msg) => console.log(`[personalization] ${msg}`);

const docToRecord = (doc) => {
  if (!doc) return null;
  let preferences;
  try {
    preferences = migrateStoredPreferences(JSON.parse(doc.preferencesJson), doc.schemaVersion);
  } catch (e) {
    log(`Stored preferences unreadable, serving defaults: ${e.message}`);
    preferences = null;
  }
  return {
    revision: doc.revision,
    preferences,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

/**
 * @param uri MongoDB connection string
 * @param opts { dbName }
 */
function openStore(uri, { dbName = 'dashy' } = {}) {
  const client = new MongoClient(uri);

  const ready = client.connect()
    .then(async () => {
      const collection = client.db(dbName).collection('user_preferences');
      await collection.createIndex({ identityKey: 1 }, { unique: true });
      log('Connected to MongoDB');
      return collection;
    })
    .catch((e) => {
      log(`Failed to connect to MongoDB: ${e.message}`);
      throw e;
    });

  return {
    /* Returns { revision, preferences, createdAt, updatedAt } or null when never saved */
    async get(identityKey) {
      const collection = await ready;
      return docToRecord(await collection.findOne({ identityKey }));
    },

    /* Revision 0 means "I believe nothing is stored yet". Returns the new record */
    async save(identityKey, preferences, expectedRevision) {
      const collection = await ready;
      const preferencesJson = JSON.stringify(preferences);
      const now = new Date();

      if (expectedRevision === 0) {
        try {
          await collection.insertOne({
            identityKey, schemaVersion: SCHEMA_VERSION, revision: 1, preferencesJson, createdAt: now, updatedAt: now,
          });
        } catch (e) {
          if (e.code !== 11000) throw e; // 11000 = duplicate key, i.e. a real revision conflict
          const current = await collection.findOne({ identityKey });
          throw new RevisionConflictError(current ? current.revision : 0);
        }
        return docToRecord(await collection.findOne({ identityKey }));
      }

      const result = await collection.updateOne(
        { identityKey, revision: expectedRevision },
        { $set: { preferencesJson, schemaVersion: SCHEMA_VERSION, updatedAt: now }, $inc: { revision: 1 } },
      );
      if (result.matchedCount === 0) {
        const current = await collection.findOne({ identityKey });
        throw new RevisionConflictError(current ? current.revision : 0);
      }
      return docToRecord(await collection.findOne({ identityKey }));
    },

    /* Clears a user's overrides. Revision is checked so a stale tab can't wipe newer changes */
    async remove(identityKey, expectedRevision) {
      const collection = await ready;
      const result = await collection.deleteOne({ identityKey, revision: expectedRevision });
      if (result.deletedCount === 1) return { revision: 0 };
      const current = await collection.findOne({ identityKey });
      if (expectedRevision === 0 && !current) return { revision: 0 }; // nothing to delete, as expected
      throw new RevisionConflictError(current ? current.revision : 0);
    },

    /* Cheap readiness probe for health checks */
    async isHealthy() {
      try {
        await (await ready).estimatedDocumentCount();
        return true;
      } catch { return false; }
    },

    async close() { await client.close(); },
  };
}

module.exports = { openStore, RevisionConflictError };
