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
    await pool.query('TRUNCATE evidence, summaries, execution_events, mission_claims, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions, api_clients RESTART IDENTITY CASCADE');
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

  it('creates, validates and discovers canonical research reports', async () => {
    const missionResponse = await app.request('http://localhost/api/v1/missions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Research mission' }),
    });
    const mission = (await missionResponse.json()) as { mission: { id: number } };

    const legacyResponse = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        missionId: mission.mission.id,
        runtime: 'legacy',
        agent: 'legacy-agent',
        externalSessionId: 'legacy-session',
        externalRunId: 'legacy-run',
      }),
    });
    expect(legacyResponse.status).toBe(201);
    const legacy = (await legacyResponse.json()) as {
      run: { id: number; purpose: string | null };
    };
    expect(legacy.run.purpose).toBeNull();

    const firstRunResponse = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        missionId: mission.mission.id,
        runtime: 'hermes',
        agent: 'researcher',
        externalSessionId: 'research-session-1',
        externalRunId: 'research-run-1',
        purpose: 'research',
      }),
    });
    expect(firstRunResponse.status).toBe(201);
    const firstRun = (await firstRunResponse.json()) as {
      run: { id: number; purpose: string };
    };
    expect(firstRun.run.purpose).toBe('research');

    const firstSummaryResponse = await app.request(
      `http://localhost/api/v1/runs/${firstRun.run.id}/summaries`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          type: 'research_report',
          content: 'First report',
          metadata: { schemaVersion: '1.0.0' },
        }),
      },
    );
    expect(firstSummaryResponse.status).toBe(201);
    const firstSummary = (await firstSummaryResponse.json()) as {
      summary: { id: number };
    };

    const secondRunResponse = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        missionId: mission.mission.id,
        runtime: 'opencode',
        agent: 'researcher',
        externalSessionId: 'research-session-2',
        externalRunId: 'research-run-2',
        purpose: 'research',
      }),
    });
    const secondRun = (await secondRunResponse.json()) as {
      run: { id: number };
    };

    const secondSummaryResponse = await app.request(
      `http://localhost/api/v1/runs/${secondRun.run.id}/summaries`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          type: 'research_report',
          content: 'Second report',
          metadata: {
            schemaVersion: '1.0.0',
            supersedesSummaryId: firstSummary.summary.id,
          },
        }),
      },
    );
    expect(secondSummaryResponse.status).toBe(201);
    const secondSummary = (await secondSummaryResponse.json()) as {
      summary: { id: number; metadata_json: Record<string, unknown> };
    };
    expect(secondSummary.summary.metadata_json.supersedesSummaryId).toBe(
      firstSummary.summary.id,
    );

    const reviewRunResponse = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        missionId: mission.mission.id,
        runtime: 'opencode',
        agent: 'reviewer',
        externalSessionId: 'review-session',
        externalRunId: 'review-run',
        purpose: 'independent_review',
      }),
    });
    const reviewRun = (await reviewRunResponse.json()) as {
      run: { id: number };
    };
    const reviewSummaryResponse = await app.request(
      `http://localhost/api/v1/runs/${reviewRun.run.id}/summaries`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          type: 'reviewer_validated',
          content: 'Reviewed',
          metadata: { validatesSummaryId: secondSummary.summary.id },
        }),
      },
    );
    expect(reviewSummaryResponse.status).toBe(201);

    const invalidEvidence = await app.request(
      `http://localhost/api/v1/runs/${secondRun.run.id}/evidence`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          kind: 'source',
          label: 'Bad taxonomy',
          uri: 'https://example.invalid/bad',
          metadata: { source_type: 'unsupported_source_type' },
        }),
      },
    );
    expect(invalidEvidence.status).toBe(400);

    const validEvidence = await app.request(
      `http://localhost/api/v1/runs/${secondRun.run.id}/evidence`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          kind: 'source',
          label: 'Runtime observation',
          uri: 'mission-hub://runtime/observation',
          metadata: {
            source_type: 'observed_runtime',
            authority: 'runtime',
            confidence: 1,
          },
        }),
      },
    );
    expect(validEvidence.status).toBe(201);

    const researchRuns = await app.request(
      `http://localhost/api/v1/missions/${mission.mission.id}/runs?purpose=research`,
      { headers: auth },
    );
    expect(researchRuns.status).toBe(200);
    const researchRunsBody = (await researchRuns.json()) as {
      runs: Array<{ purpose: string | null }>;
    };
    expect(researchRunsBody.runs).toHaveLength(2);
    expect(researchRunsBody.runs.every((run) => run.purpose === 'research')).toBe(
      true,
    );

    const typedSummaries = await app.request(
      `http://localhost/api/v1/runs/${secondRun.run.id}/summaries?type=research_report`,
      { headers: auth },
    );
    expect(typedSummaries.status).toBe(200);
    const typedSummaryBody = (await typedSummaries.json()) as {
      summaries: Array<{ type: string }>;
    };
    expect(typedSummaryBody.summaries.map((summary) => summary.type)).toEqual([
      'research_report',
    ]);

    const reportsResponse = await app.request(
      `http://localhost/api/v1/missions/${mission.mission.id}/research-reports`,
      { headers: auth },
    );
    expect(reportsResponse.status).toBe(200);
    const reports = (await reportsResponse.json()) as {
      reports: Array<{ id: number; canonical: boolean }>;
    };
    expect(reports.reports).toHaveLength(2);
    expect(reports.reports[0].id).toBe(secondSummary.summary.id);
    expect(reports.reports[0].canonical).toBe(true);
    expect(reports.reports[1].id).toBe(firstSummary.summary.id);
    expect(reports.reports[1].canonical).toBe(false);

    const canonicalResponse = await app.request(
      `http://localhost/api/v1/missions/${mission.mission.id}/research-report`,
      { headers: auth },
    );
    expect(canonicalResponse.status).toBe(200);
    const canonical = (await canonicalResponse.json()) as {
      report: { id: number };
    };
    expect(canonical.report.id).toBe(secondSummary.summary.id);
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

    const withRun = await verifyApp.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: verifyAuth,
      body: JSON.stringify({
        missionId: created.mission.id,
        runtime: 'n8n',
        agent: 'runtime-verify',
        externalSessionId: 'verify-session-contract',
        externalRunId: 'verify-run-contract',
      }),
    });
    expect(withRun.status).toBe(201);

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

  it('claims a mission atomically, renews lease, conflicts, expires, and releases', async () => {
    const other = createApp(new MissionHubStore(pool), {
      envCredentials: [
        ...credentials,
        {
          clientId: 'other-agent',
          token: 'other-token',
          scopes: new Set(allScopes),
        },
      ],
      adminToken,
    });
    const otherAuth = {
      ...host,
      Authorization: 'Bearer other-token',
      'Content-Type': 'application/json',
    };

    const created = await app.request('http://localhost/api/v1/missions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'Claim target' }),
    });
    expect(created.status).toBe(201);
    const mission = (await created.json()) as { mission: { id: number } };

    const claimed = await app.request(
      `http://localhost/api/v1/missions/${mission.mission.id}/claim`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          runtime: 'cursor',
          agent: 'claim-test',
          externalSessionId: 'claim-session-1',
          externalRunId: 'claim-run-1',
          leaseSeconds: 60,
        }),
      },
    );
    expect(claimed.status).toBe(201);
    const first = (await claimed.json()) as {
      claim: { id: number; client_id: string; run_id: number };
      run: { id: number; status: string };
      expiredPreviousClaimId: number | null;
    };
    expect(first.claim.client_id).toBe('contract-test');
    expect(first.run.status).toBe('RUNNING');
    expect(first.expiredPreviousClaimId).toBeNull();

    const conflict = await other.request(
      `http://localhost/api/v1/missions/${mission.mission.id}/claim`,
      {
        method: 'POST',
        headers: otherAuth,
        body: JSON.stringify({
          runtime: 'cursor',
          agent: 'other',
          externalSessionId: 'claim-session-2',
          externalRunId: 'claim-run-2',
        }),
      },
    );
    expect(conflict.status).toBe(409);

    const renewed = await app.request(
      `http://localhost/api/v1/claims/${first.claim.id}/renew`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ leaseSeconds: 90 }),
      },
    );
    expect(renewed.status).toBe(200);

    await pool.query(
      `UPDATE mission_claims
       SET claimed_at = now() - interval '2 seconds',
           expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [first.claim.id],
    );

    const reclaim = await other.request(
      `http://localhost/api/v1/missions/${mission.mission.id}/claim`,
      {
        method: 'POST',
        headers: otherAuth,
        body: JSON.stringify({
          runtime: 'cursor',
          agent: 'other',
          externalSessionId: 'claim-session-3',
          externalRunId: 'claim-run-3',
          leaseSeconds: 30,
        }),
      },
    );
    expect(reclaim.status).toBe(201);
    const second = (await reclaim.json()) as {
      claim: { id: number; client_id: string; run_id: number };
      expiredPreviousClaimId: number | null;
      expiryDiagnosis: { cause: string; known: boolean } | null;
    };
    expect(second.claim.client_id).toBe('other-agent');
    expect(second.expiredPreviousClaimId).toBe(first.claim.id);
    expect(second.expiryDiagnosis?.cause).toBe('UNKNOWN');
    expect(second.expiryDiagnosis?.known).toBe(false);

    const oldRun = await pool.query<{ status: string }>(
      'SELECT status FROM execution_runs WHERE id = $1',
      [first.claim.run_id],
    );
    expect(oldRun.rows[0].status).toBe('FAILED');

    const fenced = await app.request(
      `http://localhost/api/v1/runs/${first.claim.run_id}/status`,
      {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ status: 'COMPLETED' }),
      },
    );
    expect(fenced.status).toBe(403);

    const incomplete = await other.request(
      `http://localhost/api/v1/claims/${second.claim.id}/release`,
      {
        method: 'POST',
        headers: otherAuth,
        body: JSON.stringify({ reason: 'completed' }),
      },
    );
    expect(incomplete.status).toBe(409);

    await other.request(
      `http://localhost/api/v1/runs/${second.claim.run_id}/summaries`,
      {
        method: 'POST',
        headers: otherAuth,
        body: JSON.stringify({
          type: 'agent_self_report',
          content: 'done with evidence',
        }),
      },
    );
    await other.request(
      `http://localhost/api/v1/runs/${second.claim.run_id}/evidence`,
      {
        method: 'POST',
        headers: otherAuth,
        body: JSON.stringify({
          kind: 'ci',
          label: 'proof',
          uri: 'https://example.test/proof',
        }),
      },
    );

    const released = await other.request(
      `http://localhost/api/v1/claims/${second.claim.id}/release`,
      {
        method: 'POST',
        headers: otherAuth,
        body: JSON.stringify({ reason: 'completed' }),
      },
    );
    expect(released.status).toBe(200);
    const releasedRun = await pool.query<{ status: string }>(
      'SELECT status FROM execution_runs WHERE id = $1',
      [second.claim.run_id],
    );
    expect(releasedRun.rows[0].status).toBe('COMPLETED');

    const events = await app.request(
      `http://localhost/api/v1/missions/${mission.mission.id}/events`,
      { headers: auth },
    );
    const eventBody = (await events.json()) as {
      events: Array<{ kind: string; payload: Record<string, unknown> | null }>;
    };
    const kinds = eventBody.events.map((e) => e.kind);
    expect(kinds).toContain('claim.acquired');
    expect(kinds).toContain('claim.renewed');
    expect(kinds).toContain('claim.expiry_diagnosis');
    expect(kinds).toContain('claim.expired');
    expect(kinds).toContain('claim.released');

    const active = await app.request(
      `http://localhost/api/v1/missions/${mission.mission.id}/claim`,
      { headers: auth },
    );
    expect(active.status).toBe(200);
    expect(((await active.json()) as { claim: unknown }).claim).toBeNull();
  });

  it('diagnoses expiry causes and fences stale owners', async () => {
    const other = createApp(new MissionHubStore(pool), {
      envCredentials: [
        ...credentials,
        {
          clientId: 'other-agent',
          token: 'other-token',
          scopes: new Set(allScopes),
        },
      ],
      adminToken,
    });
    const host = { Host: 'mission-hub.lan' };
    const auth = {
      ...host,
      Authorization: 'Bearer contract-token',
      'Content-Type': 'application/json',
    };
    const otherAuth = {
      ...host,
      Authorization: 'Bearer other-token',
      'Content-Type': 'application/json',
    };

    async function claimAs(
      clientApp: typeof app,
      headers: Record<string, string>,
      missionId: number,
      suffix: string,
    ) {
      return clientApp.request(
        `http://localhost/api/v1/missions/${missionId}/claim`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            runtime: 'cursor',
            agent: `agent-${suffix}`,
            externalSessionId: `session-${suffix}`,
            externalRunId: `run-${suffix}`,
            leaseSeconds: 60,
          }),
        },
      );
    }

    async function forceExpire(claimId: number, ageLastSeen: boolean) {
      await pool.query(
        `UPDATE mission_claims
         SET claimed_at = now() - interval '10 seconds',
             expires_at = now() - interval '5 seconds'
         WHERE id = $1`,
        [claimId],
      );
      if (ageLastSeen) {
        await pool.query(
          `UPDATE agent_sessions AS s
           SET last_seen_at = now() - interval '9 seconds'
           FROM execution_runs AS r
           JOIN mission_claims AS c ON c.run_id = r.id
           WHERE c.id = $1 AND s.id = r.session_id`,
          [claimId],
        );
      }
    }

    // 1) stale/open session
    {
      const created = await app.request('http://localhost/api/v1/missions', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ title: 'Expiry stale' }),
      });
      const mission = (await created.json()) as { mission: { id: number } };
      const first = await claimAs(app, auth, mission.mission.id, 'stale-a');
      const body = (await first.json()) as {
        claim: { id: number; run_id: number };
      };
      await forceExpire(body.claim.id, true);
      const reclaim = await claimAs(other, otherAuth, mission.mission.id, 'stale-b');
      expect(reclaim.status).toBe(201);
      const result = (await reclaim.json()) as {
        expiryDiagnosis: { cause: string };
      };
      expect(result.expiryDiagnosis.cause).toBe('SESSION_STALE');
      const run = await pool.query<{ status: string }>(
        'SELECT status FROM execution_runs WHERE id = $1',
        [body.claim.run_id],
      );
      expect(run.rows[0].status).toBe('FAILED');
    }

    // 2) session closed/aborted
    {
      const created = await app.request('http://localhost/api/v1/missions', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ title: 'Expiry closed' }),
      });
      const mission = (await created.json()) as { mission: { id: number } };
      const first = await claimAs(app, auth, mission.mission.id, 'closed-a');
      const body = (await first.json()) as {
        claim: { id: number; run_id: number };
      };
      await pool.query(
        `UPDATE agent_sessions AS s
         SET status = 'CLOSED'::session_status, ended_at = now()
         FROM execution_runs AS r
         WHERE r.id = $1 AND s.id = r.session_id`,
        [body.claim.run_id],
      );
      await forceExpire(body.claim.id, false);
      const reclaim = await claimAs(other, otherAuth, mission.mission.id, 'closed-b');
      const result = (await reclaim.json()) as {
        expiryDiagnosis: { cause: string };
      };
      expect(result.expiryDiagnosis.cause).toBe('SESSION_CLOSED');
    }

    // 3) already-terminal run
    {
      const created = await app.request('http://localhost/api/v1/missions', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ title: 'Expiry terminal' }),
      });
      const mission = (await created.json()) as { mission: { id: number } };
      const first = await claimAs(app, auth, mission.mission.id, 'term-a');
      const body = (await first.json()) as {
        claim: { id: number; run_id: number };
      };
      await pool.query(
        `UPDATE execution_runs
         SET status = 'COMPLETED'::run_status, finished_at = now()
         WHERE id = $1`,
        [body.claim.run_id],
      );
      await forceExpire(body.claim.id, false);
      const reclaim = await claimAs(other, otherAuth, mission.mission.id, 'term-b');
      const result = (await reclaim.json()) as {
        expiryDiagnosis: { cause: string; runStatusAfter: string };
      };
      expect(result.expiryDiagnosis.cause).toBe('RUN_ALREADY_TERMINAL');
      expect(result.expiryDiagnosis.runStatusAfter).toBe('COMPLETED');
      const run = await pool.query<{ status: string }>(
        'SELECT status FROM execution_runs WHERE id = $1',
        [body.claim.run_id],
      );
      expect(run.rows[0].status).toBe('COMPLETED');
    }

    // 4) unknown cause (open session, recent last_seen)
    {
      const created = await app.request('http://localhost/api/v1/missions', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ title: 'Expiry unknown' }),
      });
      const mission = (await created.json()) as { mission: { id: number } };
      const first = await claimAs(app, auth, mission.mission.id, 'unk-a');
      const body = (await first.json()) as {
        claim: { id: number; run_id: number };
      };
      await forceExpire(body.claim.id, false);
      const reclaim = await claimAs(other, otherAuth, mission.mission.id, 'unk-b');
      const result = (await reclaim.json()) as {
        expiryDiagnosis: { cause: string; known: boolean };
      };
      expect(result.expiryDiagnosis.cause).toBe('UNKNOWN');
      expect(result.expiryDiagnosis.known).toBe(false);
    }

    // 5) release failed couples run to FAILED; completed rejects FAILED run
    {
      const created = await app.request('http://localhost/api/v1/missions', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ title: 'Release coupling' }),
      });
      const mission = (await created.json()) as { mission: { id: number } };
      const first = await claimAs(app, auth, mission.mission.id, 'rel-a');
      const body = (await first.json()) as {
        claim: { id: number; run_id: number };
      };
      const failedRelease = await app.request(
        `http://localhost/api/v1/claims/${body.claim.id}/release`,
        {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ reason: 'failed' }),
        },
      );
      expect(failedRelease.status).toBe(200);
      const run = await pool.query<{ status: string }>(
        'SELECT status FROM execution_runs WHERE id = $1',
        [body.claim.run_id],
      );
      expect(run.rows[0].status).toBe('FAILED');
    }
  });
});
