#!/usr/bin/env node
/**
 * Takes a consistent online snapshot of the personalization DB with `VACUUM INTO`,
 * safe while the app is running (unlike copying the .sqlite / -wal files).
 *
 *   node services/personalization/backup.js [destination]
 *   default destination: <DATABASE_PATH dir>/backups/tools-<timestamp>.sqlite
 */
const path = require('path');
const { openStore } = require('./db');

if (require.main === module) {
  const dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, '..', '..', 'data', 'tools.sqlite');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.resolve(process.argv[2] || path.join(path.dirname(dbPath), 'backups', `tools-${stamp}.sqlite`));
  const store = openStore(dbPath);
  try {
    store.backup(dest);
    console.log(`Backup written to ${dest}`);
  } finally {
    store.close();
  }
}
