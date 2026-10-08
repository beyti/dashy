// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mergeDashboard } from '../../services/personalization/merge';
import { emptyPreferences } from '../../services/personalization/preferences';

const L1 = 'usr-link-11111111-1111-4111-8111-111111111111';
const L2 = 'usr-link-22222222-2222-4222-8222-222222222222';
const S1 = 'usr-sec-33333333-3333-4333-8333-333333333333';

const base = () => [
  {
    name: 'DevOps',
    stableId: 'sec-devops',
    icon: 'fas fa-cog',
    items: [
      { title: 'ADO', url: 'https://ado.example.com', stableId: 'link-ado' },
      { title: 'Jenkins', url: 'https://ci.example.com', stableId: 'link-ci' },
    ],
  },
  {
    name: 'Monitoring',
    stableId: 'sec-mon',
    items: [{ title: 'Grafana', url: 'https://grafana.example.com', stableId: 'link-grafana' }],
    widgets: [{ type: 'clock' }],
  },
];

const prefs = (over) => ({ ...emptyPreferences(), ...over });
const names = (r) => r.sections.map((s) => s.name);
const ids = (section) => section.items.map((i) => i.stableId);

describe('mergeDashboard', () => {
  it('returns the full authorized catalog for empty preferences', () => {
    const r = mergeDashboard(base(), prefs());
    expect(r.sections).toEqual(base());
    expect(r.hidden).toEqual({ sections: [], links: [] });
    expect(r.catalog.map((s) => s.id)).toEqual(['sec-devops', 'sec-mon']);
  });

  it('never mutates its inputs', () => {
    const b = base();
    const p = prefs({ hiddenGlobalLinkIds: ['link-ado'], sectionOrder: ['sec-mon'] });
    const snapshot = JSON.stringify([b, p]);
    mergeDashboard(b, p);
    expect(JSON.stringify([b, p])).toBe(snapshot);
  });

  it('hides global links and sections by stable ID, and lists them for unhiding', () => {
    const r = mergeDashboard(base(), prefs({
      hiddenGlobalLinkIds: ['link-ado'], hiddenGlobalSectionIds: ['sec-mon'],
    }));
    expect(names(r)).toEqual(['DevOps']);
    expect(ids(r.sections[0])).toEqual(['link-ci']);
    expect(r.hidden.sections).toEqual([{ id: 'sec-mon', name: 'Monitoring' }]);
    expect(r.hidden.links).toEqual([{
      id: 'link-ado', title: 'ADO', sectionId: 'sec-devops', sectionName: 'DevOps',
    }]);
  });

  it('a rename keeps the hide override (same stable ID)', () => {
    const renamed = base();
    renamed[0].items[0].title = 'Azure DevOps';
    renamed[0].items[0].url = 'https://dev.azure.com';
    const r = mergeDashboard(renamed, prefs({ hiddenGlobalLinkIds: ['link-ado'] }));
    expect(ids(r.sections[0])).toEqual(['link-ci']);
  });

  it('a deleted global link disappears and the stale ID is ignored', () => {
    const b = base();
    b[0].items.shift();
    const r = mergeDashboard(b, prefs({
      hiddenGlobalLinkIds: ['link-ado'],
      linkOrderBySection: { 'sec-devops': ['link-ado', 'link-ci'] },
      sectionOrder: ['sec-gone', 'sec-mon'],
    }));
    expect(ids(r.sections[1])).toEqual(['link-ci']);
    expect(names(r)).toEqual(['Monitoring', 'DevOps']);
    expect(r.hidden.links).toEqual([]);
  });

  it('new global links are visible by default, appended after saved order', () => {
    const b = base();
    b[0].items.push({ title: 'New', url: 'https://new.example.com', stableId: 'link-new' });
    const r = mergeDashboard(b, prefs({ linkOrderBySection: { 'sec-devops': ['link-ci', 'link-ado'] } }));
    expect(ids(r.sections[0])).toEqual(['link-ci', 'link-ado', 'link-new']);
  });

  it('new global links stay invisible when their parent section is hidden', () => {
    const b = base();
    b[1].items.push({ title: 'Loki', url: 'https://loki.example.com', stableId: 'link-loki' });
    const r = mergeDashboard(b, prefs({ hiddenGlobalSectionIds: ['sec-mon'] }));
    expect(r.sections.flatMap(ids)).not.toContain('link-loki');
  });

  it('new sections appear after ordered sections, in company order', () => {
    const b = base();
    b.splice(1, 0, { name: 'Analytics', stableId: 'sec-ana', items: [] });
    const r = mergeDashboard(b, prefs({ sectionOrder: ['sec-mon', 'sec-devops'] }));
    expect(names(r)).toEqual(['Monitoring', 'DevOps', 'Analytics']);
  });

  it('adds personal sections and links, ordered after company entries unless ordered', () => {
    const r = mergeDashboard(base(), prefs({
      personalSections: [{ id: S1, title: 'Mine', icon: 'fas fa-star' }],
      personalLinks: [
        { id: L1, sectionId: 'sec-devops', title: 'My Pipeline', url: 'https://ci.example.com/me' },
        { id: L2, sectionId: S1, title: 'Notes', url: 'https://notes.example.com' },
      ],
    }));
    expect(names(r)).toEqual(['DevOps', 'Monitoring', 'Mine']);
    expect(ids(r.sections[0])).toEqual(['link-ado', 'link-ci', L1]);
    expect(r.sections[2]).toEqual({
      name: 'Mine', icon: 'fas fa-star', stableId: S1,
      items: [{ title: 'Notes', url: 'https://notes.example.com', stableId: L2 }],
    });
  });

  it('orders personal and global entries together by saved ID arrays', () => {
    const r = mergeDashboard(base(), prefs({
      personalSections: [{ id: S1, title: 'Mine' }],
      personalLinks: [{ id: L1, sectionId: 'sec-devops', title: 'P', url: 'https://p.example.com' }],
      sectionOrder: [S1, 'sec-mon', 'sec-devops'],
      linkOrderBySection: { 'sec-devops': [L1, 'link-ci'] },
    }));
    expect(names(r)).toEqual(['Mine', 'Monitoring', 'DevOps']);
    expect(ids(r.sections[2])).toEqual([L1, 'link-ci', 'link-ado']);
  });

  it('moves personal links from a deleted/unauthorized section into My Tools', () => {
    const r = mergeDashboard(base(), prefs({
      personalLinks: [{ id: L1, sectionId: 'sec-deleted', title: 'Orphan', url: 'https://o.example.com' }],
    }));
    const myTools = r.sections.find((s) => s.stableId === 'usr-sec-my-tools');
    expect(myTools.name).toBe('My Tools');
    expect(ids(myTools)).toEqual([L1]);
    // Never relocated into another company section
    expect(r.sections.filter((s) => !s.stableId.startsWith('usr-')).flatMap(ids)).not.toContain(L1);
  });

  it('reuses an existing personal My Tools section for orphans', () => {
    const r = mergeDashboard(base(), prefs({
      personalSections: [{ id: 'usr-sec-my-tools', title: 'My Tools' }],
      personalLinks: [{ id: L1, sectionId: 'sec-deleted', title: 'Orphan', url: 'https://o.example.com' }],
    }));
    expect(r.sections.filter((s) => s.stableId === 'usr-sec-my-tools')).toHaveLength(1);
  });

  it('personal links in a hidden company section are hidden with it, not lost', () => {
    const p = prefs({
      hiddenGlobalSectionIds: ['sec-devops'],
      personalLinks: [{ id: L1, sectionId: 'sec-devops', title: 'P', url: 'https://p.example.com' }],
    });
    expect(mergeDashboard(base(), p).sections.flatMap(ids)).not.toContain(L1);
    expect(mergeDashboard(base(), { ...p, hiddenGlobalSectionIds: [] }).sections[0].items.map((i) => i.stableId))
      .toContain(L1);
  });

  it('ignores hide references to IDs outside the authorized catalog', () => {
    const r = mergeDashboard(base(), prefs({ hiddenGlobalLinkIds: ['link-secret'] }));
    expect(r.hidden.links).toEqual([]);
  });

  it('keeps personal section names unique if a company section later takes the name', () => {
    const r = mergeDashboard(base(), prefs({ personalSections: [{ id: S1, title: 'devops' }] }));
    expect(names(r)).toContain('devops (personal)');
  });

  it('is deterministic', () => {
    const p = prefs({
      personalSections: [{ id: S1, title: 'Mine' }],
      personalLinks: [{ id: L1, sectionId: 'x', title: 'P', url: 'https://p.example.com' }],
      sectionOrder: ['sec-mon'],
    });
    expect(mergeDashboard(base(), p)).toEqual(mergeDashboard(base(), p));
  });

  it('merges 500 company + 100 personal links quickly', () => {
    const big = Array.from({ length: 25 }, (_, s) => ({
      name: `S${s}`,
      stableId: `sec-${s}`,
      items: Array.from({ length: 20 }, (__, i) => ({ title: `L${i}`, url: 'https://x.example.com', stableId: `link-${s}-${i}` })),
    }));
    const links = Array.from({ length: 100 }, (_, i) => ({
      id: `usr-link-${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, sectionId: `sec-${i % 25}`, title: `P${i}`, url: 'https://p.example.com',
    }));
    const start = performance.now();
    for (let n = 0; n < 50; n += 1) mergeDashboard(big, prefs({ personalLinks: links }));
    expect((performance.now() - start) / 50).toBeLessThan(20);
  });
});
