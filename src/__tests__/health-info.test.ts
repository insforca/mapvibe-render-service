import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { healthIdentity, SERVICE_VERSION } from '../health-info.js';

const SHA = 'c8b9ffdaeee118221aba4cbdcffbd6410dbbcb38';

describe('GET /health identity', () => {
  it('advertises dryRun and catalogueSku, plus a version string', () => {
    const info = healthIdentity({});
    expect(info.capabilities).toEqual(['dryRun', 'catalogueSku']);
    expect(info.version).toBe(SERVICE_VERSION);
    expect(info.version.length).toBeGreaterThan(0);
    expect(info.commit).toBeNull();
    expect(info.build).toBe(SERVICE_VERSION);
  });

  it('publishes a git SHA as the commit and the version@commit build string', () => {
    const info = healthIdentity({ RAILWAY_GIT_COMMIT_SHA: SHA });
    expect(info.commit).toBe(SHA);
    expect(info.build).toBe(`${SERVICE_VERSION}@${SHA}`);
  });

  it('does not echo secrets or a non-SHA commit env value', () => {
    const secret = 'sk_live_not_a_sha_and_must_not_leak';
    const info = healthIdentity({
      RENDER_API_SECRET: secret,
      PRINTFUL_API_KEY: secret,
      GELATO_API_KEY: secret,
      SHOPIFY_ADMIN_TOKEN: secret,
      BLOB_READ_WRITE_TOKEN: secret,
      RAILWAY_GIT_COMMIT_SHA: secret,
      GIT_COMMIT: 'not a sha',
    });
    expect(info.commit).toBeNull();
    expect(info.build).toBe(SERVICE_VERSION);
    expect(JSON.stringify(info)).not.toContain(secret);
    expect(JSON.stringify(info)).not.toContain('PRINTFUL');
    expect(JSON.stringify(info)).not.toContain('GELATO');
    expect(JSON.stringify(info)).not.toContain('TOKEN');
  });

  it('is what GET /health returns, on the public body', () => {
    const source = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    const route = source.slice(source.indexOf("app.get('/health'"), source.indexOf("app.post('/render'"));
    expect(route).toContain('healthIdentity()');
    expect(route).toContain('capabilities: identity.capabilities');
    expect(route).toContain('commit: identity.commit');
    expect(route).toContain('build: identity.build');
    expect(route.indexOf('capabilities: identity.capabilities')).toBeLessThan(route.indexOf('isAuthed'));
  });
});
