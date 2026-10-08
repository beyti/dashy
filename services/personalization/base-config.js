/**
 * Loads the authoritative company config (conf.yml), normalizes stable IDs,
 * and re-reads it when the file changes on disk (deploy / bind-mount update).
 * Read-only: nothing in the personalization layer ever writes conf.yml.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('../utils/yaml');
const { normalizeStableIds } = require('./stable-ids');

const STAT_INTERVAL_MS = 1000;

const confPath = () => path.resolve(
  __dirname, '..', '..', process.env.USER_DATA_DIR || 'user-data', 'conf.yml',
);

let cache = null; // { file, mtimeMs, size, checkedAt, value }

const log = (msg) => console.warn(`[personalization] ${msg}`);

function readBase(file) {
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('conf.yml must be a YAML mapping');
  const { sections, warnings } = normalizeStableIds(Array.isArray(raw.sections) ? raw.sections : []);
  warnings.slice(0, 20).forEach((w) => log(w));
  if (warnings.length > 20) log(`...and ${warnings.length - 20} more stableId warnings`);
  if (warnings.length) log('Run `node services/personalization/assign-stable-ids.js` and commit conf.yml');
  return { config: raw, sections, warnings };
}

/* Returns { config, sections, warnings }. Throws if conf.yml is unreadable and was never loaded */
function getBaseConfig({ force = false } = {}) {
  const file = confPath();
  const now = Date.now();
  if (!force && cache && cache.file === file && now - cache.checkedAt < STAT_INTERVAL_MS) {
    return cache.value;
  }
  try {
    const stat = fs.statSync(file);
    if (!force && cache && cache.file === file
      && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      cache.checkedAt = now;
      return cache.value;
    }
    const value = readBase(file);
    cache = {
      file, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now, value,
    };
    return value;
  } catch (e) {
    // Keep serving the last good config if a deploy briefly leaves a broken/missing file
    if (cache && cache.file === file) {
      log(`Could not reload conf.yml, keeping previous version: ${e.message}`);
      cache.checkedAt = now;
      return cache.value;
    }
    throw e;
  }
}

/* Stable hash of what a given user is allowed to see, so clients can detect base changes */
const revisionOf = (sections) => crypto.createHash('sha256')
  .update(JSON.stringify(sections)).digest('hex').slice(0, 16);

const resetBaseConfigCache = () => { cache = null; };

module.exports = { getBaseConfig, revisionOf, resetBaseConfigCache };
