/**
 * Enterprise personalization (fork feature), off unless ENABLE_USER_OVERRIDES=true
 * Wires the SQLite store, /api/me router, and the hardening hooks used by app.js.
 * See docs/personal-overrides.md
 */
const path = require('path');
const { openStore } = require('./db');
const { getBaseConfig } = require('./base-config');
const { createPersonalRouter } = require('./routes');

const isEnabled = () => process.env.ENABLE_USER_OVERRIDES === 'true';

const defaultDbPath = () => process.env.DATABASE_PATH
  || path.resolve(__dirname, '..', '..', 'data', 'tools.sqlite');

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

  // Migrations run here, synchronously, before the app can serve any traffic
  const store = openStore(defaultDbPath());
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
