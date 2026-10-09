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
      'research.listReports',
      'research.getCanonicalReport',
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

    const researchMission = await client.callTool({
      name: 'missions.create',
      arguments: { title: 'MCP research mission', status: 'todo', priority: 2 },
    });
    const researchMissionId = (
      researchMission.structuredContent as { result: { id: number } }
    ).result.id;

    const researchRun = await client.callTool({
      name: 'runs.create',
      arguments: {
        missionId: researchMissionId,
        runtime: 'opencode',
        agent: 'researcher',
        externalSessionId: 'mcp-research-session',
        externalRunId: 'mcp-research-run',
        purpose: 'research',
      },
    });
    expect(researchRun.isError).not.toBe(true);
    const researchRunId = (
      researchRun.structuredContent as { result: { id: number } }
    ).result.id;

    const researchSummary = await client.callTool({
      name: 'runs.recordSummary',
      arguments: {
        runId: researchRunId,
        type: 'research_report',
        content: 'MCP research report',
        metadata: { schemaVersion: '1.0.0' },
      },
    });
    expect(researchSummary.isError).not.toBe(true);

    const canonical = await client.callTool({
      name: 'research.getCanonicalReport',
      arguments: { missionId: researchMissionId },
    });
    expect(canonical.isError).not.toBe(true);
    expect(
      (canonical.structuredContent as { result: { type: string } }).result.type,
    ).toBe('research_report');

    await client.close();
  });

  it('accepts valid stage on create/update and rejects invalid stage', async () => {
    const client = new Client(
      { name: 'mission-hub-stage-test', version: '1.0.0' },
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

    const created = await client.callTool({
      name: 'missions.create',
      arguments: { title: 'MCP stage mission', stage: 'execution' },
    });
    expect(created.isError).not.toBe(true);
    const mission = (
      created.structuredContent as { result: { id: number; stage: string } }
    ).result;
    expect(mission.stage).toBe('execution');

    const updated = await client.callTool({
      name: 'missions.update',
      arguments: { id: mission.id, stage: 'done' },
    });
    expect(updated.isError).not.toBe(true);
    expect(
      (updated.structuredContent as { result: { stage: string } }).result.stage,
    ).toBe('done');

    const invalid = await client.callTool({
      name: 'missions.create',
      arguments: { title: 'MCP bad stage', stage: 'bogus' },
    });
    expect(invalid.isError).toBe(true);

    await client.close();
  });
});
