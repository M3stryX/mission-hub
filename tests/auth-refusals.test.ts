import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import {
  loadClientCredentials,
  type ClientCredential,
  type Scope,
} from '../src/auth/config.js';
import type { MissionHubStore } from '../src/db/store.js';

/**
 * Contract v3.0 refusal vocabulary (mission #339, defect P2/P6).
 *
 * `401` used to mean three different things at once — no credential, unknown
 * token, missing scope — because `requirePrincipal()` collapsed the last two
 * into a single `null`, and 34 call sites turned that `null` into
 * `401 {"error":"unauthorized"}`. A caller holding a perfectly valid but
 * under-scoped token was therefore told to rotate a secret that was fine.
 *
 * These tests pin the four statuses apart, pin `required` to the scopes the
 * route actually lacked, and pin the boot log that names dropped scopes.
 * They need no database: the env credentials and one stub lookup
 * (`findActiveClientByTokenHash`) are the whole surface involved.
 */

const READER: ClientCredential = {
  clientId: 'reader',
  token: 'mh_reader_token',
  scopes: new Set<Scope>(['missions:read']),
};

const RUNS_ONLY: ClientCredential = {
  clientId: 'runs-only',
  token: 'mh_runs_only_token',
  scopes: new Set<Scope>(['runs:read']),
};

const ADMIN_TOKEN = 'mh_admin_token';

/** An unknown token must stay unknown: no DB-backed client ever resolves. */
const store = {
  findActiveClientByTokenHash: async () => null,
} as unknown as MissionHubStore;

const app = createApp(store, {
  envCredentials: [READER, RUNS_ONLY],
  adminToken: ADMIN_TOKEN,
});

interface CallOptions {
  method?: string;
  token?: string;
  authorization?: string;
}

async function call(
  path: string,
  { method = 'GET', token, authorization }: CallOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Every request carries an explicit Host: `app.request()` builds a synthetic
  // Request, and the Host guard cannot read that header back otherwise.
  const headers: Record<string, string> = { Host: 'localhost' };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await app.request(`http://localhost${path}`, {
    method,
    headers,
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('403 insufficient_scope — at least one route per family', () => {
  const families: Array<{
    family: string;
    method: string;
    path: string;
    scope: Scope;
  }> = [
    {
      family: 'missions',
      method: 'POST',
      path: '/api/v1/missions',
      scope: 'missions:write',
    },
    { family: 'runs', method: 'POST', path: '/api/v1/runs', scope: 'runs:write' },
    {
      family: 'summaries',
      method: 'POST',
      path: '/api/v1/runs/1/summaries',
      scope: 'summaries:write',
    },
    {
      family: 'evidence',
      method: 'POST',
      path: '/api/v1/runs/1/evidence',
      scope: 'evidence:write',
    },
    {
      family: 'admin',
      method: 'POST',
      path: '/api/v1/admin/clients',
      scope: 'clients:admin',
    },
  ];

  it.each(families)(
    '$family: a valid but under-scoped token is refused with 403',
    async ({ method, path, scope }) => {
      const { status, body } = await call(path, { method, token: READER.token });

      expect(status).toBe(403);
      expect(body).toEqual({ error: 'insufficient_scope', required: [scope] });
    },
  );

  it('answers a REST refusal as a REST body, never a JSON-RPC envelope', async () => {
    const { status, body } = await call('/api/v1/missions', {
      method: 'POST',
      token: READER.token,
    });

    expect(status).toBe(403);
    expect(body).not.toHaveProperty('jsonrpc');
    expect(body).not.toHaveProperty('id');
  });
});

describe('403 — the admin token is valid, so it is never told to rotate', () => {
  it('refuses GET /api/v1/missions with 403, not the old 401 (the measured P2 case)', async () => {
    const { status, body } = await call('/api/v1/missions', {
      token: ADMIN_TOKEN,
    });

    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'insufficient_scope',
      required: ['missions:read'],
    });
  });
});

describe('required names the MISSING scopes only', () => {
  it('reports what the credential lacks, not the route’s whole requirement list', async () => {
    // GET /api/v1/missions/:id/research-report needs runs:read + summaries:read.
    const { status, body } = await call('/api/v1/missions/1/research-report', {
      token: RUNS_ONLY.token,
    });

    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'insufficient_scope',
      required: ['summaries:read'],
    });
  });
});

describe('401 unauthorized — the credential itself does not resolve', () => {
  it('refuses a request that presents no credential at all', async () => {
    const { status, body } = await call('/api/v1/missions');

    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('refuses an unknown token without blaming a scope', async () => {
    const { status, body } = await call('/api/v1/missions', {
      token: 'mh_unknown_token',
    });

    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });
});

describe('400 invalid_authorization — a header that is not a credential', () => {
  it.each([
    'Token abc',
    'bearer lowercase-scheme',
    'Bearer',
    'Bearer  two-spaces',
    'nonsense',
  ])('refuses %j as a malformed credential, not as a scope problem', async (authorization) => {
    const { status, body } = await call('/api/v1/missions', { authorization });

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_authorization' });
  });
});

describe('scope drop is named at boot (P6)', () => {
  it('logs one line per client, naming every dropped scope and its reason', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const credentials = loadClientCredentials(
        JSON.stringify({
          typo: {
            token: 'mh_typo_token',
            scopes: ['missions:read', 'mission:read', 'clients:admin'],
          },
          clean: { token: 'mh_clean_token', scopes: ['missions:read'] },
        }),
      );

      const lines = spy.mock.calls.map((args) => String(args[0]));

      // The valid scope survives, the misspelling and the privileged scope do not.
      expect(credentials.find((c) => c.clientId === 'typo')?.scopes).toEqual(
        new Set(['missions:read']),
      );
      expect(credentials.find((c) => c.clientId === 'clean')?.scopes).toEqual(
        new Set(['missions:read']),
      );

      // Exactly one line, for the one client that lost a scope.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('client=typo');
      expect(lines[0]).toContain('scopes=1');
      expect(lines[0]).toContain('mission:read(not_a_scope)');
      expect(lines[0]).toContain('clients:admin(privileged)');
    } finally {
      spy.mockRestore();
    }
  });

  it('stays silent for a client whose scopes all resolved', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const credentials = loadClientCredentials(
        JSON.stringify({
          clean: { token: 'mh_clean_token', scopes: ['missions:read'] },
        }),
      );

      expect(credentials).toHaveLength(1);
      expect(spy.mock.calls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
