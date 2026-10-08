/**
 * Schema + validation for a user's personal overrides document.
 * Structure is checked with Ajv, then semantic rules (uniqueness, URL schemes,
 * authorized targets) are applied against the caller's authorized catalog.
 */
const Ajv = require('ajv');
const {
  isGlobalId, isPersonalSectionId, isPersonalLinkId, MY_TOOLS_ID,
} = require('./stable-ids');

const SCHEMA_VERSION = 1;

const LIMITS = {
  personalSections: 50,
  personalLinks: 300,
  idList: 2000,
  linkOrderSections: 400,
  title: 120,
  description: 500,
  url: 2048,
  icon: 256,
  id: 128,
};

const ROOT_KEYS = [
  'schemaVersion', 'personalSections', 'personalLinks', 'hiddenGlobalSectionIds',
  'hiddenGlobalLinkIds', 'sectionOrder', 'linkOrderBySection',
];

const idString = { type: 'string', minLength: 1, maxLength: LIMITS.id };
const idList = { type: 'array', maxItems: LIMITS.idList, items: idString };

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion'],
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    personalSections: {
      type: 'array',
      maxItems: LIMITS.personalSections,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title'],
        properties: {
          id: idString,
          title: { type: 'string', maxLength: LIMITS.title },
          icon: { type: 'string', maxLength: LIMITS.icon },
        },
      },
    },
    personalLinks: {
      type: 'array',
      maxItems: LIMITS.personalLinks,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'sectionId', 'title', 'url'],
        properties: {
          id: idString,
          sectionId: idString,
          title: { type: 'string', maxLength: LIMITS.title },
          url: { type: 'string', maxLength: LIMITS.url },
          description: { type: 'string', maxLength: LIMITS.description },
          icon: { type: 'string', maxLength: LIMITS.icon },
        },
      },
    },
    hiddenGlobalSectionIds: idList,
    hiddenGlobalLinkIds: idList,
    sectionOrder: idList,
    linkOrderBySection: {
      type: 'object',
      maxProperties: LIMITS.linkOrderSections,
      additionalProperties: idList,
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(schema);

const emptyPreferences = () => ({
  schemaVersion: SCHEMA_VERSION,
  personalSections: [],
  personalLinks: [],
  hiddenGlobalSectionIds: [],
  hiddenGlobalLinkIds: [],
  sectionOrder: [],
  linkOrderBySection: {},
});

/* Default allow-list, override with USER_OVERRIDES_URL_SCHEMES=https,http,ssh */
const allowedSchemes = () => (process.env.USER_OVERRIDES_URL_SCHEMES || 'https,http')
  .split(',').map((s) => s.trim().toLowerCase().replace(/:$/, '')).filter(Boolean)
  .filter((s) => !['javascript', 'data', 'file', 'vbscript', 'blob'].includes(s));

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const UNSAFE_ICON_CHARS = /[<>"'`\\]/;

const isSafeUrl = (value) => {
  if (typeof value !== 'string' || CONTROL_CHARS.test(value) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return allowedSchemes().includes(url.protocol.replace(/:$/, '').toLowerCase());
  } catch { return false; }
};

/* Icons: Dashy icon names (fa/si/hl/mdi/favicon/emoji), or an http(s) image URL */
const isSafeIcon = (value) => {
  if (value === undefined || value === '') return true;
  if (CONTROL_CHARS.test(value) || UNSAFE_ICON_CHARS.test(value)) return false;
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return true;
  return ['http', 'https'].includes(scheme[1].toLowerCase()) && isSafeUrl(value);
};

const cleanText = (s) => (typeof s === 'string' ? s.replace(CONTROL_CHARS, '').trim() : s);
const dedupe = (list) => [...new Set(list)];

class PreferencesError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * Validates + normalizes a preferences document for one caller.
 * @param input untrusted document from the request body
 * @param catalog { sectionIds:Set, linkIds:Set, sectionNames:Set } authorized for caller
 * @returns normalized document, or throws PreferencesError (400 / 403)
 */
function validatePreferences(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PreferencesError('preferences must be an object');
  }
  // Strip unknown root fields, fill missing lists with empty defaults
  const doc = { ...emptyPreferences() };
  ROOT_KEYS.forEach((k) => { if (input[k] !== undefined) doc[k] = input[k]; });

  if (!validateShape(doc)) {
    const details = (validateShape.errors || []).slice(0, 10)
      .map((e) => `${e.instancePath || '/'} ${e.message}`);
    throw new PreferencesError('Invalid preferences document', 400, details);
  }

  const globalSectionNames = new Set([...catalog.sectionNames].map((n) => n.toLowerCase()));

  // Personal sections
  const sectionIds = new Set();
  const sectionTitles = new Set();
  const personalSections = doc.personalSections.map((s) => {
    const title = cleanText(s.title);
    if (!isPersonalSectionId(s.id)) throw new PreferencesError(`Invalid personal section id '${s.id}'`);
    if (sectionIds.has(s.id)) throw new PreferencesError(`Duplicate personal section id '${s.id}'`);
    if (!title) throw new PreferencesError('Personal section title is required');
    const key = title.toLowerCase();
    if (sectionTitles.has(key) || globalSectionNames.has(key)) {
      throw new PreferencesError(`Section name '${title}' is already in use`);
    }
    if (!isSafeIcon(s.icon || '')) throw new PreferencesError(`Unsupported icon for section '${title}'`);
    sectionIds.add(s.id);
    sectionTitles.add(key);
    return { id: s.id, title, ...(s.icon ? { icon: cleanText(s.icon) } : {}) };
  });

  // Personal links
  const linkIds = new Set();
  const personalLinks = doc.personalLinks.map((l) => {
    const title = cleanText(l.title);
    if (!isPersonalLinkId(l.id)) throw new PreferencesError(`Invalid personal link id '${l.id}'`);
    if (linkIds.has(l.id)) throw new PreferencesError(`Duplicate personal link id '${l.id}'`);
    if (!title) throw new PreferencesError('Personal link title is required');
    if (!isSafeUrl(l.url)) throw new PreferencesError(`URL for '${title}' is not allowed`);
    if (!isSafeIcon(l.icon || '')) throw new PreferencesError(`Unsupported icon for '${title}'`);
    const targetOk = sectionIds.has(l.sectionId) || catalog.sectionIds.has(l.sectionId);
    if (!targetOk) {
      throw new PreferencesError(`Link '${title}' targets a section you can't use`, 403);
    }
    linkIds.add(l.id);
    const link = { id: l.id, sectionId: l.sectionId, title, url: l.url };
    if (l.description) link.description = cleanText(l.description);
    if (l.icon) link.icon = cleanText(l.icon);
    return link;
  });

  // References: keep only IDs the caller can see or owns, silently drop the rest
  const ownedOrAuthorizedSection = (id) => sectionIds.has(id) || catalog.sectionIds.has(id);
  const ownedOrAuthorizedLink = (id) => linkIds.has(id) || catalog.linkIds.has(id);
  const linkOrderBySection = {};
  Object.keys(doc.linkOrderBySection).sort().forEach((sectionId) => {
    if (!ownedOrAuthorizedSection(sectionId)) return;
    const ids = dedupe(doc.linkOrderBySection[sectionId].filter(ownedOrAuthorizedLink));
    if (ids.length) linkOrderBySection[sectionId] = ids;
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    personalSections,
    personalLinks,
    hiddenGlobalSectionIds: dedupe(doc.hiddenGlobalSectionIds
      .filter((id) => isGlobalId(id) && catalog.sectionIds.has(id))),
    hiddenGlobalLinkIds: dedupe(doc.hiddenGlobalLinkIds
      .filter((id) => isGlobalId(id) && catalog.linkIds.has(id))),
    sectionOrder: dedupe(doc.sectionOrder.filter(ownedOrAuthorizedSection)),
    linkOrderBySection,
  };
}

/* Upgrades a stored document to the current schema version (v1 is current) */
function migrateStoredPreferences(doc, storedVersion) {
  if (!doc || typeof doc !== 'object') return emptyPreferences();
  if (storedVersion > SCHEMA_VERSION) throw new Error(`Unsupported preferences schema v${storedVersion}`);
  return { ...emptyPreferences(), ...doc, schemaVersion: SCHEMA_VERSION };
}

module.exports = {
  SCHEMA_VERSION,
  LIMITS,
  MY_TOOLS_ID,
  PreferencesError,
  emptyPreferences,
  validatePreferences,
  migrateStoredPreferences,
  isSafeUrl,
  isSafeIcon,
};
