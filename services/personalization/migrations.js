/**
 * Ordered, append-only list of database migrations.
 * Never edit a shipped migration; add a new one with the next version number.
 */
module.exports = [
  {
    version: 1,
    name: 'create user_preferences',
    sql: `
      CREATE TABLE user_preferences (
        identity_key TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        preferences_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `,
  },
];
