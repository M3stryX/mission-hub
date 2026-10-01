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

describe.skipIf(!databaseUrl)('MCP v1 agent contract', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const credentials: ClientCredential[] = [
    { clientId: 'mcp-test', token: 'mcp-token', scopes: new Set(allScopes) },
  ];
  const app = createApp(new MissionHubStore(pool), {
    envCredentials: credentials,
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE evidence, summaries, execution_events, mission_claims, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions, api_clients RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('negotiates MCP and exposes the required mission/run tools', async () => {
    const client = new Client(
      { name: 'mission-hub-contract-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL('http://localhost/mcp'),
      {
        requestInit: { headers: { Authorization: 'Bearer mcp-token' } },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const headers = new Headers(request.headers);
          headers.set('host', 'localhost');
          return app.fetch(new Request(request, { headers }));
        },
      },
    );

    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const required of [
      'missions.list',
      'missions.get',
      'missions.create',
      'missions.update',
      'missions.checklist.list',
      'missions.checklist.add',
      'missions.checklist.update',
      'missions.checklist.remove',
      'missions.sources.list',
      'missions.sources.add',
      'missions.sources.remove',
      'missions.events.list',
      'missions.claim.get',
      'missions.claim',
      'missions.claim.renew',
      'missions.claim.release',
      'runs.list',
      'runs.create',
      'runs.updateStatus',
      'runs.listEvents',
      'runs.recordSummary',
      'runs.listSummaries',
      'runs.recordEvidence',
      'runs.listEvidence',
    ]) {
      expect(names).toContain(required);
    }

    const created = await client.callTool({
      name: 'missions.create',
      arguments: { title: 'MCP contract mission', status: 'todo', priority: 1 },
    });
    expect(created.isError).not.toBe(true);

    const updated = await client.callTool({
      name: 'missions.update',
      arguments: {
        id: (created.structuredContent as { result: { id: number } }).result.id,
        status: 'in_progress',
      },
    });
    expect(updated.isError).not.toBe(true);

    await client.close();
  });
});
