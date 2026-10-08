// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  validatePreferences, emptyPreferences, PreferencesError, LIMITS,
} from '../../services/personalization/preferences';

const L1 = 'usr-link-11111111-1111-4111-8111-111111111111';
const S1 = 'usr-sec-33333333-3333-4333-8333-333333333333';

const catalog = {
  sectionIds: new Set(['sec-devops', 'sec-mon']),
  linkIds: new Set(['link-ado', 'link-grafana']),
  sectionNames: new Set(['DevOps', 'Monitoring']),
};

const link = (over) => ({
  id: L1, sectionId: 'sec-devops', title: 'Mine', url: 'https://example.com', ...over,
});
const doc = (over) => ({ ...emptyPreferences(), ...over });

const expectError = (input, status = 400) => {
  try {
    validatePreferences(input, catalog);
  } catch (e) {
    expect(e).toBeInstanceOf(PreferencesError);
    expect(e.status).toBe(status);
    return e;
  }
  throw new Error('expected validation to fail');
};

describe('validatePreferences', () => {
  it('accepts an empty document and fills defaults', () => {
    expect(validatePreferences({ schemaVersion: 1 }, catalog)).toEqual(emptyPreferences());
  });

  it('accepts a valid full document', () => {
    const out = validatePreferences(doc({
      personalSections: [{ id: S1, title: 'My Tools 2', icon: 'fas fa-star' }],
      personalLinks: [link({ sectionId: S1, description: 'x', icon: 'si-github' })],
      hiddenGlobalLinkIds: ['link-ado'],
      hiddenGlobalSectionIds: ['sec-mon'],
      sectionOrder: [S1, 'sec-devops'],
      linkOrderBySection: { [S1]: [L1] },
    }), catalog);
    expect(out.personalLinks[0]).toMatchObject({ id: L1, sectionId: S1 });
    expect(out.hiddenGlobalLinkIds).toEqual(['link-ado']);
  });

  it('strips unknown root fields (e.g. identity or appConfig smuggling)', () => {
    const out = validatePreferences({ ...doc(), user_id: 'someone-else', appConfig: { auth: {} } }, catalog);
    expect(out).not.toHaveProperty('user_id');
    expect(out).not.toHaveProperty('appConfig');
  });

  it('rejects unknown nested fields', () => {
    expectError(doc({ personalLinks: [link({ onclick: 'alert(1)' })] }));
  });

  it.each([
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd',
    'vbscript:x', 'not a url', 'https://exa mple.com', ' https://example.com', 'https://example.com/\n',
  ])('rejects unsafe URL %s', (url) => {
    expectError(doc({ personalLinks: [link({ url })] }));
  });

  it('rejects unsafe icons', () => {
    expectError(doc({ personalLinks: [link({ icon: 'javascript:alert(1)' })] }));
    expectError(doc({ personalLinks: [link({ icon: '"><img src=x onerror=alert(1)>' })] }));
    expectError(doc({ personalLinks: [link({ icon: 'data:image/svg+xml;base64,AAAA' })] }));
    expect(() => validatePreferences(doc({ personalLinks: [link({ icon: ':rocket:' })] }), catalog)).not.toThrow();
    expect(() => validatePreferences(doc({ personalLinks: [link({ icon: 'https://x.example.com/i.png' })] }), catalog)).not.toThrow();
  });

  it('rejects invalid or colliding IDs', () => {
    expectError(doc({ personalLinks: [link({ id: 'link-ado' })] }));
    expectError(doc({ personalLinks: [link({ id: 'usr-link-123' })] }));
    expectError(doc({ personalLinks: [link(), link()] }));
    expectError(doc({ personalSections: [{ id: 'sec-devops', title: 'x' }] }));
  });

  it('returns 403 when a link targets an unauthorized or unknown section', () => {
    expectError(doc({ personalLinks: [link({ sectionId: 'sec-secret' })] }), 403);
  });

  it('rejects personal section names that clash with company sections', () => {
    expectError(doc({ personalSections: [{ id: S1, title: 'devops' }] }));
  });

  it('requires titles and enforces length bounds', () => {
    expectError(doc({ personalLinks: [link({ title: '   ' })] }));
    expectError(doc({ personalLinks: [link({ title: 'x'.repeat(LIMITS.title + 1) })] }));
    expectError(doc({ personalLinks: [link({ url: `https://e.com/${'a'.repeat(LIMITS.url)}` })] }));
  });

  it('enforces array bounds', () => {
    const many = Array.from({ length: LIMITS.personalLinks + 1 }, (_, i) => link({
      id: `usr-link-${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }));
    expectError(doc({ personalLinks: many }));
  });

  it('rejects wrong schema versions and non-objects', () => {
    expectError({ schemaVersion: 2 });
    expectError(null);
    expectError([]);
    expectError('x');
  });

  it('silently drops references outside the authorized catalog', () => {
    const out = validatePreferences(doc({
      hiddenGlobalLinkIds: ['link-ado', 'link-secret', 'link-ado'],
      hiddenGlobalSectionIds: ['sec-secret'],
      sectionOrder: ['sec-secret', 'sec-mon'],
      linkOrderBySection: { 'sec-secret': ['link-ado'], 'sec-mon': ['link-secret', 'link-grafana'] },
    }), catalog);
    expect(out.hiddenGlobalLinkIds).toEqual(['link-ado']);
    expect(out.hiddenGlobalSectionIds).toEqual([]);
    expect(out.sectionOrder).toEqual(['sec-mon']);
    expect(out.linkOrderBySection).toEqual({ 'sec-mon': ['link-grafana'] });
  });

  it('respects USER_OVERRIDES_URL_SCHEMES but never allows dangerous schemes', () => {
    process.env.USER_OVERRIDES_URL_SCHEMES = 'https,ssh,javascript';
    try {
      expect(() => validatePreferences(doc({ personalLinks: [link({ url: 'ssh://host' })] }), catalog)).not.toThrow();
      expectError(doc({ personalLinks: [link({ url: 'http://example.com' })] }));
      expectError(doc({ personalLinks: [link({ url: 'javascript:alert(1)' })] }));
    } finally {
      delete process.env.USER_OVERRIDES_URL_SCHEMES;
    }
  });
});
