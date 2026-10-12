import { afterEach, describe, expect, it } from 'vitest';
import {
  allowedHostsFor,
  assertHostAllowlistConfigured,
  createApp,
  DEFAULT_ALLOWED_HOSTS,
  getAllowedHosts,
  getEnv,
  isHostAllowed,
  LOOPBACK_HOSTS,
} from '../src/app.js';
import {
  readCommit,
  readContractVersion,
  readProductVersion,
} from '../src/build-info.js';
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

  it('rejects a host the configured list omits', () => {
    const env = { MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com' };

    expect(isHostAllowed('other.example.com', env)).toBe(false);
    expect(isHostAllowed('mission-hub.lan', env)).toBe(false);
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

describe('loopback is built in', () => {
  it('always accepts loopback, whatever the configured allowlist says', () => {
    const env = { MISSION_HUB_ALLOWED_HOSTS: 'mission-hub-staging.lan' };

    expect(isHostAllowed('127.0.0.1', env)).toBe(true);
    expect(isHostAllowed('127.0.0.1:3000', env)).toBe(true);
    expect(isHostAllowed('localhost', env)).toBe(true);
    expect(isHostAllowed('mission-hub-staging.lan', env)).toBe(true);
    expect(isHostAllowed('evil.lan', env)).toBe(false);
  });

  it('appends loopback to the configured names, without duplicates', () => {
    expect(
      allowedHostsFor({ MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com' }),
    ).toEqual(['hub.example.com', ...LOOPBACK_HOSTS]);
    expect(
      allowedHostsFor({ MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com,127.0.0.1' }),
    ).toEqual(['hub.example.com', '127.0.0.1', 'localhost']);
  });

  it('answers its own health probe over loopback when the allowlist lists only deployment names', async () => {
    setAllowedHostsEnv('mission-hub-staging.lan');

    expect((await healthRequest('127.0.0.1:3000')).status).toBe(200);
    expect((await healthRequest('localhost')).status).toBe(200);
    expect((await healthRequest('evil.lan')).status).toBe(403);
  });

  it('does not let the built-in entries satisfy the boot policy', () => {
    expect(() =>
      assertHostAllowlistConfigured({ MISSION_HUB_ENV: 'staging' }),
    ).toThrow(/MISSION_HUB_ALLOWED_HOSTS must be set/);
    expect(() =>
      assertHostAllowlistConfigured({
        MISSION_HUB_ENV: 'staging',
        MISSION_HUB_ALLOWED_HOSTS: ' , ',
      }),
    ).toThrow(/empty allowlist/);
  });
});

describe('getEnv', () => {
  it('defaults to development when the variable is unset or blank', () => {
    expect(getEnv({})).toBe('development');
    expect(getEnv({ MISSION_HUB_ENV: '' })).toBe('development');
    expect(getEnv({ MISSION_HUB_ENV: '  ' })).toBe('development');
  });

  it('refuses to guess when the value is unrecognized', () => {
    expect(() => getEnv({ MISSION_HUB_ENV: 'prod' })).toThrow(
      /is not a valid environment/,
    );
    expect(() => getEnv({ MISSION_HUB_ENV: 'production-ish' })).toThrow(
      /is not a valid environment/,
    );
    expect(() => getEnv({ MISSION_HUB_ENV: 'local' })).toThrow(
      /is not a valid environment/,
    );
    expect(() => getEnv({ MISSION_HUB_ENV: 'Production ' })).not.toThrow();
  });

  it('accepts the three environments, case and padding insensitive', () => {
    expect(getEnv({ MISSION_HUB_ENV: 'development' })).toBe('development');
    expect(getEnv({ MISSION_HUB_ENV: 'staging' })).toBe('staging');
    expect(getEnv({ MISSION_HUB_ENV: ' Staging ' })).toBe('staging');
    expect(getEnv({ MISSION_HUB_ENV: 'PRODUCTION' })).toBe('production');
    expect(getEnv({ MISSION_HUB_ENV: ' Production ' })).toBe('production');
  });

  it('ignores the retired MISSION_HUB_STAGE name', () => {
    expect(getEnv({ MISSION_HUB_STAGE: 'production' })).toBe('development');
  });
});

describe('assertHostAllowlistConfigured', () => {
  it('stays silent in development, with or without a declared allowlist', () => {
    expect(() => assertHostAllowlistConfigured({})).not.toThrow();
    expect(() =>
      assertHostAllowlistConfigured({ MISSION_HUB_ENV: 'development' }),
    ).not.toThrow();
  });

  it('refuses to boot a deployed environment without a declared allowlist', () => {
    expect(() =>
      assertHostAllowlistConfigured({ MISSION_HUB_ENV: 'staging' }),
    ).toThrow(/MISSION_HUB_ALLOWED_HOSTS must be set/);
    expect(() =>
      assertHostAllowlistConfigured({ MISSION_HUB_ENV: 'production' }),
    ).toThrow(/MISSION_HUB_ALLOWED_HOSTS must be set/);
  });

  it('refuses to boot a deployed environment with an empty allowlist', () => {
    expect(() =>
      assertHostAllowlistConfigured({
        MISSION_HUB_ENV: 'staging',
        MISSION_HUB_ALLOWED_HOSTS: ' , ',
      }),
    ).toThrow(/empty allowlist/);
  });

  it('accepts a declared allowlist for a deployed environment', () => {
    expect(() =>
      assertHostAllowlistConfigured({
        MISSION_HUB_ENV: 'production',
        MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com',
      }),
    ).not.toThrow();
  });

  it('propagates the unrecognized-value error instead of booting', () => {
    expect(() =>
      assertHostAllowlistConfigured({
        MISSION_HUB_ENV: 'prod',
        MISSION_HUB_ALLOWED_HOSTS: 'hub.example.com',
      }),
    ).toThrow(/is not a valid environment/);
  });
});

describe('Host allowlist middleware', () => {
  it('accepts a host configured through MISSION_HUB_ALLOWED_HOSTS', async () => {
    setAllowedHostsEnv('hub.example.com');

    const response = await healthRequest('hub.example.com');

    expect(response.status).toBe(200);
    // The body shape is owned by tests/health.test.ts; here it proves the
    // request reached the application through the Host allowlist.
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      version: readProductVersion(),
      contract: readContractVersion(),
      commit: readCommit(),
      env: getEnv(),
    });
  });

  it('rejects a host the configured list omits', async () => {
    setAllowedHostsEnv('hub.example.com');

    const response = await healthRequest('mission-hub.lan');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_host',
      host: 'mission-hub.lan',
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
      error: 'invalid_host',
      host: 'agora-mission.lan',
    });
  });

  it.each(['/', '/health', '/ready', '/api/v1/missions'])(
    'refuses %s with a REST body, never the MCP transport envelope',
    async (path) => {
      setAllowedHostsEnv('hub.example.com');

      const app = createApp({} as MissionHubStore, {});
      const response = await app.request(`http://127.0.0.1${path}`, {
        headers: { Host: 'mission-hub.lan' },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'invalid_host',
        host: 'mission-hub.lan',
      });
    },
  );

  it('keeps the JSON-RPC refusal envelope on the /mcp transport', async () => {
    setAllowedHostsEnv('hub.example.com');

    const app = createApp({} as MissionHubStore, {});

    const response = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        Host: 'mission-hub.lan',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Host: mission-hub.lan' },
      id: null,
    });
  });
});
