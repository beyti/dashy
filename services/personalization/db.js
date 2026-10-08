/**
 * SQLite persistence for per-user override documents, via Node's built-in node:sqlite.
 * One writer process (single container). WAL mode, versioned migrations on open,
 * optimistic concurrency through a per-row `revision` checked inside a transaction.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const MIGRATIONS = require('./migrations');
const { migrateStoredPreferences, SCHEMA_VERSION } = require('./preferences');

class RevisionConflictError extends Error {
  constructor(currentRevision) {
    super('Preferences were changed elsewhere');
    this.status = 409;
    this.currentRevision = currentRevision;
  }
}

const log = (msg) => console.log(`[personalization] ${msg}`);

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const newest = Math.max(0, ...applied);
  const known = Math.max(0, ...MIGRATIONS.map((m) => m.version));
  if (newest > known) {
    throw new Error(`Database schema v${newest} is newer than this app supports (v${known}). Refusing to start.`);
  }
  MIGRATIONS.filter((m) => !applied.has(m.version)).forEach((m) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      db.exec('COMMIT');
      log(`Applied DB migration ${m.version}: ${m.name}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });
}

/* Runs fn inside BEGIN IMMEDIATE, so the read-check-write is atomic against other writers */
const inTransaction = (db, fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
};

function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o750 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  runMigrations(db);
  if (dbPath !== ':memory:') {
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort, e.g. read-only mount */ }
  }

  const selectStmt = db.prepare(
    'SELECT revision, schema_version, preferences_json, created_at, updated_at FROM user_preferences WHERE identity_key = ?',
  );
  const insertStmt = db.prepare(
    'INSERT INTO user_preferences (identity_key, schema_version, revision, preferences_json) VALUES (?, ?, 1, ?)',
  );
  const updateStmt = db.prepare(`UPDATE user_preferences
    SET preferences_json = ?, schema_version = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE identity_key = ? AND revision = ?`);
  const deleteStmt = db.prepare('DELETE FROM user_preferences WHERE identity_key = ?');

  const rowToRecord = (row) => {
    if (!row) return null;
    let preferences;
    try {
      preferences = migrateStoredPreferences(JSON.parse(row.preferences_json), row.schema_version);
    } catch (e) {
      log(`Stored preferences unreadable, serving defaults: ${e.message}`);
      preferences = null;
    }
    return {
      revision: row.revision,
      preferences,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  return {
    /* Returns { revision, preferences, createdAt, updatedAt } or null when never saved */
    get(identityKey) {
      return rowToRecord(selectStmt.get(identityKey));
    },

    /* Revision 0 means "I believe nothing is stored yet". Returns the new record */
    save(identityKey, preferences, expectedRevision) {
      const json = JSON.stringify(preferences);
      return inTransaction(db, () => {
        const current = selectStmt.get(identityKey);
        const currentRevision = current ? current.revision : 0;
        if (currentRevision !== expectedRevision) throw new RevisionConflictError(currentRevision);
        if (current) updateStmt.run(json, SCHEMA_VERSION, identityKey, expectedRevision);
        else insertStmt.run(identityKey, SCHEMA_VERSION, json);
        return rowToRecord(selectStmt.get(identityKey));
      });
    },

    /* Clears a user's overrides. Revision is checked so a stale tab can't wipe newer changes */
    remove(identityKey, expectedRevision) {
      return inTransaction(db, () => {
        const current = selectStmt.get(identityKey);
        const currentRevision = current ? current.revision : 0;
        if (currentRevision !== expectedRevision) throw new RevisionConflictError(currentRevision);
        if (current) deleteStmt.run(identityKey);
        return { revision: 0 };
      });
    },

    /* Cheap readiness probe for health checks */
    isHealthy() {
      try { return db.prepare('SELECT 1 AS ok').get().ok === 1; } catch { return false; }
    },

    /* Consistent online snapshot (safe while WAL is active). Destination must not exist */
    backup(destination) {
      if (fs.existsSync(destination)) throw new Error(`Backup target already exists: ${destination}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      db.prepare('VACUUM INTO ?').run(destination);
      try { fs.chmodSync(destination, 0o600); } catch { /* best effort */ }
      return destination;
    },

    schemaVersion() {
      return db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    },

    close() { db.close(); },
  };
}

module.exports = { openStore, RevisionConflictError };
