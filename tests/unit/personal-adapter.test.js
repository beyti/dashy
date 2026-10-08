import { describe, it, expect } from 'vitest';
import { mergeDashboard } from '../../services/personalization/merge';
import { validatePreferences, emptyPreferences } from '../../services/personalization/preferences';
import { deriveOverrides, isCompanyEntry } from '@/utils/personalization/OverridesAdapter';

const L1 = 'usr-link-11111111-1111-4111-8111-111111111111';

const company = () => [
  {
    name: 'DevOps',
    stableId: 'sec-devops',
    items: [
      { title: 'ADO', url: 'https://ado.example.com', stableId: 'link-ado' },
      { title: 'CI', url: 'https://ci.example.com', stableId: 'link-ci' },
    ],
  },
  {
    name: 'Monitoring',
    stableId: 'sec-mon',
    items: [{ title: 'Grafana', url: 'https://grafana.example.com', stableId: 'link-grafana' }],
  },
];

const catalogOf = (sections) => ({
  sectionIds: new Set(sections.map((s) => s.stableId)),
  linkIds: new Set(sections.flatMap((s) => s.items.map((i) => i.stableId))),
  sectionNames: new Set(sections.map((s) => s.name)),
});

/* Simulates a browser session: server merge -> editor changes -> adapter -> server validation */
const session = (prefs = emptyPreferences(), base = company()) => {
  const merged = mergeDashboard(base, prefs);
  // The editor works on a deep copy of state.config.sections (with runtime ids)
  const draft = JSON.parse(JSON.stringify(merged.sections))
    .map((s) => ({ ...s, items: s.items.map((i, n) => ({ ...i, id: `${n}_runtime` })) }));
  const save = (unhide = new Set()) => {
    const doc = deriveOverrides(draft, { catalog: merged.catalog, preferences: prefs, unhide });
    const valid = validatePreferences(doc, catalogOf(base));
    return { doc: valid, view: mergeDashboard(base, valid).sections };
  };
  return { draft, save, merged };
};
const flatIds = (sections) => sections.map((s) => [s.stableId, s.items.map((i) => i.stableId)]);

describe('OverridesAdapter.deriveOverrides', () => {
  it('produces no overrides beyond ordering when nothing changed', () => {
    const { save } = session();
    const { doc, view } = save();
    expect(doc.hiddenGlobalLinkIds).toEqual([]);
    expect(doc.hiddenGlobalSectionIds).toEqual([]);
    expect(doc.personalLinks).toEqual([]);
    expect(flatIds(view)).toEqual(flatIds(company()));
  });

  it('removing a company link hides it (does not delete it)', () => {
    const { draft, save } = session();
    draft[0].items.splice(0, 1);
    const { doc, view } = save();
    expect(doc.hiddenGlobalLinkIds).toEqual(['link-ado']);
    expect(view[0].items.map((i) => i.stableId)).toEqual(['link-ci']);
  });

  it('removing a company section hides the section only', () => {
    const { draft, save } = session();
    draft.splice(1, 1);
    const { doc } = save();
    expect(doc.hiddenGlobalSectionIds).toEqual(['sec-mon']);
    expect(doc.hiddenGlobalLinkIds).toEqual([]);
  });

  it('new items and sections become personal records with fresh UUIDs', () => {
    const { draft, save } = session();
    draft[0].items.push({ title: 'Mine', url: 'https://mine.example.com', id: 'temp_Mine', color: 'red' });
    draft.push({ name: 'My Stuff', icon: 'fas fa-star', items: [{ title: 'Notes', url: 'https://notes.example.com' }] });
    const { doc, view } = save();
    expect(doc.personalSections).toHaveLength(1);
    expect(doc.personalSections[0]).toMatchObject({ title: 'My Stuff', icon: 'fas fa-star' });
    expect(doc.personalLinks.map((l) => l.sectionId)).toEqual(['sec-devops', doc.personalSections[0].id]);
    expect(doc.personalLinks[0]).not.toHaveProperty('color'); // only whitelisted fields
    expect(view.map((s) => s.name)).toEqual(['DevOps', 'Monitoring', 'My Stuff']);
  });

  it('keeps personal IDs stable across saves', () => {
    const first = session();
    first.draft[0].items.push({ title: 'Mine', url: 'https://mine.example.com' });
    const saved = first.save().doc;
    const { doc } = session(saved).save();
    expect(doc.personalLinks.map((l) => l.id)).toEqual(saved.personalLinks.map((l) => l.id));
  });

  it('ignores edits to company link fields (centrally owned)', () => {
    const { draft, save } = session();
    draft[0].items[0] = { ...draft[0].items[0], title: 'Hacked', url: 'https://evil.example.com' };
    const { doc, view } = save();
    expect(doc.personalLinks).toEqual([]);
    expect(view[0].items[0]).toMatchObject({ title: 'ADO', url: 'https://ado.example.com' });
  });

  it('records reordering of sections and links as ID arrays', () => {
    const { draft, save } = session();
    draft.reverse();
    draft[1].items.reverse();
    const { doc, view } = save();
    expect(doc.sectionOrder).toEqual(['sec-mon', 'sec-devops']);
    expect(doc.linkOrderBySection['sec-devops']).toEqual(['link-ci', 'link-ado']);
    expect(flatIds(view)).toEqual([['sec-mon', ['link-grafana']], ['sec-devops', ['link-ci', 'link-ado']]]);
  });

  it('a company link dragged to another section snaps back home, and is not hidden', () => {
    const { draft, save } = session();
    const [moved] = draft[0].items.splice(0, 1);
    draft[1].items.push(moved);
    const { doc, view } = save();
    expect(doc.hiddenGlobalLinkIds).toEqual([]);
    expect(doc.personalLinks).toEqual([]);
    expect(view[0].items.map((i) => i.stableId)).toContain('link-ado');
    expect(view[1].items.map((i) => i.stableId)).toEqual(['link-grafana']);
  });

  it('a copy of a company link into another section becomes a personal link', () => {
    const { draft, save } = session();
    draft[1].items.push({ ...draft[0].items[0] });
    const { doc } = save();
    expect(doc.personalLinks).toHaveLength(1);
    expect(doc.personalLinks[0]).toMatchObject({ sectionId: 'sec-mon', title: 'ADO', url: 'https://ado.example.com' });
    expect(doc.personalLinks[0].id).not.toBe('link-ado');
  });

  it('keeps personal links of a hidden section, and restores them on unhide', () => {
    const prefs = {
      ...emptyPreferences(),
      hiddenGlobalSectionIds: ['sec-mon'],
      personalLinks: [{ id: L1, sectionId: 'sec-mon', title: 'P', url: 'https://p.example.com' }],
    };
    const { save } = session(prefs);
    const kept = save().doc;
    expect(kept.personalLinks).toEqual(prefs.personalLinks);
    expect(kept.hiddenGlobalSectionIds).toEqual(['sec-mon']);
    const restored = session(prefs).save(new Set(['sec-mon']));
    expect(restored.doc.hiddenGlobalSectionIds).toEqual([]);
    expect(restored.view.find((s) => s.stableId === 'sec-mon').items.map((i) => i.stableId))
      .toEqual(['link-grafana', L1]);
  });

  it('unhides a hidden company link', () => {
    const prefs = { ...emptyPreferences(), hiddenGlobalLinkIds: ['link-ado'] };
    const { doc, view } = session(prefs).save(new Set(['link-ado']));
    expect(doc.hiddenGlobalLinkIds).toEqual([]);
    expect(view[0].items.map((i) => i.stableId)).toContain('link-ado');
  });

  it('keeps links hidden inside a hidden section', () => {
    const prefs = { ...emptyPreferences(), hiddenGlobalSectionIds: ['sec-devops'], hiddenGlobalLinkIds: ['link-ado'] };
    expect(session(prefs).save().doc.hiddenGlobalLinkIds).toEqual(['link-ado']);
  });

  it('persists orphaned personal links in My Tools so the user can keep saving', () => {
    const prefs = {
      ...emptyPreferences(),
      personalLinks: [{ id: L1, sectionId: 'sec-deleted', title: 'Orphan', url: 'https://o.example.com' }],
    };
    const { doc, view } = session(prefs).save();
    expect(doc.personalSections).toEqual([{ id: 'usr-sec-my-tools', title: 'My Tools', icon: 'fas fa-toolbox' }]);
    expect(doc.personalLinks[0].sectionId).toBe('usr-sec-my-tools');
    expect(view.find((s) => s.name === 'My Tools').items.map((i) => i.stableId)).toEqual([L1]);
  });

  it('identifies company entries by stable ID namespace', () => {
    expect(isCompanyEntry({ stableId: 'link-ado' })).toBe(true);
    expect(isCompanyEntry({ stableId: L1 })).toBe(false);
    expect(isCompanyEntry({})).toBe(false);
  });
});
