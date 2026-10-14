/**
 * Enterprise personalization (fork feature), off unless ENABLE_USER_OVERRIDES=true
 * Wires the MongoDB-backed store, /api/me router, and the hardening hooks used by app.js.
 * See docs/personal-overrides.md
 */
const { openStore } = require('./db');
const { getBaseConfig } = require('./base-config');
const { createPersonalRouter } = require('./routes');

const isEnabled = () => process.env.ENABLE_USER_OVERRIDES === 'true';

const warn = (msg) => console.warn(`\x1b[103m\x1b[34m[personalization] ${msg}\x1b[0m`);

/**
 * @param opts { authMode, oidcSettings, headerName, protectConfig }
 * @returns null when disabled, else { router, store, diskWriteGate, isHealthy }
 */
function setupPersonalization(opts) {
  if (!isEnabled()) return null;
  const { authMode } = opts;
  if (authMode === 'none') {
    warn('ENABLE_USER_OVERRIDES is on but no server-side auth is configured. '
      + 'All /api/me requests will be rejected (401). Configure OIDC, Keycloak, '
      + 'trusted header auth, or ENABLE_HTTP_AUTH.');
  } else if (authMode === 'basic-conf' || authMode === 'basic-env') {
    warn('Personal overrides are keyed on the HTTP basic-auth username. Prefer OIDC for stable identities.');
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('ENABLE_USER_OVERRIDES is on but MONGODB_URI is not set.');
  }
  // Connection + index creation happen in the background; requests that arrive before
  // it's ready simply await the same readiness promise inside the store's own methods
  const store = openStore(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || 'dashy' });
  try { getBaseConfig(); } catch (e) { warn(`Could not load conf.yml: ${e.message}`); }

  const router = createPersonalRouter({
    protectConfig: opts.protectConfig,
    identityContext: { mode: authMode, oidcSettings: opts.oidcSettings, headerName: opts.headerName },
    store,
    getBaseConfig,
  });

  /* Company defaults are owned by Git/deploy: block upstream disk writes unless explicitly allowed */
  const diskWriteGate = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (process.env.ALLOW_CONFIG_DISK_WRITES === 'true') return next();
    return res.status(403).json({
      success: false,
      message: 'Config is managed centrally. Use "Save My Dashboard" for personal changes.',
    });
  };

  return {
    router, store, diskWriteGate, isHealthy: () => store.isHealthy(),
  };
}

module.exports = { setupPersonalization, isEnabled };
