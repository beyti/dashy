/**
 * /api/me/* — the caller's own merged dashboard and override document.
 * Identity always comes from server-verified auth (see identity.js), so there is
 * no way to address another user's record: no user IDs are accepted anywhere.
 */
const express = require('express');
const { originFromRequest } = require('../utils/request-origin');
const { resolveIdentity } = require('./identity');
const { filterAuthorized } = require('./visibility');
const { mergeDashboard } = require('./merge');
const { revisionOf } = require('./base-config');
const { validatePreferences, emptyPreferences, PreferencesError } = require('./preferences');
const { RevisionConflictError } = require('./db');

const BODY_LIMIT = process.env.USER_OVERRIDES_MAX_BODY || '64kb';
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

/* Personalized responses must never be cached or shared between users */
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('Vary', 'Authorization, Cookie');
  next();
};

/* CSRF: basic-auth credentials + cookies are sent automatically by browsers,
 * so state-changing requests must be same-origin JSON (forces a CORS preflight) */
const sameOriginWrites = (req, res, next) => {
  if (SAFE_METHODS.includes(req.method)) return next();
  if (req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'Cross-site request blocked');
  const { origin } = req.headers;
  if (origin && origin !== 'null') {
    let normalized;
    try { normalized = new URL(origin).origin; } catch { normalized = null; }
    if (normalized !== originFromRequest(req)) return fail(res, 403, 'Cross-origin request blocked');
  } else if (origin === 'null') {
    return fail(res, 403, 'Cross-origin request blocked');
  }
  const hasBody = req.method !== 'DELETE' || Number(req.headers['content-length'] || 0) > 0;
  if (hasBody && !req.is('application/json')) return fail(res, 415, 'Content-Type must be application/json');
  return next();
};

const parseRevision = (value) => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

function createPersonalRouter({
  protectConfig, identityContext, store, getBaseConfig,
}) {
  const router = express.Router();

  /* Authorized view of company defaults for this caller */
  const authorizedFor = (identity) => {
    const base = getBaseConfig();
    const sections = filterAuthorized(base.sections, identity);
    return {
      base,
      sections,
      catalog: {
        sectionIds: new Set(sections.map((s) => s.stableId)),
        linkIds: new Set(sections.flatMap((s) => s.items.map((i) => i.stableId))),
        sectionNames: new Set(sections.map((s) => s.name || '')),
      },
    };
  };

  /* Reads stored prefs; anything no longer valid for this caller is dropped, never fatal */
  const loadPreferences = (identity, catalog) => {
    const record = store.get(identity.key);
    if (!record) return { revision: 0, preferences: emptyPreferences() };
    let preferences = emptyPreferences();
    if (record.preferences) {
      try {
        preferences = validatePreferences(record.preferences, catalog);
      } catch {
        // e.g. a personal link pointing at a section the user lost access to:
        // keep the links (merge moves them to My Tools), drop references only
        const p = record.preferences;
        preferences = {
          ...emptyPreferences(),
          personalSections: Array.isArray(p.personalSections) ? p.personalSections : [],
          personalLinks: Array.isArray(p.personalLinks) ? p.personalLinks : [],
        };
      }
    }
    return { revision: record.revision, preferences, updatedAt: record.updatedAt };
  };

  router.use(noStore);
  router.use(sameOriginWrites);
  router.use(protectConfig);
  router.use((req, res, next) => {
    const identity = resolveIdentity(req, identityContext);
    if (!identity) return fail(res, 401, 'Unauthorized');
    req.identity = identity;
    return next();
  });
  router.use(express.json({ limit: BODY_LIMIT, strict: true }));

  router.get('/dashboard', (req, res) => {
    const { base, sections, catalog } = authorizedFor(req.identity);
    const { revision, preferences } = loadPreferences(req.identity, catalog);
    const merged = mergeDashboard(sections, preferences);
    const { pageInfo, appConfig, pages } = base.config;
    res.json({
      success: true,
      config: {
        pageInfo: pageInfo || {}, appConfig: appConfig || {}, pages: pages || [], sections: merged.sections,
      },
      hidden: merged.hidden,
      catalog: merged.catalog,
      preferences,
      baseRevision: revisionOf(sections),
      preferenceRevision: revision,
    });
  });

  router.get('/preferences', (req, res) => {
    const { catalog } = authorizedFor(req.identity);
    const { revision, preferences, updatedAt } = loadPreferences(req.identity, catalog);
    res.json({
      success: true, revision, preferences, updatedAt: updatedAt || null,
    });
  });

  router.put('/preferences', (req, res) => {
    const body = req.body || {};
    const expectedRevision = parseRevision(body.expectedRevision);
    if (expectedRevision === null) return fail(res, 400, 'expectedRevision must be a non-negative integer');
    const { catalog } = authorizedFor(req.identity);
    const preferences = validatePreferences(body.preferences, catalog); // throws 400/403
    const saved = store.save(req.identity.key, preferences, expectedRevision); // throws 409
    return res.json({ success: true, revision: saved.revision, preferences: saved.preferences });
  });

  router.delete('/preferences', (req, res) => {
    const expectedRevision = parseRevision(req.body?.expectedRevision ?? req.query.expectedRevision);
    if (expectedRevision === null) return fail(res, 400, 'expectedRevision must be a non-negative integer');
    store.remove(req.identity.key, expectedRevision);
    return res.json({ success: true, revision: 0, preferences: emptyPreferences() });
  });

  router.use((req, res) => fail(res, 404, 'Not found'));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof RevisionConflictError) {
      return fail(res, 409, err.message, { currentRevision: err.currentRevision });
    }
    if (err instanceof PreferencesError) {
      return fail(res, err.status, err.message, err.details ? { errors: err.details } : {});
    }
    if (err.type === 'entity.too.large') return fail(res, 413, 'Payload too large');
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'Malformed JSON');
    if (err.status >= 400 && err.status < 500) return fail(res, err.status, 'Bad request');
    console.error('[personalization] request failed:', err.message);
    return fail(res, 500, 'Internal error');
  });

  return router;
}

module.exports = { createPersonalRouter };
