import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import type { ClientCredential, Scope } from '../src/auth/config.js';
import { MissionHubStore } from '../src/db/store.js';

const databaseUrl = process.env.DATABASE_URL;

const scopes: Scope[] = [
  'missions:read',
  'missions:write',
  'runs:read',
  'runs:write',
  'summaries:read',
  'summaries:write',
  'evidence:read',
  'evidence:write',
];

describe.skipIf(!databaseUrl)('duplicate externalRunId', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const credentials: ClientCredential[] = [
    { clientId: 'runner', token: 'runner-token', scopes: new Set(scopes) },
  ];
  const app = createApp(new MissionHubStore(pool), { envCredentials: credentials });
  const auth = {
    Host: 'localhost',
    Authorization: 'Bearer runner-token',
    'Content-Type': 'application/json',
  };

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE evidence, summaries, execution_events, claim_delegations, mission_claims, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions, api_clients RESTART IDENTITY CASCADE',
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  async function createMission(): Promise<number> {
    const res = await app.request('http://localhost/api/v1/missions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'duplicate run' }),
    });
    return ((await res.json()) as { mission: { id: number } }).mission.id;
  }

  const createRun = (missionId: number, externalRunId: string, sessionId: string) =>
    app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        missionId,
        runtime: 'hermes',
        agent: 'runner',
        externalSessionId: sessionId,
        externalRunId,
      }),
    });

  it('answers 409 run_exists instead of an opaque 500, and names the existing run', async () => {
    const missionId = await createMission();

    const first = await createRun(missionId, 'ext-1', 'sess-1');
    expect(first.status).toBe(201);
    const firstRun = ((await first.json()) as { run: { id: number } }).run;

    const second = await createRun(missionId, 'ext-1', 'sess-2');
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      error: string;
      externalRunId: string;
      runId: number;
    };
    expect(body.error).toBe('run_exists');
    expect(body.externalRunId).toBe('ext-1');
    expect(body.runId).toBe(firstRun.id);
  });

  it('still accepts a different externalRunId for the same session', async () => {
    const missionId = await createMission();
    expect((await createRun(missionId, 'ext-a', 'sess-same')).status).toBe(201);
    expect((await createRun(missionId, 'ext-b', 'sess-same')).status).toBe(201);
  });

  it('mirrors the refusal over MCP as a toolError, not a transport error', async () => {
    const missionId = await createMission();
    expect((await createRun(missionId, 'ext-mcp', 'sess-mcp')).status).toBe(201);

    const res = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: { ...auth, Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'runs.create',
          arguments: {
            missionId,
            runtime: 'hermes',
            agent: 'runner',
            externalSessionId: 'sess-mcp-2',
            externalRunId: 'ext-mcp',
          },
        },
      }),
    });
    // The MCP surface answers as Server-Sent Events: `event: message` then `data: {...}`.
    const text = await res.text();
    const dataLine = text
      .split('\n')
      .find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice('data: '.length)) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text).toContain('run_exists');
  });
});
