// @vitest-environment node
import { MongoClient } from 'mongodb';
import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import { openStore, RevisionConflictError } from '../../services/personalization/db';
import { emptyPreferences, SCHEMA_VERSION } from '../../services/personalization/preferences';
import { startMongoMemory } from './helpers/mongo-memory';

let mongo;
let rawClient;
let dbCounter = 0;

beforeAll(async () => {
  mongo = await startMongoMemory();
  rawClient = new MongoClient(mongo.uri);
  await rawClient.connect();
});

afterAll(async () => {
  await rawClient.close();
  await mongo.stop();
});

/* Each test gets its own database on the shared mongod, so they can't interfere */
const freshDbName = () => `dashy-test-${dbCounter++}`;
const prefs = (hidden) => ({ ...emptyPreferences(), hiddenGlobalLinkIds: hidden });

describe('MongoDB preference store', () => {
  it('creates a unique index on identityKey, idempotently across reconnects', async () => {
    const dbName = freshDbName();
    const store = await (async () => {
      const s = openStore(mongo.uri, { dbName });
      await s.isHealthy(); // forces the connect + createIndex to complete
      return s;
    })();
    const indexes = await rawClient.db(dbName).collection('user_preferences').indexes();
    const identityIndex = indexes.find((i) => i.key.identityKey === 1);
    expect(identityIndex.unique).toBe(true);
    await store.close();
    // Reopening against the same database doesn't error on the already-existing index
    const again = openStore(mongo.uri, { dbName });
    expect(await again.isHealthy()).toBe(true);
    await again.close();
  });

  it('isolates records by identity key', async () => {
    const store = openStore(mongo.uri, { dbName: freshDbName() });
    await store.save('iss\u0000alice', prefs(['x']), 0);
    expect(await store.get('iss\u0000bob')).toBeNull();
    expect(await store.get('other-iss\u0000alice')).toBeNull();
    expect((await store.get('iss\u0000alice')).preferences.hiddenGlobalLinkIds).toEqual(['x']);
    await store.close();
  });

  it('enforces optimistic revisions on save and delete', async () => {
    const store = openStore(mongo.uri, { dbName: freshDbName() });
    expect((await store.save('k', prefs(['a']), 0)).revision).toBe(1);
    expect((await store.save('k', prefs(['b']), 1)).revision).toBe(2);
    await expect(store.save('k', prefs(['c']), 1)).rejects.toThrow(RevisionConflictError);
    try { await store.save('k', prefs(['c']), 1); } catch (e) { expect(e.currentRevision).toBe(2); }
    await expect(store.save('new', prefs([]), 5)).rejects.toThrow(RevisionConflictError);
    await expect(store.remove('k', 1)).rejects.toThrow(RevisionConflictError);
    expect((await store.get('k')).preferences.hiddenGlobalLinkIds).toEqual(['b']);
    await store.remove('k', 2);
    expect(await store.get('k')).toBeNull();
    await store.close();
  });

  it('removing a never-saved identity with expectedRevision 0 is a no-op, not an error', async () => {
    const store = openStore(mongo.uri, { dbName: freshDbName() });
    await expect(store.remove('never-existed', 0)).resolves.toEqual({ revision: 0 });
    await store.close();
  });

  it('survives client close + reopen against the same database', async () => {
    const dbName = freshDbName();
    const s1 = openStore(mongo.uri, { dbName });
    await s1.save('k', prefs(['keep']), 0);
    await s1.close();
    const s2 = openStore(mongo.uri, { dbName });
    await expect(s2.get('k')).resolves.toMatchObject({ revision: 1, preferences: { hiddenGlobalLinkIds: ['keep'] } });
    await s2.close();
  });

  it('serves defaults instead of crashing on a corrupt stored document', async () => {
    const dbName = freshDbName();
    const store = openStore(mongo.uri, { dbName });
    await store.save('k', prefs([]), 0);
    await rawClient.db(dbName).collection('user_preferences')
      .updateOne({ identityKey: 'k' }, { $set: { preferencesJson: '{not json' } });
    await expect(store.get('k')).resolves.toMatchObject({ revision: 1, preferences: null });
    await store.close();
  });

  it('serves defaults rather than refusing to start on a schema version newer than this app supports', async () => {
    // Unlike the old single-writer SQLite file, a shared Mongo collection can have multiple
    // app versions reading it during a rolling k8s deploy - refusing to boot isn't an option,
    // so an unrecognized per-document schema version degrades to empty preferences instead
    const dbName = freshDbName();
    const store = openStore(mongo.uri, { dbName });
    await store.save('k', prefs(['x']), 0);
    await rawClient.db(dbName).collection('user_preferences')
      .updateOne({ identityKey: 'k' }, { $set: { schemaVersion: SCHEMA_VERSION + 1 } });
    await expect(store.get('k')).resolves.toMatchObject({ revision: 1, preferences: null });
    expect(await store.isHealthy()).toBe(true);
    await store.close();
  });

  it('treats identity keys as literal string data, never as query operators', async () => {
    const store = openStore(mongo.uri, { dbName: freshDbName() });
    const evil = '$where: this.revision > 0';
    await store.save(evil, prefs([]), 0);
    expect((await store.get(evil)).revision).toBe(1);
    expect(await store.get('$where')).toBeNull();
    expect(await store.isHealthy()).toBe(true);
    await store.close();
  });
});
