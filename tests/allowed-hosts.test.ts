import { afterEach, describe, expect, it } from 'vitest';
import {
  createApp,
  DEFAULT_ALLOWED_HOSTS,
  getAllowedHosts,
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
  it('falls back to the built-in default, including agora-mission.lan, when the variable is undefined', () => {
    expect(getAllowedHosts({})).toEqual([...DEFAULT_ALLOWED_HOSTS]);
    expect(getAllowedHosts({})).toContain('agora-mission.lan');
    expect(getAllowedHosts({})).toContain('mission-hub.lan');

    setAllowedHostsEnv(undefined);
    expect(getAllowedHosts()).toEqual([...DEFAULT_ALLOWED_HOSTS]);
  });

  it('uses only the configured hosts when the variable is defined', () => {
    const allowed = getAllowedHosts({
      MISSION_HUB_ALLOWED_HOSTS: 'agora-mission.lan',
    });

    expect(allowed).toEqual(['agora-mission.lan']);
    expect(allowed).not.toContain('mission-hub.lan');
    expect(allowed).not.toContain('localhost');
  });

  it('trims CSV entries and drops empty ones', () => {
    expect(
      getAllowedHosts({
        MISSION_HUB_ALLOWED_HOSTS:
          '  agora-mission.lan ,, mission-hub.lan ,   ,  mission.lan  ',
      }),
    ).toEqual(['agora-mission.lan', 'mission-hub.lan', 'mission.lan']);
  });

  it('keeps a defined but empty variable as an empty allowlist', () => {
    expect(getAllowedHosts({ MISSION_HUB_ALLOWED_HOSTS: '  ,  ' })).toEqual([]);
  });
});

describe('isHostAllowed', () => {
  it('accepts a host coming from the environment', () => {
    const env = { MISSION_HUB_ALLOWED_HOSTS: 'agora-mission.lan,mission.lan' };

    expect(isHostAllowed('agora-mission.lan', env)).toBe(true);
    expect(isHostAllowed('agora-mission.lan:3000', env)).toBe(true);
  });

  it('rejects a default host that the defined variable omits', () => {
    const env = { MISSION_HUB_ALLOWED_HOSTS: 'agora-mission.lan' };

    expect(isHostAllowed('mission-hub.lan', env)).toBe(false);
    expect(isHostAllowed('localhost', env)).toBe(false);
    expect(isHostAllowed('mission.lan', env)).toBe(false);
  });

  it('applies the full default list when the variable is undefined', () => {
    expect(isHostAllowed('agora-mission.lan', {})).toBe(true);
    expect(isHostAllowed('mission-hub.lan', {})).toBe(true);
    expect(isHostAllowed('localhost', {})).toBe(true);
    expect(isHostAllowed('rogue.lan', {})).toBe(false);
  });

  it('compares hosts exactly — no wildcard, no substring, no regex', () => {
    expect(
      isHostAllowed('agora-mission.lan', {
        MISSION_HUB_ALLOWED_HOSTS: '*.lan',
      }),
    ).toBe(false);
    expect(
      isHostAllowed('agora-mission.lan', {
        MISSION_HUB_ALLOWED_HOSTS: 'agora-mission',
      }),
    ).toBe(false);
    expect(
      isHostAllowed('agora-mission.lan.evil.lan', {
        MISSION_HUB_ALLOWED_HOSTS: 'agora-mission.lan',
      }),
    ).toBe(false);
    expect(
      isHostAllowed('agora-mission.lan', {
        MISSION_HUB_ALLOWED_HOSTS: 'agora-mission.lan',
      }),
    ).toBe(true);
  });

  it('rejects an empty or missing host header', () => {
    expect(isHostAllowed(undefined, {})).toBe(false);
    expect(isHostAllowed('', {})).toBe(false);
    expect(isHostAllowed('   ', {})).toBe(false);
  });
});

describe('Host allowlist middleware', () => {
  it('accepts a host configured through MISSION_HUB_ALLOWED_HOSTS', async () => {
    setAllowedHostsEnv('agora-mission.lan');

    const response = await healthRequest('agora-mission.lan');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('rejects a default host when MISSION_HUB_ALLOWED_HOSTS omits it', async () => {
    setAllowedHostsEnv('agora-mission.lan');

    const response = await healthRequest('mission-hub.lan');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Host: mission-hub.lan' },
      id: null,
    });
  });

  it('accepts agora-mission.lan when the variable is not defined', async () => {
    setAllowedHostsEnv(undefined);

    const response = await healthRequest('agora-mission.lan');

    expect(response.status).toBe(200);
  });

  it('still rejects a host outside the default list', async () => {
    setAllowedHostsEnv(undefined);

    const response = await healthRequest('rogue.lan');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Host: rogue.lan' },
      id: null,
    });
  });
});
