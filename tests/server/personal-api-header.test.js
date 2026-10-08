// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { describe, it, expect, afterAll } from 'vitest';
import { dump as yamlDump } from 'js-yaml';

/* Header auth where the test client is NOT the trusted proxy: identity headers must be ignored */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashy-personal-header-'));
fs.writeFileSync(path.join(tmpDir, 'conf.yml'), yamlDump({
  appConfig: { auth: { enableHeaderAuth: true, headerAuth: { userHeader: 'Remote-User', proxyWhitelist: ['10.9.9.9'] } } },
  sections: [{ name: 'A', stableId: 'sec-a', items: [] }],
}));
process.env.USER_DATA_DIR = tmpDir;
process.env.ENABLE_USER_OVERRIDES = 'true';
process.env.DATABASE_PATH = path.join(tmpDir, 'tools.sqlite');

const app = require('../../services/app');
const { resolveIdentity } = require('../../services/personalization/identity');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ENABLE_USER_OVERRIDES;
  delete process.env.DATABASE_PATH;
});

describe('trusted proxy header auth', () => {
  it('ignores spoofed identity headers from non-whitelisted clients', async () => {
    const res = await request(app).get('/api/me/dashboard').set('Remote-User', 'ceo');
    expect(res.status).toBe(401);
  });

  it('derives a namespaced identity only from req.auth set by the proxy check', () => {
    const id = resolveIdentity({ auth: { user: 'alice' }, headers: { 'x-user-id': 'bob' } }, { mode: 'header', headerName: 'Remote-User' });
    expect(id.key).toBe('proxy-header:remote-user\u0000alice');
    expect(resolveIdentity({ headers: { 'remote-user': 'alice' } }, { mode: 'header' })).toBeNull();
  });
});

describe('resolveIdentity', () => {
  it('never identifies anonymous requests, even when auth is not configured', () => {
    expect(resolveIdentity({}, { mode: 'none' })).toBeNull();
    expect(resolveIdentity({ auth: { user: 'x' } }, { mode: 'none' })).toBeNull();
  });

  it('requires verified iss + sub for OIDC', () => {
    expect(resolveIdentity({ auth: { user: 'a', claims: { sub: 's' } } }, { mode: 'oidc' })).toBeNull();
    const id = resolveIdentity({
      auth: { user: 'a', claims: { iss: 'https://idp', sub: 's', groups: ['g'], realm_access: { roles: ['r'] } } },
    }, { mode: 'oidc' });
    expect(id).toEqual({
      key: 'https://idp\u0000s', username: 'a', groups: ['g'], roles: ['r'],
    });
  });

  it('keys basic auth case-insensitively and never includes the password', () => {
    const id = resolveIdentity({ auth: { user: 'Alice', password: 'secret' } }, { mode: 'basic-conf' });
    expect(id.key).toBe('basic:conf-users\u0000alice');
    expect(JSON.stringify(id)).not.toMatch(/secret/);
  });
});
