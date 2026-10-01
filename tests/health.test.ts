import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { MissionHubStore } from '../src/db/store.js';

describe('GET /health', () => {
  it('returns 200 and an ok status without requiring database access', async () => {
    const app = createApp({} as MissionHubStore, {});
    const response = await app.request('http://localhost/health', {
      headers: { Host: 'localhost' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
