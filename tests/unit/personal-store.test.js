import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

/* conf.yml as served when ENABLE_USER_OVERRIDES is on: no sections, plus the marker */
const SHELL_YAML = 'pageInfo:\n  title: Company\nappConfig: {}\n_personalization:\n  enabled: true\n';

const api = vi.hoisted(() => ({
  fetchDashboard: vi.fn(),
  savePreferences: vi.fn(),
  resetPreferences: vi.fn(),
}));
vi.mock('@/utils/personalization/PersonalApi', () => api);
vi.mock('@/utils/request', () => ({ default: { get: vi.fn(async () => ({ data: SHELL_YAML })) } }));
vi.mock('@/utils/logging/ErrorHandler', () => ({
  default: vi.fn(), InfoHandler: vi.fn(), InfoKeys: {}, WarningInfoHandler: vi.fn(),
}));

const dashboardFor = (user, extra = []) => ({
  config: {
    sections: [{
      name: 'DevOps',
      stableId: 'sec-devops',
      items: [{ title: 'ADO', url: 'https://ado.example.com', stableId: 'link-ado' }, ...extra],
    }],
  },
  catalog: [{ id: 'sec-devops', name: 'DevOps', links: [{ id: 'link-ado', title: 'ADO' }] }],
  hidden: { sections: [], links: [] },
  preferences: { schemaVersion: 1, personalLinks: [], hiddenGlobalLinkIds: [] },
  preferenceRevision: 3,
  baseRevision: `rev-${user}`,
});
const ALICE_LINK = {
  title: 'Alice private', url: 'https://alice.example.com', stableId: 'usr-link-11111111-1111-4111-8111-111111111111',
};

let store;
let Keys;

beforeEach(async () => {
  vi.resetModules();
  Object.values(api).forEach((fn) => fn.mockReset());
  localStorage.getItem.mockReset();
  localStorage.setItem.mockReset();
  await import('@/utils/config/ConfigHelpers'); // Same load order as the app (avoids an upstream import cycle)
  store = (await import('@/store')).default;
  Keys = (await import('@/utils/StoreMutations')).default;
});

const sectionTitles = () => store.state.config.sections.flatMap((s) => s.items.map((i) => i.title));

describe('store with server-side personalization', () => {
  it('renders sections from the API, never from stale localStorage', async () => {
    // A previous user's locally saved Dashy config is still in this browser
    localStorage.getItem.mockImplementation((key) => (key === 'confSections'
      ? JSON.stringify([{ name: 'Stale', items: [{ title: 'Old local link' }] }]) : null));
    api.fetchDashboard.mockResolvedValue(dashboardFor('alice'));
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    expect(store.getters.isPersonalized).toBe(true);
    expect(sectionTitles()).toEqual(['ADO']);
    expect(store.state.isUsingLocalConfig).toBe(false);
    expect(store.state.personal.revision).toBe(3);
  });

  it('only allows personal saving, never local or disk saves', async () => {
    api.fetchDashboard.mockResolvedValue(dashboardFor('alice'));
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    expect(store.getters.permissions).toMatchObject({
      allowWriteToDisk: false, allowSaveLocally: false, allowViewConfig: true,
    });
  });

  it('saves deltas with the expected revision, and refreshes from the server', async () => {
    api.fetchDashboard.mockResolvedValue(dashboardFor('alice'));
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    store.commit(Keys.REMOVE_ITEM, { itemId: store.state.config.sections[0].items[0].id, sectionName: 'DevOps' });
    api.savePreferences.mockResolvedValue({ ok: true, revision: 4 });
    api.fetchDashboard.mockResolvedValue({ ...dashboardFor('alice'), preferenceRevision: 4 });
    const result = await store.dispatch(Keys.SAVE_PERSONAL_DASHBOARD);
    expect(result).toEqual({ ok: true });
    const [doc, revision] = api.savePreferences.mock.calls[0];
    expect(revision).toBe(3);
    expect(doc.hiddenGlobalLinkIds).toEqual(['link-ado']);
    expect(doc).not.toHaveProperty('sections'); // never the full merged config
    expect(store.state.personal.revision).toBe(4);
  });

  it('on 409 reports the conflict and keeps the unsaved draft', async () => {
    api.fetchDashboard.mockResolvedValue(dashboardFor('alice'));
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    store.commit(Keys.INSERT_ITEM, { newItem: { title: 'Draft link', url: 'https://d.example.com' }, targetSection: 'DevOps' });
    api.savePreferences.mockResolvedValue({ ok: false, status: 409, currentRevision: 7 });
    const result = await store.dispatch(Keys.SAVE_PERSONAL_DASHBOARD);
    expect(result).toEqual({ ok: false, conflict: true, currentRevision: 7 });
    expect(sectionTitles()).toContain('Draft link');
    // Explicit overwrite uses the newer revision
    api.savePreferences.mockResolvedValue({ ok: true, revision: 8 });
    await store.dispatch(Keys.SAVE_PERSONAL_DASHBOARD, { overwriteRevision: 7 });
    expect(api.savePreferences.mock.calls[1][1]).toBe(7);
  });

  it('keeps the draft on other save errors so the user can retry', async () => {
    api.fetchDashboard.mockResolvedValue(dashboardFor('alice'));
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    store.commit(Keys.INSERT_ITEM, { newItem: { title: 'Draft link', url: 'javascript:x' }, targetSection: 'DevOps' });
    api.savePreferences.mockResolvedValue({ ok: false, status: 400, message: 'URL not allowed' });
    expect(await store.dispatch(Keys.SAVE_PERSONAL_DASHBOARD)).toEqual({ ok: false, message: 'URL not allowed' });
    expect(sectionTitles()).toContain('Draft link');
  });

  it("account switch: B never sees A's personal data", async () => {
    api.fetchDashboard.mockResolvedValue(dashboardFor('alice', [ALICE_LINK]));
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    expect(sectionTitles()).toContain('Alice private');

    store.commit(Keys.AUTH_CHANGED); // logout / login
    expect(store.state.personal).toBeNull();
    expect(store.state.rootConfig).toBeNull();
    expect(store.state.config.sections).toEqual([]);

    api.fetchDashboard.mockResolvedValue(dashboardFor('bob'));
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    expect(sectionTitles()).toEqual(['ADO']);
    expect(store.state.personal.baseRevision).toBe('rev-bob');
  });

  it('never writes personalized data to browser storage', async () => {
    api.fetchDashboard.mockResolvedValue(dashboardFor('alice', [ALICE_LINK]));
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    api.savePreferences.mockResolvedValue({ ok: true, revision: 4 });
    await store.dispatch(Keys.SAVE_PERSONAL_DASHBOARD);
    const written = JSON.stringify(localStorage.setItem.mock.calls);
    expect(written).not.toMatch(/alice\.example\.com|Alice private|usr-link/);
  });

  it('does not render a dashboard when the personal fetch is unauthorized', async () => {
    api.fetchDashboard.mockRejectedValue({ response: { status: 401 } });
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    expect(store.state.config.sections).toEqual([]);
    expect(store.state.criticalError).toMatch(/Sign in/);
  });

  it('resets with the current revision', async () => {
    api.fetchDashboard.mockResolvedValue(dashboardFor('alice'));
    await store.dispatch(Keys.INITIALIZE_CONFIG);
    api.resetPreferences.mockResolvedValue({ ok: true });
    expect(await store.dispatch(Keys.RESET_PERSONAL_DASHBOARD)).toEqual({ ok: true });
    expect(api.resetPreferences).toHaveBeenCalledWith(3);
  });
});
