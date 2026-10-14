/**
 * Server-side verification of Cloudflare Zero Trust Access identity assertions.
 *
 * Access sits in front of the app (via a Tunnel, so the origin has no public listener of
 * its own) and, once a user clears the login policy, forwards every request with a signed
 * JWT proving who they are. This module verifies that JWT's signature against the team's
 * published keys - trusting the Cf-Access-Authenticated-User-Email header value alone would
 * mean anyone who ever reaches the origin directly (a firewall slip, a future second route)
 * could just set that header themselves and be let in as anyone.
 */

const { createRemoteJWKSet, jwtVerify } = require('jose');

/* Normalise appConfig.auth.cloudflareAccess. Returns null when disabled or incomplete */
function loadCloudflareAccessSettings(authConfig) {
  if (!authConfig || typeof authConfig !== 'object') return null;
  if (!authConfig.enableCloudflareAccess || !authConfig.cloudflareAccess) return null;
  const { teamDomain, aud, certsUrl } = authConfig.cloudflareAccess;
  if (!teamDomain || !aud) return null;
  const issuer = `https://${teamDomain}.cloudflareaccess.com`;
  return {
    issuer,
    aud: String(aud),
    // certsUrl is an undocumented override, only for pointing tests at a local mock JWKS
    certsUrl: certsUrl ? new URL(certsUrl) : new URL(`${issuer}/cdn-cgi/access/certs`),
  };
}

/* Access attaches the assertion as a request header on every proxied request, and (for
   browser navigations through the app) also as a cookie. Either is acceptable here. */
function readAssertion(req) {
  const header = req.headers['cf-access-jwt-assertion'];
  if (typeof header === 'string' && header) return header;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/* Per-process JWKS cache: createRemoteJWKSet handles key caching + rotation internally */
const jwksCache = new Map();
function getJwks(settings) {
  const key = settings.certsUrl.href;
  if (!jwksCache.has(key)) jwksCache.set(key, createRemoteJWKSet(settings.certsUrl));
  return jwksCache.get(key);
}

/* Connect middleware factory. Verifies the Access assertion; sets req.auth on success.
 * If `permissive: true`, falls through on verification failure instead of 401 (used for
 * bootstrap fetches that must succeed before the user is known to be logged in) */
function createCloudflareAccessMiddleware(settings, { permissive = false } = {}) {
  const jwks = getJwks(settings);
  return async (req, res, next) => {
    const token = readAssertion(req);
    if (!token) {
      if (permissive) return next();
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - missing Cloudflare Access assertion',
      });
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: settings.issuer,
        audience: settings.aud,
        clockTolerance: '30s',
      });
      if (typeof payload.email !== 'string' || !payload.email) {
        throw new Error('Access token has no email claim');
      }
      req.auth = { user: payload.email, claims: payload };
      return next();
    } catch (e) {
      console.warn('[auth-cloudflare-access] assertion verification failed:', e.message || e); // eslint-disable-line no-console
      if (permissive) return next();
      return res.status(401).json({
        success: false,
        message: 'Unauthorized - Invalid or expired Cloudflare Access assertion',
      });
    }
  };
}

module.exports = { loadCloudflareAccessSettings, createCloudflareAccessMiddleware };
