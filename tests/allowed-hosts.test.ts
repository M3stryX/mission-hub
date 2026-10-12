import { afterEach, describe, expect, it } from 'vitest';
import {
  assertHostAllowlistConfigured,
  createApp,
  DEFAULT_ALLOWED_HOSTS,
  getAllowedHosts,
  getStage,
  isHostAllowed,
} from '../src/app.js';
import type { MissionHubStore } from '../src/db/store.js';

const ENV_KEY = 'MISSION_HUB_ALLOWED_HOSTS';
const originalEnvValue = process.env[ENV_KEY];

function setAllowedHostsEnv(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
}

function healthRequest(host: string) {
  const app = createApp({} as MissionHubStore, {});
  return app.request('http://127.0.0.1/health', { headers: { Host: host } });
}

afterEach(() => {
  setAllowedHostsEnv(originalEnvValue);
});

describe('getAllowedHosts', () => {
  it('falls back to a loopback-only default when the variable is undefined', () => {
    expect(getAllowedHosts({})).toEqual([...DEFAULT_ALLOWED_HOSTS]);
    expect(getAllowedHosts({})).toEqual(['localhost', '127.0.0.1']);

    setAllowedHostsEnv(undefined);
    expect(getAllowedHosts()).toEqual([...DEFAULT_ALLOWED_HOSTS]);
  });

  it('carries no deployment topology in the built-in default', () => {
    expect(DEFAULT_ALLOWED_HOSTS).not.toContain('mission-hub.lan');
    expect(DEFAULT_ALLOWED_HOSTS).not.toContain('mission-hub-staging.lan');
    expect(DEFAULT_ALLOWED_HOSTS).not.toContain('agora-mission.lan');
  });

  it('uses only the configured hosts when the variable is defined', () => {
    const allowed = getAllowedHosts({
      MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com',
    });

    expect(allowed).toEqual(['hub.example.com']);
    expect(allowed).not.toContain('localhost');
  });

  it('trims CSV entries and drops empty ones', () => {
    expect(
      getAllowedHosts({
        MISSION_HUB_ALLOWED_HOSTS:
          '  hub.example.com ,, internal.example.lan ,   ,  legacy.example  ',
      }),
    ).toEqual(['hub.example.com', 'internal.example.lan', 'legacy.example']);
  });

  it('keeps a defined but empty variable as an empty allowlist', () => {
    expect(getAllowedHosts({ MISSION_HUB_ALLOWED_HOSTS: '  ,  ' })).toEqual([]);
  });
});

describe('isHostAllowed', () => {
  it('accepts a host coming from the environment, with or without a port', () => {
    const env = { MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com,internal.example.lan' };

    expect(isHostAllowed('hub.example.com', env)).toBe(true);
    expect(isHostAllowed('hub.example.com:3000', env)).toBe(true);
    expect(isHostAllowed('internal.example.lan', env)).toBe(true);
  });

  it('rejects a host the defined variable omits', () => {
    const env = { MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com' };

    expect(isHostAllowed('localhost', env)).toBe(false);
    expect(isHostAllowed('other.example.com', env)).toBe(false);
  });

  it('applies the loopback default when the variable is undefined', () => {
    expect(isHostAllowed('localhost', {})).toBe(true);
    expect(isHostAllowed('127.0.0.1', {})).toBe(true);
    expect(isHostAllowed('mission-hub.lan', {})).toBe(false);
    expect(isHostAllowed('rogue.lan', {})).toBe(false);
  });

  it('compares hosts exactly — no wildcard, no substring, no regex', () => {
    expect(
      isHostAllowed('hub.example.com', {
        MISSION_HUB_ALLOWED_HOSTS: '*.example.com',
      }),
    ).toBe(false);
    expect(
      isHostAllowed('hub.example.com', {
        MISSION_HUB_ALLOWED_HOSTS: 'hub.example',
      }),
    ).toBe(false);
    expect(
      isHostAllowed('hub.example.com.evil.lan', {
        MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com',
      }),
    ).toBe(false);
    expect(
      isHostAllowed('hub.example.com', {
        MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com',
      }),
    ).toBe(true);
  });

  it('rejects an empty or missing host header', () => {
    expect(isHostAllowed(undefined, {})).toBe(false);
    expect(isHostAllowed('', {})).toBe(false);
    expect(isHostAllowed('   ', {})).toBe(false);
  });
});

describe('getStage', () => {
  it('defaults to development', () => {
    expect(getStage({})).toBe('development');
    expect(getStage({ MISSION_HUB_STAGE: '' })).toBe('development');
    expect(getStage({ MISSION_HUB_STAGE: '  ' })).toBe('development');
  });

  it('never implies a production capability from an unknown value', () => {
    expect(getStage({ MISSION_HUB_STAGE: 'prod' })).toBe('development');
    expect(getStage({ MISSION_HUB_STAGE: 'production-ish' })).toBe('development');
  });

  it('accepts the two deployed stages, case and padding insensitive', () => {
    expect(getStage({ MISSION_HUB_STAGE: 'staging' })).toBe('staging');
    expect(getStage({ MISSION_HUB_STAGE: ' Staging ' })).toBe('staging');
    expect(getStage({ MISSION_HUB_STAGE: 'PRODUCTION' })).toBe('production');
  });
});

describe('assertHostAllowlistConfigured', () => {
  it('stays silent in development, with or without a declared allowlist', () => {
    expect(() => assertHostAllowlistConfigured({})).not.toThrow();
    expect(() =>
      assertHostAllowlistConfigured({ MISSION_HUB_STAGE: 'development' }),
    ).not.toThrow();
  });

  it('refuses to boot a deployed stage without a declared allowlist', () => {
    expect(() =>
      assertHostAllowlistConfigured({ MISSION_HUB_STAGE: 'staging' }),
    ).toThrow(/MISSION_HUB_ALLOWED_HOSTS must be set/);
    expect(() =>
      assertHostAllowlistConfigured({ MISSION_HUB_STAGE: 'production' }),
    ).toThrow(/MISSION_HUB_ALLOWED_HOSTS must be set/);
  });

  it('refuses to boot a deployed stage with an empty allowlist', () => {
    expect(() =>
      assertHostAllowlistConfigured({
        MISSION_HUB_STAGE: 'staging',
        MISSION_HUB_ALLOWED_HOSTS: ' , ',
      }),
    ).toThrow(/empty allowlist/);
  });

  it('accepts a declared allowlist for a deployed stage', () => {
    expect(() =>
      assertHostAllowlistConfigured({
        MISSION_HUB_STAGE: 'production',
        MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com',
      }),
    ).not.toThrow();
  });
});

describe('Host allowlist middleware', () => {
  it('accepts a host configured through MISSION_HUB_ALLOWED_HOSTS', async () => {
    setAllowedHostsEnv('hub.example.com');

    const response = await healthRequest('hub.example.com');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('rejects a host the configured list omits', async () => {
    setAllowedHostsEnv('hub.example.com');

    const response = await healthRequest('mission-hub.lan');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Host: mission-hub.lan' },
      id: null,
    });
  });

  it('accepts loopback when the variable is not defined', async () => {
    setAllowedHostsEnv(undefined);

    expect((await healthRequest('localhost')).status).toBe(200);
    expect((await healthRequest('127.0.0.1')).status).toBe(200);
  });

  it('rejects a deployment host when the variable is not defined', async () => {
    setAllowedHostsEnv(undefined);

    const response = await healthRequest('agora-mission.lan');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Host: agora-mission.lan' },
      id: null,
    });
  });
});
