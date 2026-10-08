/**
 * Maps the visual editor's working copy of sections back into a personal
 * overrides document (deltas against company defaults), never a full config copy.
 *
 * Rules:
 *  - Company section/link missing from the draft => hidden (until unhidden)
 *  - Positions => sectionOrder / linkOrderBySection (ordered stable-ID arrays)
 *  - Entries without a stableId, or with a usr- one => personal records
 *  - Company link fields are centrally owned, so edits to them are ignored
 *  - A company link dragged to another section snaps back home (no cross-section moves in MVP),
 *    but a *copy* of one (still present at home) becomes a personal link
 *  - Personal links inside a hidden company section are kept untouched
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PERSONAL_SECTION_RE = new RegExp(`^usr-sec-(${UUID}|my-tools)$`);
const PERSONAL_LINK_RE = new RegExp(`^usr-link-${UUID}$`);

export const isPersonalSectionId = (id) => typeof id === 'string' && PERSONAL_SECTION_RE.test(id);
export const isPersonalLinkId = (id) => typeof id === 'string' && PERSONAL_LINK_RE.test(id);
export const isPersonalId = (id) => typeof id === 'string' && id.startsWith('usr-');
/* True for entries that came from conf.yml (company-owned) */
export const isCompanyEntry = (entry) => !!entry?.stableId && !isPersonalId(entry.stableId);

const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const newPersonalSectionId = () => `usr-sec-${uuid()}`;
export const newPersonalLinkId = () => `usr-link-${uuid()}`;

const optionalString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const toPersonalLink = (item, id, sectionId) => {
  const link = {
    id, sectionId, title: String(item.title || '').trim(), url: String(item.url || '').trim(),
  };
  const description = optionalString(item.description);
  const icon = optionalString(item.icon);
  if (description) link.description = description;
  if (icon) link.icon = icon;
  return link;
};

/**
 * @param sections the editor's working copy (state.config.sections)
 * @param ctx.catalog [{ id, name, links: [{ id, title }] }] authorized company entries
 * @param ctx.preferences the stored preferences the draft was based on
 * @param ctx.unhide Set of company IDs the user chose to restore
 * @returns a preferences document ready for PUT /api/me/preferences
 */
export function deriveOverrides(sections, { catalog = [], preferences = {}, unhide = new Set() } = {}) {
  const prev = preferences || {};
  const companySectionIds = new Set(catalog.map((s) => s.id));
  const linkHome = new Map(catalog.flatMap((s) => s.links.map((l) => [l.id, s.id])));
  const prevHiddenSections = new Set(prev.hiddenGlobalSectionIds || []);
  const prevHiddenLinks = new Set(prev.hiddenGlobalLinkIds || []);
  const draft = Array.isArray(sections) ? sections : [];

  // Pass 1: where does each company link currently sit?
  const atHome = new Set();
  draft.forEach((s) => (s.items || []).forEach((i) => {
    if (linkHome.has(i.stableId) && linkHome.get(i.stableId) === s.stableId) atHome.add(i.stableId);
  }));

  const personalSections = [];
  const personalLinks = [];
  const sectionOrder = [];
  const linkOrderBySection = {};
  const presentSections = new Set();
  const presentLinks = new Set();
  const usedIds = new Set();

  draft.forEach((section) => {
    let sid = section.stableId;
    if (companySectionIds.has(sid)) {
      if (presentSections.has(sid)) return; // duplicate of a company section, ignore
    } else {
      if (!isPersonalSectionId(sid) || usedIds.has(sid)) sid = newPersonalSectionId();
      const entry = { id: sid, title: String(section.name || '').trim() };
      const icon = optionalString(section.icon);
      if (icon) entry.icon = icon;
      personalSections.push(entry);
    }
    usedIds.add(sid);
    presentSections.add(sid);
    sectionOrder.push(sid);

    const order = [];
    (section.items || []).forEach((item) => {
      const iid = item.stableId;
      if (linkHome.has(iid)) {
        if (linkHome.get(iid) === sid) {
          if (!presentLinks.has(iid)) order.push(iid);
          presentLinks.add(iid);
          return;
        }
        if (!atHome.has(iid)) { presentLinks.add(iid); return; } // dragged away: snap back
        // Copied into another section: becomes the user's own link
      }
      const id = isPersonalLinkId(iid) && !usedIds.has(iid) ? iid : newPersonalLinkId();
      usedIds.add(id);
      personalLinks.push(toPersonalLink(item, id, sid));
      order.push(id);
    });
    if (order.length) linkOrderBySection[sid] = order;
  });

  const hiddenGlobalSectionIds = catalog
    .map((s) => s.id)
    .filter((id) => !presentSections.has(id) && !unhide.has(id));

  const hiddenGlobalLinkIds = catalog.flatMap((s) => s.links.map((l) => l.id)).filter((id) => {
    if (presentLinks.has(id) || unhide.has(id)) return false;
    return presentSections.has(linkHome.get(id)) ? true : prevHiddenLinks.has(id);
  });

  // Personal links + ordering inside company sections that aren't in the draft (hidden) are kept
  (prev.personalLinks || []).forEach((link) => {
    const parked = companySectionIds.has(link.sectionId) && !presentSections.has(link.sectionId)
      && (prevHiddenSections.has(link.sectionId) || unhide.has(link.sectionId));
    if (parked && !usedIds.has(link.id)) {
      usedIds.add(link.id);
      personalLinks.push({ ...link });
    }
  });
  Object.entries(prev.linkOrderBySection || {}).forEach(([sid, ids]) => {
    if (companySectionIds.has(sid) && !presentSections.has(sid)) linkOrderBySection[sid] = [...ids];
  });

  return {
    schemaVersion: 1,
    personalSections,
    personalLinks,
    hiddenGlobalSectionIds,
    hiddenGlobalLinkIds,
    sectionOrder,
    linkOrderBySection,
  };
}
