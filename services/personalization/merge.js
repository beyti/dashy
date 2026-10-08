/**
 * Pure, deterministic merge of authorized company defaults + a user's overrides
 *   effectiveDashboard = merge(authorizedCompanyDefaults, validatedUserOverrides)
 *
 * Inputs are never mutated. Stale/unknown references are ignored.
 * Ordering: saved order first, then unlisted company entries (YAML order),
 * then unlisted personal entries (creation order).
 */
const { MY_TOOLS_ID, MY_TOOLS_TITLE } = require('./stable-ids');

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/* Orders `entries` by `savedOrder` IDs, keeping unlisted ones in their given order */
const applyOrder = (entries, savedOrder) => {
  const byId = new Map(entries.map((e) => [e.stableId, e]));
  const placed = new Set();
  const ordered = [];
  (savedOrder || []).forEach((id) => {
    if (byId.has(id) && !placed.has(id)) {
      ordered.push(byId.get(id));
      placed.add(id);
    }
  });
  // `entries` is already company-then-personal, so leftovers keep that rule
  entries.forEach((e) => { if (!placed.has(e.stableId)) ordered.push(e); });
  return ordered;
};

/* Personal section names must not shadow company ones (Dashy keys sections by name) */
const uniqueName = (title, used) => {
  let name = title;
  for (let n = 1; used.has(name.toLowerCase()); n += 1) {
    name = `${title} (personal${n > 1 ? ` ${n}` : ''})`;
  }
  used.add(name.toLowerCase());
  return name;
};

const personalLinkToItem = (link) => {
  const item = { title: link.title, url: link.url, stableId: link.id };
  if (link.description) item.description = link.description;
  if (link.icon) item.icon = link.icon;
  return item;
};

/**
 * @param authorizedSections company sections (with stableIds) the user may see
 * @param prefs validated preferences document
 * @returns { sections, hidden, catalog }
 */
function mergeDashboard(authorizedSections, prefs) {
  const base = clone(authorizedSections || []);
  const p = prefs || {};
  const globalSectionIds = new Set(base.map((s) => s.stableId));
  const globalLinkIds = new Set(base.flatMap((s) => (s.items || []).map((i) => i.stableId)));
  const hiddenSections = new Set((p.hiddenGlobalSectionIds || []).filter((id) => globalSectionIds.has(id)));
  const hiddenLinks = new Set((p.hiddenGlobalLinkIds || []).filter((id) => globalLinkIds.has(id)));

  // Catalog of every authorized company entry, hidden or not (used by the editor adapter)
  const catalog = base.map((s) => ({
    id: s.stableId,
    name: s.name || '',
    links: (s.items || []).map((i) => ({ id: i.stableId, title: i.title || '' })),
  }));
  const hidden = {
    sections: catalog.filter((s) => hiddenSections.has(s.id)).map(({ id, name }) => ({ id, name })),
    links: catalog.flatMap((s) => s.links.filter((l) => hiddenLinks.has(l.id))
      .map((l) => ({ ...l, sectionId: s.id, sectionName: s.name }))),
  };

  // Company sections, minus hidden entries
  const usedNames = new Set(base.map((s) => (s.name || '').toLowerCase()));
  const sectionsById = new Map();
  base.forEach((s) => {
    sectionsById.set(s.stableId, {
      section: { ...s, items: (s.items || []).filter((i) => !hiddenLinks.has(i.stableId)) },
      personalItems: [],
      isHidden: hiddenSections.has(s.stableId),
    });
  });

  // Personal sections, in creation order
  const personalOrder = [];
  const addPersonalSection = (id, title, icon) => {
    const section = { name: uniqueName(title, usedNames), stableId: id, items: [] };
    if (icon) section.icon = icon;
    sectionsById.set(id, { section, personalItems: [], isHidden: false });
    personalOrder.push(id);
  };
  (p.personalSections || []).forEach((s) => {
    if (!sectionsById.has(s.id)) addPersonalSection(s.id, s.title, s.icon);
  });

  // Personal links. Missing/unauthorized targets fall back to My Tools, never another company section
  (p.personalLinks || []).forEach((link) => {
    let target = sectionsById.get(link.sectionId);
    if (!target) {
      if (!sectionsById.has(MY_TOOLS_ID)) addPersonalSection(MY_TOOLS_ID, MY_TOOLS_TITLE, 'fas fa-toolbox');
      target = sectionsById.get(MY_TOOLS_ID);
    }
    target.personalItems.push(personalLinkToItem(link));
  });

  // Assemble: company sections first in YAML order, then personal ones
  const candidates = [...base.map((s) => s.stableId), ...personalOrder]
    .map((id) => sectionsById.get(id))
    .filter((entry) => !entry.isHidden)
    .map(({ section, personalItems }) => ({ ...section, items: [...section.items, ...personalItems] }));

  const sections = applyOrder(candidates, p.sectionOrder).map((section) => ({
    ...section,
    items: applyOrder(section.items, (p.linkOrderBySection || {})[section.stableId]),
  }));

  return { sections, hidden, catalog };
}

module.exports = { mergeDashboard };
