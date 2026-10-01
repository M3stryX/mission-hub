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
  const adminToken = 'contract-admin-token';
  const app = createApp(new MissionHubStore(pool), {
    envCredentials: credentials,
    adminToken,
  });
  const host = { Host: 'localhost' };
  const auth = {
    ...host,
    Authorization: 'Bearer contract-token',
    'Content-Type': 'application/json',
  };
  const adminAuth = {
    ...host,
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  beforeEach(async () => {
    await pool.query('TRUNCATE evidence, summaries, execution_events, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions, api_clients RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('exposes liveness and database readiness', async () => {
    expect(
      (await app.request('http://localhost/health', { headers: host })).status,
    ).toBe(200);
    expect(
      (await app.request('http://localhost/ready', { headers: host })).status,
    ).toBe(200);
  });

  it('rejects protected routes without a valid service credential', async () => {
    expect(
      (
        await app.request('http://localhost/api/v1/missions', {
          headers: host,
        })
      ).status,
    ).toBe(401);
  });

  it('creates hashed clients via admin token and authenticates them from the database', async () => {
    expect(
      (
        await app.request('http://localhost/api/v1/admin/clients', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            clientId: 'n8n-client',
            scopes: ['missions:read', 'missions:write'],
          }),
        })
      ).status,
    ).toBe(401);

    const created = await app.request('http://localhost/api/v1/admin/clients', {
      method: 'POST',
      headers: adminAuth,
      body: JSON.stringify({
        clientId: 'n8n-client',
        scopes: ['missions:read', 'missions:write'],
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      token: string;
      client: { clientId: string; tokenPrefix: string; scopes: string[] };
    };
    expect(body.client.clientId).toBe('n8n-client');
    expect(body.token.startsWith('mh_')).toBe(true);
    expect(body.client.tokenPrefix).toBe(body.token.slice(0, 10));

    const dbClientAuth = {
      ...host,
      Authorization: `Bearer ${body.token}`,
      'Content-Type': 'application/json',
    };
    const mission = await app.request('http://localhost/api/v1/missions', {
      method: 'POST',
      headers: dbClientAuth,
      body: JSON.stringify({ title: 'DB client mission' }),
    });
    expect(mission.status).toBe(201);

    const listed = await app.request('http://localhost/api/v1/admin/clients', {
      headers: adminAuth,
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      clients: Array<{ clientId: string; revokedAt: string | null }>;
    };
    expect(listBody.clients.map((client) => client.clientId)).toContain('n8n-client');

    const revoked = await app.request(
      'http://localhost/api/v1/admin/clients/n8n-client/revoke',
      { method: 'POST', headers: adminAuth },
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await app.request('http://localhost/api/v1/missions', {
          headers: dbClientAuth,
        })
      ).status,
    ).toBe(401);
  });

  it('rejects minting verify:admin onto service clients', async () => {
    expect(
      (
        await app.request('http://localhost/api/v1/admin/clients', {
          method: 'POST',
          headers: adminAuth,
          body: JSON.stringify({
            clientId: 'verify-mint-blocked',
            scopes: ['missions:read', 'verify:admin'],
          }),
        })
      ).status,
    ).toBe(400);
  });

  it('creates and updates a mission with durable audit events', async () => {
    const create = await app.request('http://localhost/api/v1/missions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Contract mission', status: 'todo', priority: 1 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { mission: { id: number } };

    const update = await app.request(`http://localhost/api/v1/missions/${created.mission.id}`, {
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
    const missionResponse = await app.request('http://localhost/api/v1/missions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Run mission' }),
    });
    const mission = (await missionResponse.json()) as { mission: { id: number } };

    const runResponse = await app.request('http://localhost/api/v1/runs', {
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
        await app.request(`http://localhost/api/v1/runs/${run.run.id}/status`, {
          method: 'PATCH',
          headers: auth,
          body: JSON.stringify({ status: 'COMPLETED', reviewState: 'APPROVED' }),
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await app.request(`http://localhost/api/v1/runs/${run.run.id}/summaries`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ type: 'reviewer_validated', content: 'Validated.' }),
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await app.request(`http://localhost/api/v1/runs/${run.run.id}/evidence`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ kind: 'commit', label: 'Validated commit', uri: 'https://example.invalid/commit/1' }),
        })
      ).status,
    ).toBe(201);

    const events = await app.request(`http://localhost/api/v1/runs/${run.run.id}/events`, { headers: auth });
    const eventBody = (await events.json()) as {
      events: Array<{ kind: string; actor: string; client_id: string | null }>;
    };
    expect(eventBody.events.map((event) => event.kind)).toEqual([
      'run.created',
      'run.status_changed',
      'run.summary_recorded',
      'run.evidence_recorded',
    ]);
    expect(eventBody.events.every((event) => event.actor === 'contract-test')).toBe(
      true,
    );
  });

  it('enforces checklist ownership, ordering and audit events', async () => {
    const missionA = (
      await (
        await app.request('http://localhost/api/v1/missions', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ title: 'Checklist A' }),
        })
      ).json()
    ) as { mission: { id: number } };
    const missionB = (
      await (
        await app.request('http://localhost/api/v1/missions', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ title: 'Checklist B' }),
        })
      ).json()
    ) as { mission: { id: number } };

    const created = await app.request(
      `http://localhost/api/v1/missions/${missionA.mission.id}/checklist`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ item: 'First', position: 0 }),
      },
    );
    expect(created.status).toBe(201);
    const item = (await created.json()) as {
      item: { id: number; position: number };
    };

    expect(
      (
        await app.request(
          `http://localhost/api/v1/missions/${missionB.mission.id}/checklist/${item.item.id}`,
          {
            method: 'PATCH',
            headers: auth,
            body: JSON.stringify({ done: true }),
          },
        )
      ).status,
    ).toBe(404);

    const updated = await app.request(
      `http://localhost/api/v1/missions/${missionA.mission.id}/checklist/${item.item.id}`,
      {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ done: true, position: 2 }),
      },
    );
    expect(updated.status).toBe(200);

    const audit = await pool.query<{ kind: string; actor: string }>(
      `SELECT kind, actor FROM mission_events
       WHERE mission_id = $1 AND kind LIKE 'checklist.%'
       ORDER BY id`,
      [missionA.mission.id],
    );
    expect(audit.rows.map((row) => row.kind)).toEqual([
      'checklist.add',
      'checklist.update',
    ]);
    expect(audit.rows.every((row) => row.actor === 'contract-test')).toBe(true);
  });

  it('enforces source path uniqueness and cross-mission 404', async () => {
    const missionA = (
      await (
        await app.request('http://localhost/api/v1/missions', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ title: 'Sources A' }),
        })
      ).json()
    ) as { mission: { id: number } };
    const missionB = (
      await (
        await app.request('http://localhost/api/v1/missions', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ title: 'Sources B' }),
        })
      ).json()
    ) as { mission: { id: number } };

    const created = await app.request(
      `http://localhost/api/v1/missions/${missionA.mission.id}/sources`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          label: 'README',
          path: 'docs/readme.md',
          kind: 'doc',
        }),
      },
    );
    expect(created.status).toBe(201);
    const source = (await created.json()) as { source: { id: number } };

    expect(
      (
        await app.request(
          `http://localhost/api/v1/missions/${missionA.mission.id}/sources`,
          {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              label: 'README dup',
              path: 'docs/readme.md',
              kind: 'doc',
            }),
          },
        )
      ).status,
    ).toBe(409);

    expect(
      (
        await app.request(
          `http://localhost/api/v1/missions/${missionB.mission.id}/sources/${source.source.id}`,
          { method: 'DELETE', headers: auth },
        )
      ).status,
    ).toBe(404);
  });

  it('cleans verify fixtures only with verify:admin on staging hosts', async () => {
    const verifyApp = createApp(new MissionHubStore(pool), {
      envCredentials: [
        ...credentials,
        {
          clientId: 'verify-test',
          token: 'verify-token',
          scopes: new Set<Scope>([...allScopes, 'verify:admin']),
        },
      ],
      adminToken,
      allowDestructiveVerify: true,
    });
    const verifyAuth = {
      ...host,
      Authorization: 'Bearer verify-token',
      'Content-Type': 'application/json',
    };

    const fixture = await verifyApp.request('http://localhost/api/v1/missions', {
      method: 'POST',
      headers: verifyAuth,
      body: JSON.stringify({
        title: '[VERIFY] ephemeral',
        tags: 'mh-runtime-verify',
      }),
    });
    expect(fixture.status).toBe(201);
    const created = (await fixture.json()) as { mission: { id: number } };

    expect(
      (
        await verifyApp.request(
          `http://localhost/api/v1/admin/verify-fixtures/${created.mission.id}`,
          { method: 'DELETE', headers: adminAuth },
        )
      ).status,
    ).toBe(401);

    const normalMission = await verifyApp.request(
      'http://localhost/api/v1/missions',
      {
        method: 'POST',
        headers: verifyAuth,
        body: JSON.stringify({ title: 'Normal mission' }),
      },
    );
    const normal = (await normalMission.json()) as { mission: { id: number } };
    expect(
      (
        await verifyApp.request(
          `http://localhost/api/v1/admin/verify-fixtures/${normal.mission.id}`,
          { method: 'DELETE', headers: verifyAuth },
        )
      ).status,
    ).toBe(403);

    const deleted = await verifyApp.request(
      `http://localhost/api/v1/admin/verify-fixtures/${created.mission.id}`,
      { method: 'DELETE', headers: verifyAuth },
    );
    expect(deleted.status).toBe(200);

    const prodApp = createApp(new MissionHubStore(pool), {
      envCredentials: [
        {
          clientId: 'verify-test',
          token: 'verify-token',
          scopes: new Set<Scope>([...allScopes, 'verify:admin']),
        },
      ],
      allowDestructiveVerify: true,
    });
    const prodFixture = await prodApp.request(
      'http://mission-hub.lan/api/v1/missions',
      {
        method: 'POST',
        headers: {
          Host: 'mission-hub.lan',
          Authorization: 'Bearer verify-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: '[VERIFY] prod blocked',
          tags: 'mh-runtime-verify',
        }),
      },
    );
    const prodCreated = (await prodFixture.json()) as { mission: { id: number } };
    expect(
      (
        await prodApp.request(
          `http://mission-hub.lan/api/v1/admin/verify-fixtures/${prodCreated.mission.id}`,
          {
            method: 'DELETE',
            headers: {
              Host: 'mission-hub.lan',
              Authorization: 'Bearer verify-token',
            },
          },
        )
      ).status,
    ).toBe(403);
  });
});
