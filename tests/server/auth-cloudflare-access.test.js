// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { loadCloudflareAccessSettings } from '../../services/utils/auth-cloudflare-access';

describe('loadCloudflareAccessSettings', () => {
  it('is null when disabled', () => {
    expect(loadCloudflareAccessSettings({
      enableCloudflareAccess: false,
      cloudflareAccess: { teamDomain: 'acme', aud: 'abc' },
    })).toBe(null);
  });

  it('is null when enabled but missing teamDomain or aud', () => {
    expect(loadCloudflareAccessSettings({
      enableCloudflareAccess: true,
      cloudflareAccess: { aud: 'abc' },
    })).toBe(null);
    expect(loadCloudflareAccessSettings({
      enableCloudflareAccess: true,
      cloudflareAccess: { teamDomain: 'acme' },
    })).toBe(null);
  });

  it('derives the team issuer and default JWKS URL from teamDomain', () => {
    const settings = loadCloudflareAccessSettings({
      enableCloudflareAccess: true,
      cloudflareAccess: { teamDomain: 'acme', aud: 'abc123' },
    });
    expect(settings.issuer).toBe('https://acme.cloudflareaccess.com');
    expect(settings.aud).toBe('abc123');
    expect(settings.certsUrl.href).toBe('https://acme.cloudflareaccess.com/cdn-cgi/access/certs');
  });

  it('is null for a non-object authConfig', () => {
    expect(loadCloudflareAccessSettings(null)).toBe(null);
    expect(loadCloudflareAccessSettings(undefined)).toBe(null);
  });
});
