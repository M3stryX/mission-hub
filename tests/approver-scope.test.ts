import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import {
  loadApproverClients,
  loadClientCredentials,
  type Scope,
} from '../src/auth/config.js';
import { resolvePrincipal } from '../src/auth/resolve.js';
import { MissionHubStore } from '../src/db/store.js';

const databaseUrl = process.env.DATABASE_URL;

const baseScopes: Scope[] = [
  'missions:read',
  'missions:write',
  'runs:read',
  'runs:write',
  'summaries:read',
  'summaries:write',
  'evidence:read',
  'evidence:write',
];

describe('approver allowlist parsing', () => {
  it('reads a comma-separated list, trimming and ignoring blanks', () => {
    const parsed = loadApproverClients(' human-a , ,human-b,');
    expect([...parsed].sort()).toEqual(['human-a', 'human-b']);
  });

  it('is empty when the variable is unset', () => {
    expect(loadApproverClients('').size).toBe(0);
  });

  it('keeps approvals:human for an allowlisted env client', () => {
    const raw = JSON.stringify({
      'approver-ok': { token: 't1', scopes: [...baseScopes, 'approvals:human'] },
    });
    const [credential] = loadClientCredentials(raw, new Set(['approver-ok']));
    expect(credential.scopes.has('approvals:human')).toBe(true);
  });

  it('still drops approvals:human for a client the operator did not allowlist', () => {
    const raw = JSON.stringify({
      'service-x': { token: 't1', scopes: [...baseScopes, 'approvals:human'] },
    });
    const [credential] = loadClientCredentials(raw, new Set(['someone-else']));
    expect(credential.scopes.has('approvals:human')).toBe(false);
  });
});

describe.skipIf(!databaseUrl)('approver allowlist over the real auth path', () => {
  it('grants approvals:human to an allowlisted ENV client that never asked for it', async () => {
    // Regression: an env credential is resolved before the DB is consulted, so an
    // allowlist applied only on the DB branch left every env approver at 403.
    const store = new MissionHubStore(pool);
    const envCredentials = [
      { clientId: 'env-approver', token: 'env-approver-token', scopes: new Set(baseScopes) },
      { clientId: 'env-other', token: 'env-other-token', scopes: new Set(baseScopes) },
    ];
    const approvers = new Set(['env-approver']);

    const allowed = await resolvePrincipal('Bearer env-approver-token', store, {
      envCredentials,
      approverClients: approvers,
    });
    expect(allowed?.scopes.has('approvals:human')).toBe(true);

    const refused = await resolvePrincipal('Bearer env-other-token', store, {
      envCredentials,
      approverClients: approvers,
    });
    expect(refused?.scopes.has('approvals:human')).toBe(false);
  });

  const pool = new Pool({ connectionString: databaseUrl });

  /** Fresh app + store. `approvers` is the operator allowlist for this instance. */
  function build(approvers: string[], adminToken = 'admin-token') {
    const store = new MissionHubStore(pool);
    const app = createApp(store, {
      adminToken,
      approverClients: new Set(approvers),
    });
    return { app, store };
  }

  const auth = (token: string) => ({
    Host: 'localhost',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE evidence, summaries, execution_events, claim_delegations, mission_claims, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions, api_clients RESTART IDENTITY CASCADE',
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  async function createMission(app: ReturnType<typeof build>['app'], token: string) {
    const res = await app.request('http://localhost/api/v1/missions', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ title: 'approver allowlist' }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { mission: { id: number } }).mission.id;
  }

  async function createRun(
    app: ReturnType<typeof build>['app'],
    missionId: number,
    token: string,
    purpose: string,
  ) {
    const res = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        missionId,
        purpose,
        runtime: 'hermes',
        agent: 'planner',
        externalSessionId: `s-${Math.random().toString(36).slice(2)}`,
        externalRunId: `r-${Math.random().toString(36).slice(2)}`,
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { run: { id: number } }).run.id;
  }

  it('lets an allowlisted DB client record a plan approval that a non-allowlisted one cannot', async () => {
    const { app, store } = build(['approver-db']);
    const planner = await store.createClient('planner-db', baseScopes);
    // The scope is written to the row on purpose: the allowlist must be what decides,
    // not the stored scope (which the resolver filters as privileged).
    const approver = await store.createClient('approver-db', [
      ...baseScopes,
      'approvals:human',
    ]);
    const bystander = await store.createClient('bystander-db', [
      ...baseScopes,
      'approvals:human',
    ]);

    const missionId = await createMission(app, planner.token);
    const planRunId = await createRun(app, missionId, planner.token, 'planning');
    const plan = await app.request(
      `http://localhost/api/v1/runs/${planRunId}/summaries`,
      {
        method: 'POST',
        headers: auth(planner.token),
        body: JSON.stringify({ type: 'plan_summary', content: 'Execution plan v1' }),
      },
    );
    expect(plan.status).toBe(201);

    const refused = await app.request(
      `http://localhost/api/v1/missions/${missionId}/plan-approval`,
      {
        method: 'POST',
        headers: auth(bystander.token),
        body: JSON.stringify({ content: 'not my job' }),
      },
    );
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('insufficient_scope');

    const approved = await app.request(
      `http://localhost/api/v1/missions/${missionId}/plan-approval`,
      {
        method: 'POST',
        headers: auth(approver.token),
        body: JSON.stringify({ content: 'Approved by the allowlisted approver' }),
      },
    );
    expect(approved.status).toBe(201);
    const body = (await approved.json()) as { summary: { type: string; client_id: string } };
    expect(body.summary.type).toBe('plan_approval');
    expect(body.summary.client_id).toBe('approver-db');
  });

  it('grants nothing beyond approvals:human to the allowlisted client', async () => {
    const { app, store } = build(['approver-db']);
    const approver = await store.createClient('approver-db', baseScopes);

    // No clients:admin, no verify:admin.
    const mint = await app.request('http://localhost/api/v1/admin/clients', {
      method: 'POST',
      headers: auth(approver.token),
      body: JSON.stringify({ clientId: 'forged', scopes: ['missions:read'] }),
    });
    expect(mint.status).toBe(403);
  });

  it('keeps the scope mint-forbidden even with the allowlist set', async () => {
    const { app } = build(['approver-db']);
    const mint = await app.request('http://localhost/api/v1/admin/clients', {
      method: 'POST',
      headers: auth('admin-token'),
      body: JSON.stringify({ clientId: 'wannabe', scopes: ['approvals:human'] }),
    });
    expect(mint.status).toBe(400);
    expect(((await mint.json()) as { error: string }).error).toBe('invalid_scopes');
  });
});
