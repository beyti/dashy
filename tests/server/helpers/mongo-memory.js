/**
 * Shared in-memory MongoDB for tests - a real mongod binary, not a mock, so the
 * same correctness guarantees (unique index enforcement, atomic updates) apply.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

async function startMongoMemory() {
  const mongod = await MongoMemoryServer.create();
  return { uri: mongod.getUri(), stop: () => mongod.stop() };
}

module.exports = { startMongoMemory };
