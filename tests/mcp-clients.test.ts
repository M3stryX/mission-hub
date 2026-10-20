import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import type { ClientCredential, Scope } from '../src/auth/config.js';
import { MissionHubStore } from '../src/db/store.js';

const databaseUrl = process.env.DATABASE_URL;
const allScopes: Scope[] = [
  'missions:read',
  'missions:write',
  'runs:read',
  'runs:write',
  'summaries:read',
  'summaries:write',
  'evidence:read',
  'evidence:write',
];

const adminToken = 'clients-admin-token';

/** Connects an MCP client that speaks through the app with the given bearer. */
function connect(token: string, app: ReturnType<typeof createApp>) {
  const client = new Client(
    { name: 'mission-hub-clients-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL('http://localhost/mcp'),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set('host', 'localhost');
        return app.fetch(new Request(request, { headers }));
      },
    },
  );
  return client.connect(transport).then(() => client);
}

function errorPayload(result: {
  content?: Array<{ type: string; text?: string }>;
}): { error: string; required?: string[] } {
  const text = result.content?.find((part) => part.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as { error: string; required?: string[] };
}

describe.skipIf(!databaseUrl)('MCP client administration surface', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const credentials: ClientCredential[] = [
    { clientId: 'mcp-test', token: 'mcp-token', scopes: new Set(allScopes) },
    { clientId: 'noscope', token: 'noscope-token', scopes: new Set<Scope>() },
  ];
  const app = createApp(new MissionHubStore(pool), {
    envCredentials: credentials,
    adminToken,
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE evidence, summaries, execution_events, mission_claims, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions, api_clients RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('exposes the clients.* tools and refuses them to a scoped service principal', async () => {
    const client = await connect('mcp-token', app);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const tool of ['clients.list', 'clients.create', 'clients.revoke']) {
        expect(names).toContain(tool);
      }

      const listed = await client.callTool({ name: 'clients.list', arguments: {} });
      expect(listed.isError).toBe(true);
      expect(errorPayload(listed)).toMatchObject({
        error: 'forbidden',
        required: ['clients:admin'],
      });

      const created = await client.callTool({
        name: 'clients.create',
        arguments: { clientId: 'nope', scopes: ['missions:read'] },
      });
      expect(created.isError).toBe(true);
      expect(errorPayload(created)).toMatchObject({
        error: 'forbidden',
        required: ['clients:admin'],
      });

      const revoked = await client.callTool({
        name: 'clients.revoke',
        arguments: { clientId: 'mcp-test' },
      });
      expect(revoked.isError).toBe(true);
      expect(errorPayload(revoked)).toMatchObject({
        error: 'forbidden',
        required: ['clients:admin'],
      });
    } finally {
      await client.close();
    }
  });

  it('lets the admin token mint, list and revoke a client whose token authenticates over REST', async () => {
    const client = await connect(adminToken, app);
    try {
      const created = await client.callTool({
        name: 'clients.create',
        arguments: { clientId: 'mcp-minted', scopes: ['missions:read'] },
      });
      expect(created.isError).not.toBe(true);
      const minted = (
        created.structuredContent as {
          result: { client: { clientId: string; scopes: string[] }; token: string };
        }
      ).result;
      expect(minted.client.clientId).toBe('mcp-minted');
      expect(minted.client.scopes).toEqual(['missions:read']);
      expect(minted.token.startsWith('mh_')).toBe(true);

      const mintedAuth = {
        Host: 'localhost',
        Authorization: `Bearer ${minted.token}`,
      };
      expect(
        (
          await app.request('http://localhost/api/v1/missions', {
            headers: mintedAuth,
          })
        ).status,
      ).toBe(200);

      const listed = await client.callTool({ name: 'clients.list', arguments: {} });
      const clientsList = (
        listed.structuredContent as {
          result: Array<{ clientId: string; revokedAt: string | null }>;
        }
      ).result;
      expect(clientsList.map((entry) => entry.clientId)).toContain('mcp-minted');

      // The REST admin surface still answers for the same principal.
      const restList = await app.request('http://localhost/api/v1/admin/clients', {
        headers: { Host: 'localhost', Authorization: `Bearer ${adminToken}` },
      });
      expect(restList.status).toBe(200);

      const revoked = await client.callTool({
        name: 'clients.revoke',
        arguments: { clientId: 'mcp-minted' },
      });
      expect(revoked.isError).not.toBe(true);
      expect(
        (
          revoked.structuredContent as {
            result: { clientId: string; revokedAt: string | null };
          }
        ).result.revokedAt,
      ).not.toBeNull();

      expect(
        (
          await app.request('http://localhost/api/v1/missions', {
            headers: mintedAuth,
          })
        ).status,
      ).toBe(401);
    } finally {
      await client.close();
    }
  });

  it('rejects mint-forbidden scopes, duplicate ids and unknown revokes', async () => {
    const client = await connect(adminToken, app);
    try {
      const cases: Array<{ clientId: string; scopes: string[] }> = [
        { clientId: 'bad-mint', scopes: ['clients:admin'] },
        { clientId: 'bad-approvals', scopes: ['approvals:human'] },
        { clientId: 'bad-unknown', scopes: ['not-a-scope'] },
      ];
      for (const entry of cases) {
        const rejected = await client.callTool({
          name: 'clients.create',
          arguments: entry,
        });
        expect(rejected.isError).toBe(true);
        expect(errorPayload(rejected).error).toBe('invalid_scopes');
      }

      const first = await client.callTool({
        name: 'clients.create',
        arguments: { clientId: 'dup-client', scopes: ['missions:read'] },
      });
      expect(first.isError).not.toBe(true);

      const duplicate = await client.callTool({
        name: 'clients.create',
        arguments: { clientId: 'dup-client', scopes: ['missions:read'] },
      });
      expect(duplicate.isError).toBe(true);
      expect(errorPayload(duplicate).error).toBe('client_exists');

      const missing = await client.callTool({
        name: 'clients.revoke',
        arguments: { clientId: 'ghost-client' },
      });
      expect(missing.isError).toBe(true);
      expect(errorPayload(missing).error).toBe('not_found');
    } finally {
      await client.close();
    }
  });

  it('still rejects a principal without a service or admin scope on /mcp', async () => {
    const response = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        Authorization: 'Bearer noscope-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(response.status).toBe(401);

    const adminResponse = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Host: 'localhost',
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(adminResponse.status).toBe(200);
  });
});
