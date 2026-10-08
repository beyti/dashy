// @vitest-environment node
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import { dump as yamlDump } from 'js-yaml';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

/* A tiny local OIDC provider: discovery doc + JWKS, so tokens are verified for real */
let issuer;
let idp;
let signingKey;
let rogueKey;
let app;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashy-personal-oidc-'));

const sign = (claims, { key = signingKey, aud = 'dashy', iss = issuer, exp = '5m' } = {}) => new SignJWT(claims)
  .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
  .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp)
  .sign(key);

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  rogueKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    } else if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => { idp.listen(0, '127.0.0.1', r); });
  issuer = `http://127.0.0.1:${idp.address().port}`;

  fs.writeFileSync(path.join(tmpDir, 'conf.yml'), yamlDump({
    appConfig: { auth: { enableOidc: true, oidc: { endpoint: issuer, clientId: 'dashy', adminGroup: 'admins' } } },
    sections: [
      { name: 'Everyone', stableId: 'sec-all', items: [{ title: 'Wiki', url: 'https://wiki.example.com', stableId: 'link-wiki' }] },
      {
        name: 'Engineering', stableId: 'sec-eng', displayData: { showForGroups: ['eng'] }, items: [{ title: 'Repo', url: 'https://git.example.com', stableId: 'link-repo' }],
      },
    ],
  }));
  process.env.USER_DATA_DIR = tmpDir;
  process.env.ENABLE_USER_OVERRIDES = 'true';
  process.env.DATABASE_PATH = path.join(tmpDir, 'tools.sqlite');
  app = require('../../services/app');
});

afterAll(() => {
  idp?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ENABLE_USER_OVERRIDES;
  delete process.env.DATABASE_PATH;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const save = (token, expectedRevision, hidden) => request(app).put('/api/me/preferences').set(bearer(token))
  .send({ expectedRevision, preferences: { schemaVersion: 1, hiddenGlobalLinkIds: hidden } });

describe('OIDC-backed identity', () => {
  it('accepts a correctly signed token and keys the record on iss + sub', async () => {
    const token = await sign({ sub: 'user-123', preferred_username: 'alice' });
    expect((await save(token, 0, ['link-wiki'])).status).toBe(200);
    // Same subject, new token (e.g. after renewal / on another device), same record
    const again = await sign({ sub: 'user-123', preferred_username: 'alice.renamed@example.com' });
    const res = await request(app).get('/api/me/preferences').set(bearer(again));
    expect(res.body.revision).toBe(1);
    // A different subject sharing the display name gets its own record
    const imposter = await sign({ sub: 'user-999', preferred_username: 'alice' });
    expect((await request(app).get('/api/me/preferences').set(bearer(imposter))).body.revision).toBe(0);
  });

  it.each([
    ['wrong audience', () => sign({ sub: 'x' }, { aud: 'other-app' })],
    ['wrong issuer', () => sign({ sub: 'x' }, { iss: 'https://evil.example.com' })],
    ['expired', () => sign({ sub: 'x' }, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['untrusted signing key', () => sign({ sub: 'x' }, { key: rogueKey })],
    ['unsigned (alg none)', async () => {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${b64({ alg: 'none' })}.${b64({ sub: 'x', iss: issuer, aud: 'dashy', exp: 9999999999 })}.`;
    }],
    ['garbage', async () => 'not.a.jwt'],
  ])('rejects a %s token', async (_, makeToken) => {
    const res = await request(app).get('/api/me/dashboard').set(bearer(await makeToken()));
    expect(res.status).toBe(401);
  });

  it('rejects requests with no token', async () => {
    expect((await request(app).get('/api/me/dashboard')).status).toBe(401);
  });

  it('applies group visibility from verified claims, not from the client', async () => {
    const eng = await sign({ sub: 'eng-1', groups: ['eng'] });
    const other = await sign({ sub: 'sales-1', groups: ['sales'] });
    const engView = await request(app).get('/api/me/dashboard').set(bearer(eng));
    const otherView = await request(app).get('/api/me/dashboard').set(bearer(other))
      .set('X-Groups', 'eng').query({ groups: 'eng' });
    expect(engView.body.config.sections.map((s) => s.stableId)).toEqual(['sec-all', 'sec-eng']);
    expect(otherView.body.config.sections.map((s) => s.stableId)).toEqual(['sec-all']);
    expect(otherView.text).not.toMatch(/git\.example\.com/);
  });
});
