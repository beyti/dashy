// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import {
  normalizeStableIds, isGlobalId, isPersonalLinkId, isPersonalSectionId, newPersonalLinkId,
} from '../../services/personalization/stable-ids';
import { assignStableIds } from '../../services/personalization/assign-stable-ids';
import { filterAuthorized, isVisibleToPrincipal } from '../../services/personalization/visibility';

describe('stable ID rules', () => {
  it('keeps the global and personal namespaces disjoint', () => {
    expect(isGlobalId('link-ado')).toBe(true);
    expect(isGlobalId('usr-link-x')).toBe(false);
    expect(isGlobalId('')).toBe(false);
    expect(isGlobalId('has space')).toBe(false);
    const id = newPersonalLinkId();
    expect(isPersonalLinkId(id)).toBe(true);
    expect(isGlobalId(id)).toBe(false);
    expect(isPersonalSectionId('usr-sec-my-tools')).toBe(true);
  });

  it('keeps valid IDs and deterministically fills missing/duplicate ones', () => {
    const sections = [
      { name: 'A', stableId: 'sec-a', items: [{ title: 'x', stableId: 'dup' }, { title: 'y', stableId: 'dup' }] },
      { name: 'B', items: [{ title: 'z' }] },
    ];
    const first = normalizeStableIds(sections);
    const second = normalizeStableIds(sections);
    expect(first).toEqual(second);
    expect(first.sections[0].stableId).toBe('sec-a');
    expect(first.sections[0].items[0].stableId).toBe('dup');
    expect(first.sections[0].items[1].stableId).toMatch(/^auto-/);
    expect(first.sections[1].stableId).toMatch(/^auto-/);
    expect(first.warnings).toHaveLength(3);
    expect(sections[1].stableId).toBeUndefined(); // input untouched
  });
});

describe('assign-stable-ids migration', () => {
  const src = `# Company tools
sections:
  - name: Dev Ops   # keep me
    items:
      - title: ADO
        url: https://ado
      - title: ADO
        url: https://ado2
      - title: Existing
        stableId: link-keep
  - name: Dev Ops!
    stableId: sec-dev-ops
`;

  it('adds readable, unique IDs, keeps comments and existing IDs', () => {
    const { output, changes } = assignStableIds(src);
    expect(changes).toHaveLength(3);
    expect(output).toContain('# Company tools');
    expect(output).toContain('# keep me');
    const parsed = load(output);
    expect(parsed.sections[0].stableId).toBe('sec-dev-ops-2');
    expect(parsed.sections[0].items.map((i) => i.stableId))
      .toEqual(['link-dev-ops-ado', 'link-dev-ops-ado-2', 'link-keep']);
    expect(parsed.sections[1].stableId).toBe('sec-dev-ops');
  });

  it('is idempotent', () => {
    const once = assignStableIds(src).output;
    expect(assignStableIds(once)).toEqual({ output: once, changes: [] });
  });
});

describe('server-side visibility', () => {
  const alice = { username: 'Alice', groups: ['eng'], roles: ['viewer'] };

  it('applies user, group and role rules case-appropriately', () => {
    expect(isVisibleToPrincipal({ hideForUsers: ['alice'] }, alice)).toBe(false);
    expect(isVisibleToPrincipal({ showForUsers: ['bob'] }, alice)).toBe(false);
    expect(isVisibleToPrincipal({ showForUsers: ['ALICE'] }, alice)).toBe(true);
    expect(isVisibleToPrincipal({ showForGroups: ['finance'] }, alice)).toBe(false);
    expect(isVisibleToPrincipal({ showForGroups: ['eng'] }, alice)).toBe(true);
    expect(isVisibleToPrincipal({ hideForRoles: ['viewer'] }, alice)).toBe(false);
    expect(isVisibleToPrincipal({ showForKeycloakUsers: { groups: ['eng'] } }, alice)).toBe(true);
    expect(isVisibleToPrincipal({ showForKeycloakUsers: {} }, alice)).toBe(false);
    expect(isVisibleToPrincipal(undefined, alice)).toBe(true);
  });

  it('filters sections and items before anything is merged', () => {
    const sections = [
      { name: 'Fin', stableId: 's1', displayData: { showForGroups: ['finance'] }, items: [{ title: 'x', stableId: 'a' }] },
      { name: 'All', stableId: 's2', items: [{ title: 'y', stableId: 'b', displayData: { hideForUsers: ['alice'] } }, { title: 'z', stableId: 'c' }] },
    ];
    expect(filterAuthorized(sections, alice)).toEqual([
      { name: 'All', stableId: 's2', items: [{ title: 'z', stableId: 'c' }] },
    ]);
  });
});
