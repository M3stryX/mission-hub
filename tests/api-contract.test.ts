import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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

describe.skipIf(!databaseUrl)('REST API v1 contracts', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const credentials: ClientCredential[] = [
    { clientId: 'contract-test', token: 'contract-token', scopes: new Set(allScopes) },
  ];
  const app = createApp(new MissionHubStore(pool), credentials);
  const auth = { Authorization: 'Bearer contract-token', 'Content-Type': 'application/json' };

  beforeEach(async () => {
    await pool.query('TRUNCATE evidence, summaries, execution_events, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('exposes liveness and database readiness', async () => {
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/ready')).status).toBe(200);
  });

  it('rejects protected routes without a valid service credential', async () => {
    expect((await app.request('/api/v1/missions')).status).toBe(401);
  });

  it('creates and updates a mission with durable audit events', async () => {
    const create = await app.request('/api/v1/missions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Contract mission', status: 'todo', priority: 1 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { mission: { id: number } };

    const update = await app.request(`/api/v1/missions/${created.mission.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ status: 'in_progress' }),
    });
    expect(update.status).toBe(200);

    const events = await pool.query(
      'SELECT kind FROM mission_events WHERE mission_id = $1 ORDER BY id',
      [created.mission.id],
    );
    expect(events.rows.map((row) => row.kind)).toEqual(['create', 'update']);
  });

  it('records run transitions, typed summaries and evidence references', async () => {
    const missionResponse = await app.request('/api/v1/missions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Run mission' }),
    });
    const mission = (await missionResponse.json()) as { mission: { id: number } };

    const runResponse = await app.request('/api/v1/runs', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        missionId: mission.mission.id,
        runtime: 'opencode',
        agent: 'builder',
        externalSessionId: 'session-contract',
        externalRunId: 'run-contract',
        correlationId: 'corr-contract',
      }),
    });
    expect(runResponse.status).toBe(201);
    const run = (await runResponse.json()) as { run: { id: number } };

    expect(
      (
        await app.request(`/api/v1/runs/${run.run.id}/status`, {
          method: 'PATCH',
          headers: auth,
          body: JSON.stringify({ status: 'COMPLETED', reviewState: 'APPROVED' }),
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await app.request(`/api/v1/runs/${run.run.id}/summaries`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ type: 'reviewer_validated', content: 'Validated.' }),
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await app.request(`/api/v1/runs/${run.run.id}/evidence`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ kind: 'commit', label: 'Validated commit', uri: 'https://example.invalid/commit/1' }),
        })
      ).status,
    ).toBe(201);

    const events = await app.request(`/api/v1/runs/${run.run.id}/events`, { headers: auth });
    const eventBody = (await events.json()) as { events: Array<{ kind: string }> };
    expect(eventBody.events.map((event) => event.kind)).toEqual([
      'run.created',
      'run.status_changed',
    ]);
  });
});
