import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  COMMIT_ENV_KEY,
  readCommit,
  readContractVersion,
  readProductVersion,
} from '../src/build-info.js';
import type { MissionHubStore } from '../src/db/store.js';

const originalCommitEnv = process.env[COMMIT_ENV_KEY];

afterEach(() => {
  if (originalCommitEnv === undefined) delete process.env[COMMIT_ENV_KEY];
  else process.env[COMMIT_ENV_KEY] = originalCommitEnv;
});

function healthRequest() {
  const app = createApp({} as MissionHubStore, {});
  return app.request('http://localhost/health', {
    headers: { Host: 'localhost' },
  });
}

describe('GET /health', () => {
  it('returns 200 and the build identity without requiring database access', async () => {
    delete process.env[COMMIT_ENV_KEY];

    const response = await healthRequest();

    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    // The exact payload: liveness, the build identity, and `approvers` — a COUNT of
    // configured approvers, never an id, a token or any other configuration value.
    // The count exists so a deployment with a dead approval route is visible instead
    // of answering the same bare 403 as an under-scoped client.
    expect(Object.keys(body).sort()).toEqual([
      'approvers',
      'commit',
      'contract',
      'env',
      'status',
      'version',
    ]);
    expect(body).toEqual({
      status: 'ok',
      version: readProductVersion(),
      contract: readContractVersion(),
      // Whatever this checkout resolves: `unknown` in a clean clone, the stamped
      // revision if a build stamp sits beside the sources. `readCommit` is the
      // single source for it, so the test never restates the rule.
      commit: readCommit(),
      env: 'development',
      // No allowlist in this app: the dead approval route must be visible as 0.
      approvers: 0,
    });
  });

  it('reports the commit the running build was made from', async () => {
    process.env[COMMIT_ENV_KEY] = 'b'.repeat(40);

    const response = await healthRequest();

    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      commit: 'b'.repeat(40),
    });
  });
});
