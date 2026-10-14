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
import { startMongoMemory } from './helpers/mongo-memory';

/* A tiny local stand-in for Cloudflare's /cdn-cgi/access/certs, so assertions are
   verified for real rather than just trusting claims the test hands over */
const teamIssuer = 'https://test-team.cloudflareaccess.com';
const aud = 'app-aud-tag-123';
let certsServer;
let certsUrl;
let signingKey;
let rogueKey;
let app;
let mongo;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashy-personal-cf-access-'));

const sign = (claims, {
  key = signingKey, audience = aud, issuer = teamIssuer, exp = '5m',
} = {}) => new SignJWT(claims)
  .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
  .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(exp)
  .sign(key);

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  rogueKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  certsServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => { certsServer.listen(0, '127.0.0.1', r); });
  certsUrl = `http://127.0.0.1:${certsServer.address().port}/certs`;

  fs.writeFileSync(path.join(tmpDir, 'conf.yml'), yamlDump({
    appConfig: {
      auth: {
        enableCloudflareAccess: true,
        cloudflareAccess: {
          teamDomain: 'test-team', aud, certsUrl,
        },
      },
    },
    sections: [
      { name: 'Everyone', stableId: 'sec-all', items: [{ title: 'Wiki', url: 'https://wiki.example.com', stableId: 'link-wiki' }] },
      {
        name: 'Engineering', stableId: 'sec-eng', displayData: { showForGroups: ['eng'] }, items: [{ title: 'Repo', url: 'https://git.example.com', stableId: 'link-repo' }],
      },
    ],
  }));
  mongo = await startMongoMemory();
  process.env.USER_DATA_DIR = tmpDir;
  process.env.ENABLE_USER_OVERRIDES = 'true';
  process.env.MONGODB_URI = mongo.uri;
  app = require('../../services/app');
});

afterAll(async () => {
  certsServer?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ENABLE_USER_OVERRIDES;
  delete process.env.MONGODB_URI;
  await mongo.stop();
});

const assertion = (token) => ({ 'Cf-Access-Jwt-Assertion': token });
const save = (token, expectedRevision, hidden) => request(app).put('/api/me/preferences').set(assertion(token))
  .send({ expectedRevision, preferences: { schemaVersion: 1, hiddenGlobalLinkIds: hidden } });

describe('Cloudflare Access-backed identity', () => {
  it('accepts a correctly signed assertion and keys the record on iss + sub', async () => {
    const token = await sign({ sub: 'identity-abc', email: 'alice@example.com' });
    expect((await save(token, 0, ['link-wiki'])).status).toBe(200);
    // Same subject, email changed since (e.g. company rename), same record
    const again = await sign({ sub: 'identity-abc', email: 'alice.new@example.com' });
    const res = await request(app).get('/api/me/preferences').set(assertion(again));
    expect(res.body.revision).toBe(1);
    // A different subject sharing the email gets its own record
    const imposter = await sign({ sub: 'identity-xyz', email: 'alice@example.com' });
    expect((await request(app).get('/api/me/preferences').set(assertion(imposter))).body.revision).toBe(0);
  });

  it('accepts the assertion via the CF_Authorization cookie as well as the header', async () => {
    const token = await sign({ sub: 'cookie-user', email: 'cookie@example.com' });
    const res = await request(app).get('/api/me/dashboard').set('Cookie', `CF_Authorization=${token}`);
    expect(res.status).toBe(200);
  });

  it.each([
    ['wrong audience', () => sign({ sub: 'x', email: 'x@example.com' }, { audience: 'other-app' })],
    ['wrong issuer', () => sign({ sub: 'x', email: 'x@example.com' }, { issuer: 'https://evil-team.cloudflareaccess.com' })],
    ['expired', () => sign({ sub: 'x', email: 'x@example.com' }, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['untrusted signing key', () => sign({ sub: 'x', email: 'x@example.com' }, { key: rogueKey })],
    ['missing email claim', () => sign({ sub: 'x' })],
    ['unsigned (alg none)', async () => {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${b64({ alg: 'none' })}.${b64({
        sub: 'x', email: 'x@example.com', iss: teamIssuer, aud, exp: 9999999999,
      })}.`;
    }],
    ['garbage', async () => 'not.a.jwt'],
  ])('rejects a %s assertion', async (_, makeToken) => {
    const res = await request(app).get('/api/me/dashboard').set(assertion(await makeToken()));
    expect(res.status).toBe(401);
  });

  it('rejects requests with no assertion at all', async () => {
    expect((await request(app).get('/api/me/dashboard')).status).toBe(401);
  });

  it('a forged header claiming to be an email is not enough on its own', async () => {
    const res = await request(app).get('/api/me/dashboard')
      .set('Cf-Access-Authenticated-User-Email', 'ceo@example.com');
    expect(res.status).toBe(401);
  });
});
