/**
 * Stable identity rules for global (company) and personal sections/links.
 *
 * Global IDs live in conf.yml as `stableId` on each section + item. They're
 * independent of title/url/position, so renames + reorders keep user overrides.
 * Personal IDs are generated server-side as `usr-sec-<uuid>` / `usr-link-<uuid>`,
 * so the two namespaces can never collide.
 */
const crypto = require('crypto');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/* Reserved personal section that collects links whose target section vanished */
const MY_TOOLS_ID = 'usr-sec-my-tools';
const MY_TOOLS_TITLE = 'My Tools';

const GLOBAL_ID_RE = /^(?!usr-)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PERSONAL_SECTION_ID_RE = new RegExp(`^usr-sec-(${UUID}|my-tools)$`);
const PERSONAL_LINK_ID_RE = new RegExp(`^usr-link-${UUID}$`);

const isGlobalId = (id) => typeof id === 'string' && GLOBAL_ID_RE.test(id);
const isPersonalSectionId = (id) => typeof id === 'string' && PERSONAL_SECTION_ID_RE.test(id);
const isPersonalLinkId = (id) => typeof id === 'string' && PERSONAL_LINK_ID_RE.test(id);
const isPersonalId = (id) => isPersonalSectionId(id) || isPersonalLinkId(id);

/* Lower-case, dash-separated, ascii-only fragment for readable IDs */
const slugify = (str, fallback) => {
  const slug = String(str || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
};

const shortHash = (str) => crypto.createHash('sha256').update(str).digest('hex').slice(0, 10);

/* Returns `base`, or `base-2`, `base-3`... whichever isn't yet in `taken` */
const uniqueId = (base, taken) => {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
  taken.add(candidate);
  return candidate;
};

/* Readable deterministic IDs, used by the one-off migration CLI (assign-stable-ids.js) */
const suggestSectionId = (section, taken) => uniqueId(`sec-${slugify(section?.name, 'section')}`, taken);
const suggestItemId = (section, item, taken) => uniqueId(
  `link-${slugify(section?.name, 'section')}-${slugify(item?.title, 'item')}`, taken,
);

/**
 * Ensures every section + item has a unique, valid stableId, without mutating input.
 * Missing/invalid/duplicate IDs get a deterministic fallback (`auto-<hash>`),
 * and are reported in `warnings`. Run assign-stable-ids.js to commit real IDs.
 */
function normalizeStableIds(sections) {
  const taken = new Set();
  const warnings = [];
  // Reserve all valid IDs first, so a fallback can never steal a real one
  (sections || []).forEach((s) => {
    if (isGlobalId(s?.stableId)) taken.add(s.stableId);
    (s?.items || []).forEach((i) => { if (isGlobalId(i?.stableId)) taken.add(i.stableId); });
  });
  const seen = new Set();
  const claim = (current, fallbackSeed, label) => {
    if (isGlobalId(current) && !seen.has(current)) {
      seen.add(current);
      return current;
    }
    const reason = current === undefined ? 'missing' : (seen.has(current) ? 'duplicate' : 'invalid');
    const id = uniqueId(`auto-${shortHash(fallbackSeed)}`, taken);
    seen.add(id);
    warnings.push(`${label}: ${reason} stableId${current ? ` '${current}'` : ''}, using '${id}'`);
    return id;
  };
  const normalized = (Array.isArray(sections) ? sections : []).map((section, si) => {
    const name = section?.name || '';
    const sectionId = claim(section?.stableId, `section\u0000${name}\u0000${si}`, `Section '${name || si}'`);
    const items = (Array.isArray(section?.items) ? section.items : []).map((item, ii) => ({
      ...item,
      stableId: claim(item?.stableId, `item\u0000${name}\u0000${item?.title || ''}\u0000${ii}`,
        `Item '${item?.title || ii}' in '${name || si}'`),
    }));
    return { ...section, stableId: sectionId, items };
  });
  return { sections: normalized, warnings };
}

const newPersonalSectionId = () => `usr-sec-${crypto.randomUUID()}`;
const newPersonalLinkId = () => `usr-link-${crypto.randomUUID()}`;

module.exports = {
  MY_TOOLS_ID,
  MY_TOOLS_TITLE,
  isGlobalId,
  isPersonalId,
  isPersonalSectionId,
  isPersonalLinkId,
  normalizeStableIds,
  suggestSectionId,
  suggestItemId,
  newPersonalSectionId,
  newPersonalLinkId,
};
