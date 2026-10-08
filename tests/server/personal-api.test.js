// @vitest-environment node
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import {
  describe, it, expect, afterAll, beforeEach,
} from 'vitest';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

/* Auth + feature flags are read when app.js loads, so set env first */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashy-personal-'));
const dbPath = path.join(tmpDir, 'data', 'tools.sqlite');
const confFile = path.join(tmpDir, 'conf.yml');

const baseConfig = () => ({
  pageInfo: { title: 'Company Tools' },
  appConfig: {
    theme: 'colorful',
    auth: {
      users: [
        { user: 'alice', hash: sha('alice-pass'), type: 'admin' },
        { user: 'bob', hash: sha('bob-pass'), type: 'normal' },
      ],
    },
  },
  sections: [
    {
      name: 'DevOps',
      stableId: 'sec-devops',
      items: [
        { title: 'ADO', url: 'https://ado.example.com', stableId: 'link-ado' },
        { title: 'Legacy Monitor', url: 'https://legacy.example.com', stableId: 'link-legacy' },
        {
          title: 'Bob-hidden', url: 'https://alice-only-link.example.com', stableId: 'link-not-bob', displayData: { hideForUsers: ['bob'] },
        },
      ],
    },
    {
      name: 'Monitoring',
      stableId: 'sec-mon',
      items: [{ title: 'Grafana', url: 'https://grafana.example.com', stableId: 'link-grafana' }],
    },
    {
      name: 'Finance Secret',
      stableId: 'sec-fin',
      displayData: { showForUsers: ['alice'] },
      items: [{ title: 'Ledger', url: 'https://secret-ledger.example.com', stableId: 'link-ledger' }],
    },
  ],
});

const writeConf = (conf) => fs.writeFileSync(confFile, yamlDump(conf));
writeConf(baseConfig());
process.env.USER_DATA_DIR = tmpDir;
process.env.ENABLE_HTTP_AUTH = 'true';
process.env.ENABLE_USER_OVERRIDES = 'true';
process.env.DATABASE_PATH = dbPath;
process.env.ENABLE_API = 'true';

const app = require('../../services/app');
const { resetBaseConfigCache } = require('../../services/personalization/base-config');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  ['ENABLE_HTTP_AUTH', 'ENABLE_USER_OVERRIDES', 'DATABASE_PATH', 'ENABLE_API'].forEach((k) => delete process.env[k]);
});

const ALICE = ['alice', 'alice-pass'];
const BOB = ['bob', 'bob-pass'];
const L1 = 'usr-link-11111111-1111-4111-8111-111111111111';
const L2 = 'usr-link-22222222-2222-4222-8222-222222222222';
const S1 = 'usr-sec-33333333-3333-4333-8333-333333333333';

const empty = () => ({
  schemaVersion: 1, personalSections: [], personalLinks: [], hiddenGlobalSectionIds: [], hiddenGlobalLinkIds: [], sectionOrder: [], linkOrderBySection: {},
});

const dashboard = (who) => request(app).get('/api/me/dashboard').auth(...who);
const getPrefs = (who) => request(app).get('/api/me/preferences').auth(...who);
const putPrefs = (who, expectedRevision, preferences) => request(app)
  .put('/api/me/preferences').auth(...who).send({ expectedRevision, preferences });
const reset = async (who) => {
  const { body } = await getPrefs(who);
  await request(app).delete('/api/me/preferences').auth(...who).send({ expectedRevision: body.revision });
};
const allIds = (res) => res.body.config.sections.flatMap((s) => [s.stableId, ...s.items.map((i) => i.stableId)]);
const update = async (who, mutate) => {
  const { body } = await getPrefs(who);
  return putPrefs(who, body.revision, mutate(body.preferences));
};

beforeEach(async () => {
  writeConf(baseConfig());
  resetBaseConfigCache();
  await reset(ALICE);
  await reset(BOB);
});

describe('authentication', () => {
  it('rejects unauthenticated reads and writes', async () => {
    expect((await request(app).get('/api/me/dashboard')).status).toBe(401);
    expect((await request(app).get('/api/me/preferences')).status).toBe(401);
    expect((await request(app).put('/api/me/preferences').send({ expectedRevision: 0, preferences: empty() })).status).toBe(401);
    expect((await request(app).delete('/api/me/preferences')).status).toBe(401);
    expect((await request(app).get('/api/me/dashboard').auth('alice', 'wrong')).status).toBe(401);
  });

  it('marks personalized responses as private and uncacheable', async () => {
    const res = await dashboard(ALICE);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers.vary).toMatch(/Authorization/);
  });
});

describe('default catalog (AC1)', () => {
  it('fresh account sees full authorized catalog and zero overrides', async () => {
    const res = await dashboard(ALICE);
    expect(res.status).toBe(200);
    expect(res.body.preferenceRevision).toBe(0);
    expect(res.body.config.sections.map((s) => s.name)).toEqual(['DevOps', 'Monitoring', 'Finance Secret']);
    expect(res.body.baseRevision).toMatch(/^[0-9a-f]{16}$/);
    const prefs = await getPrefs(ALICE);
    expect(prefs.body).toMatchObject({ revision: 0, preferences: empty() });
  });

  it('never leaks unauthorized sections or links, even metadata', async () => {
    const res = await dashboard(BOB);
    expect(res.body.config.sections.map((s) => s.name)).toEqual(['DevOps', 'Monitoring']);
    expect(res.text).not.toMatch(/Finance Secret|secret-ledger|link-ledger|sec-fin|alice-only-link|link-not-bob/);
    expect(res.body.baseRevision).not.toBe((await dashboard(ALICE)).body.baseRevision);
  });

  it('conf.yml no longer exposes sections when personalization is on', async () => {
    const res = await request(app).get('/conf.yml').auth(...BOB);
    const conf = yamlLoad(res.text);
    expect(conf.sections).toBeUndefined();
    expect(conf._personalization).toEqual({ enabled: true });
    expect(conf.pageInfo.title).toBe('Company Tools');
    expect(res.text).not.toMatch(/secret-ledger/);
  });
});

describe('isolation + cross-device persistence (AC2, AC3, AC4, AC12)', () => {
  it('A adds a personal link, B does not see it, A sees it from another client', async () => {
    const saved = await putPrefs(ALICE, 0, {
      ...empty(),
      personalLinks: [{
        id: L1, sectionId: 'sec-devops', title: 'My Pipeline', url: 'https://ci.example.com/me',
      }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe(1);
    expect(allIds(await dashboard(BOB))).not.toContain(L1);
    // "Browser 2": a fresh agent with no shared state, only credentials
    const other = await request.agent(app).get('/api/me/dashboard').auth(...ALICE);
    expect(other.body.config.sections[0].items.map((i) => i.title)).toContain('My Pipeline');
  });

  it('A hides global link X, B still sees X, A can unhide X', async () => {
    await update(ALICE, (p) => ({ ...p, hiddenGlobalLinkIds: ['link-legacy'] }));
    expect(allIds(await dashboard(ALICE))).not.toContain('link-legacy');
    expect(allIds(await dashboard(BOB))).toContain('link-legacy');
    const hidden = (await dashboard(ALICE)).body.hidden.links;
    expect(hidden.map((l) => l.id)).toEqual(['link-legacy']);
    await update(ALICE, (p) => ({ ...p, hiddenGlobalLinkIds: [] }));
    expect(allIds(await dashboard(ALICE))).toContain('link-legacy');
  });

  it('ignores forged identities in body and query', async () => {
    const res = await request(app).put('/api/me/preferences?user_id=bob&subject=bob').auth(...ALICE)
      .send({
        user_id: 'bob', subject: 'bob', identity_key: 'bob', expectedRevision: 0, preferences: { ...empty(), user_id: 'bob', hiddenGlobalLinkIds: ['link-ado'] },
      });
    expect(res.status).toBe(200);
    expect(res.body.preferences).not.toHaveProperty('user_id');
    expect(allIds(await dashboard(BOB))).toContain('link-ado');
    expect(allIds(await dashboard(ALICE))).not.toContain('link-ado');
    const bobView = await request(app).get('/api/me/preferences?user_id=alice').auth(...BOB);
    expect(bobView.body.revision).toBe(0);
  });

  it('there is no route that addresses another user', async () => {
    expect((await request(app).get('/api/me/preferences/bob').auth(...ALICE)).status).toBe(404);
    expect((await request(app).get('/api/me/users/bob/preferences').auth(...ALICE)).status).toBe(404);
  });
});

describe('company default changes (AC5, AC6, AC7, AC8, AC9)', () => {
  it('new global link Y appears for everyone unless its section is hidden', async () => {
    await update(BOB, (p) => ({ ...p, hiddenGlobalSectionIds: ['sec-mon'] }));
    const conf = baseConfig();
    conf.sections[1].items.push({ title: 'Loki', url: 'https://loki.example.com', stableId: 'link-loki' });
    writeConf(conf);
    resetBaseConfigCache();
    expect(allIds(await dashboard(ALICE))).toContain('link-loki');
    expect(allIds(await dashboard(BOB))).not.toContain('link-loki');
  });

  it('a rename keeps the hide; a delete removes X and stale IDs do not crash', async () => {
    await update(ALICE, (p) => ({
      ...p, hiddenGlobalLinkIds: ['link-legacy'], linkOrderBySection: { 'sec-devops': ['link-legacy', 'link-ado'] },
    }));
    const renamed = baseConfig();
    renamed.sections[0].items[1].title = 'Old Monitor (renamed)';
    writeConf(renamed);
    resetBaseConfigCache();
    expect(allIds(await dashboard(ALICE))).not.toContain('link-legacy');
    expect(allIds(await dashboard(BOB))).toContain('link-legacy');

    const deleted = baseConfig();
    deleted.sections[0].items.splice(1, 1);
    writeConf(deleted);
    resetBaseConfigCache();
    const res = await dashboard(ALICE);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/Legacy Monitor/);
    expect((await dashboard(BOB)).text).not.toMatch(/Legacy Monitor/);
    // Stale references are dropped on the next read
    expect((await getPrefs(ALICE)).body.preferences.hiddenGlobalLinkIds).toEqual([]);
  });

  it('a personal link in a deleted global section survives in My Tools', async () => {
    await putPrefs(ALICE, 0, {
      ...empty(), personalLinks: [{ id: L1, sectionId: 'sec-mon', title: 'Mine', url: 'https://mine.example.com' }],
    });
    const conf = baseConfig();
    conf.sections.splice(1, 1);
    writeConf(conf);
    resetBaseConfigCache();
    const res = await dashboard(ALICE);
    const myTools = res.body.config.sections.find((s) => s.name === 'My Tools');
    expect(myTools.items.map((i) => i.stableId)).toEqual([L1]);
    // ...and the user can save again from that state
    const p = (await getPrefs(ALICE)).body;
    const resave = await putPrefs(ALICE, p.revision, {
      ...p.preferences,
      personalSections: [{ id: 'usr-sec-my-tools', title: 'My Tools' }],
      personalLinks: p.preferences.personalLinks.map((l) => ({ ...l, sectionId: 'usr-sec-my-tools' })),
    });
    expect(resave.status).toBe(200);
  });

  it('order is stable across refreshes and new defaults append deterministically', async () => {
    await update(ALICE, (p) => ({
      ...p,
      personalSections: [{ id: S1, title: 'Mine' }],
      sectionOrder: ['sec-mon', S1, 'sec-devops'],
      linkOrderBySection: { 'sec-devops': ['link-legacy', 'link-ado'] },
    }));
    const first = await dashboard(ALICE);
    expect(first.body.config.sections.map((s) => s.name)).toEqual(['Monitoring', 'Mine', 'DevOps', 'Finance Secret']);
    expect((await dashboard(ALICE)).body.config).toEqual(first.body.config);
    const conf = baseConfig();
    conf.sections.push({ name: 'Analytics', stableId: 'sec-ana', items: [] });
    conf.sections[0].items.push({ title: 'New', url: 'https://new.example.com', stableId: 'link-new' });
    writeConf(conf);
    resetBaseConfigCache();
    const after = await dashboard(ALICE);
    expect(after.body.config.sections.map((s) => s.name)).toEqual(['Monitoring', 'Mine', 'DevOps', 'Finance Secret', 'Analytics']);
    expect(after.body.config.sections[2].items.map((i) => i.stableId)).toEqual(['link-legacy', 'link-ado', 'link-not-bob', 'link-new']);
  });

  it('picks up conf.yml changes on disk without a restart', async () => {
    const before = (await dashboard(BOB)).body.baseRevision;
    const conf = baseConfig();
    conf.sections[0].items[0].title = 'Azure DevOps';
    await new Promise((r) => { setTimeout(r, 1100); });
    writeConf(conf);
    const after = await dashboard(BOB);
    expect(after.body.baseRevision).not.toBe(before);
    expect(after.text).toMatch(/Azure DevOps/);
  });
});

describe('reset (AC10)', () => {
  it('A resets and sees current defaults, B is unchanged', async () => {
    await update(ALICE, (p) => ({ ...p, hiddenGlobalLinkIds: ['link-ado'] }));
    await update(BOB, (p) => ({ ...p, hiddenGlobalLinkIds: ['link-grafana'] }));
    const { body } = await getPrefs(ALICE);
    const del = await request(app).delete('/api/me/preferences').auth(...ALICE).send({ expectedRevision: body.revision });
    expect(del.status).toBe(200);
    expect(allIds(await dashboard(ALICE))).toContain('link-ado');
    expect(allIds(await dashboard(BOB))).not.toContain('link-grafana');
  });

  it('a stale reset is rejected with 409', async () => {
    await update(ALICE, (p) => ({ ...p, hiddenGlobalLinkIds: ['link-ado'] }));
    const res = await request(app).delete('/api/me/preferences?expectedRevision=0').auth(...ALICE);
    expect(res.status).toBe(409);
    expect(res.body.currentRevision).toBe(1);
  });
});

describe('concurrency (AC13)', () => {
  it('two clients with the same revision: first wins, second gets 409 with current revision', async () => {
    const a = await putPrefs(ALICE, 0, { ...empty(), hiddenGlobalLinkIds: ['link-ado'] });
    const b = await putPrefs(ALICE, 0, { ...empty(), hiddenGlobalLinkIds: ['link-grafana'] });
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect(b.body.currentRevision).toBe(1);
    expect((await getPrefs(ALICE)).body.preferences.hiddenGlobalLinkIds).toEqual(['link-ado']);
  });
});

describe('input validation (AC14)', () => {
  it.each([
    ['javascript: URL', { personalLinks: [{ id: L1, sectionId: 'sec-devops', title: 'x', url: 'javascript:alert(1)' }] }, 400],
    ['data: URL', { personalLinks: [{ id: L1, sectionId: 'sec-devops', title: 'x', url: 'data:text/html,hi' }] }, 400],
    ['invalid ID', { personalLinks: [{ id: 'link-ado', sectionId: 'sec-devops', title: 'x', url: 'https://x.example.com' }] }, 400],
    ['duplicate IDs', { personalLinks: [L1, L1].map((id) => ({ id, sectionId: 'sec-devops', title: 'x', url: 'https://x.example.com' })) }, 400],
    ['unknown nested field', { personalLinks: [{ id: L1, sectionId: 'sec-devops', title: 'x', url: 'https://x.example.com', html: '<b>' }] }, 400],
    ['target in unknown section', { personalLinks: [{ id: L2, sectionId: 'sec-nope', title: 'x', url: 'https://x.example.com' }] }, 403],
  ])('rejects %s', async (_, prefs, status) => {
    const res = await putPrefs(ALICE, 0, { ...empty(), ...prefs });
    expect(res.status).toBe(status);
    expect(res.body.success).toBe(false);
    expect((await getPrefs(ALICE)).body.revision).toBe(0);
  });

  it('returns 403 when a user targets a section they are not authorized for', async () => {
    const res = await putPrefs(BOB, 0, {
      ...empty(), personalLinks: [{ id: L1, sectionId: 'sec-fin', title: 'x', url: 'https://x.example.com' }],
    });
    expect(res.status).toBe(403);
  });

  it('drops unauthorized hide/order references instead of storing them', async () => {
    const res = await putPrefs(BOB, 0, { ...empty(), hiddenGlobalLinkIds: ['link-ledger', 'link-ado'], sectionOrder: ['sec-fin'] });
    expect(res.status).toBe(200);
    expect(res.body.preferences.hiddenGlobalLinkIds).toEqual(['link-ado']);
    expect(res.body.preferences.sectionOrder).toEqual([]);
  });

  it('rejects malformed JSON', async () => {
    const res = await request(app).put('/api/me/preferences').auth(...ALICE)
      .set('Content-Type', 'application/json').send('{"expectedRevision": 0, "preferences": ');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Malformed JSON');
  });

  it('rejects enormous payloads with 413', async () => {
    const res = await putPrefs(ALICE, 0, { ...empty(), junk: 'x'.repeat(200 * 1024) });
    expect(res.status).toBe(413);
  });

  it('rejects missing or invalid expectedRevision', async () => {
    expect((await request(app).put('/api/me/preferences').auth(...ALICE).send({ preferences: empty() })).status).toBe(400);
    expect((await putPrefs(ALICE, -1, empty())).status).toBe(400);
    expect((await putPrefs(ALICE, '1; DROP TABLE', empty())).status).toBe(400);
  });

  it('does not expose internals in error responses', async () => {
    const res = await putPrefs(ALICE, 0, { schemaVersion: 7 });
    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/sqlite|SELECT|\/tmp\/|node_modules|stack/i);
  });
});

describe('CSRF protection', () => {
  it('blocks cross-origin writes', async () => {
    const res = await request(app).put('/api/me/preferences').auth(...ALICE)
      .set('Origin', 'https://evil.example.com').send({ expectedRevision: 0, preferences: empty() });
    expect(res.status).toBe(403);
    const fetchMeta = await request(app).delete('/api/me/preferences?expectedRevision=0').auth(...ALICE)
      .set('Sec-Fetch-Site', 'cross-site');
    expect(fetchMeta.status).toBe(403);
  });

  it('requires a JSON content type for writes (simple form posts are refused)', async () => {
    const res = await request(app).put('/api/me/preferences').auth(...ALICE)
      .set('Content-Type', 'text/plain').send('{"expectedRevision":0,"preferences":{"schemaVersion":1}}');
    expect(res.status).toBe(415);
  });

  it('allows same-origin writes', async () => {
    const probe = await request(app).put('/api/me/preferences').auth(...ALICE)
      .set('Host', 'tools.example.com').set('Origin', 'http://tools.example.com')
      .send({ expectedRevision: 0, preferences: empty() });
    expect(probe.status).toBe(200);
  });
});

describe('global config protection (AC17)', () => {
  it('blocks upstream disk writes, even for admins', async () => {
    const save = await request(app).post('/config-manager/save').auth(...ALICE)
      .send({ config: 'pageInfo:\n  title: hacked\n' });
    expect(save.status).toBe(403);
    const apiPut = await request(app).put('/api/config/conf.yml').auth(...ALICE).send({ sections: [] });
    expect(apiPut.status).toBe(403);
    const apiPost = await request(app).post('/api/config/conf.yml/sections').auth(...BOB).send({ name: 'x' });
    expect(apiPost.status).toBe(403);
    expect(yamlLoad(fs.readFileSync(confFile, 'utf8')).pageInfo.title).toBe('Company Tools');
  });

  it('personal endpoints cannot change company defaults', async () => {
    await putPrefs(ALICE, 0, { ...empty(), sections: [{ name: 'Injected' }], appConfig: { theme: 'x' } });
    expect((await dashboard(BOB)).text).not.toMatch(/Injected/);
    expect(fs.readFileSync(confFile, 'utf8')).not.toMatch(/Injected/);
  });
});

describe('operations', () => {
  it('stores data in the configured DATABASE_PATH and reports DB health', async () => {
    expect(fs.existsSync(dbPath)).toBe(true);
    const health = await request(app).get('/healthz');
    expect(health.body.database).toBe('ok');
  });

  it('never stores passwords or display names', async () => {
    await putPrefs(ALICE, 0, { ...empty(), hiddenGlobalLinkIds: ['link-ado'] });
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    const dump = JSON.stringify(raw.prepare('SELECT * FROM user_preferences').all());
    raw.close();
    expect(dump).not.toMatch(/alice-pass|bob-pass/);
  });
});
