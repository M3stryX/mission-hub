import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';

describe('GET /health', () => {
  it('returns 200 and an ok status', async () => {
    const response = await app.request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
