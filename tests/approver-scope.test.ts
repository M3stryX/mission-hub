import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import {
  findOrphanApprovers,
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

  it('names allowlisted ids that no environment client declares', () => {
    const raw = JSON.stringify({
      'declared-approver': { token: 't1', scopes: [...baseScopes] },
    });
    const credentials = loadClientCredentials(raw, new Set(['declared-approver', 'typo-approver']));
    expect(findOrphanApprovers(new Set(['declared-approver', 'typo-approver']), credentials)).toEqual([
      'typo-approver',
    ]);
    expect(findOrphanApprovers(new Set(['declared-approver']), credentials)).toEqual([]);
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

  it('refuses a DB client even when its id is allowlisted: the allowlist only promotes env clients', async () => {
    // The allowlist names a client the operator declared in the environment. Applying
    // it to a database row would let anyone holding clients:admin mint a client under
    // an allowlisted id and inherit approvals:human. So the DB path never receives it.
    const { app, store } = build(['approver-db']);
    const planner = await store.createClient('planner-db', baseScopes);
    const listed = await store.createClient('approver-db', [...baseScopes, 'approvals:human']);

    const missionId = await createMission(app, planner.token);
    const planRunId = await createRun(app, missionId, planner.token, 'planning');
    const resumePlan = await app.request(
      `http://localhost/api/v1/runs/${planRunId}/summaries`,
      {
        method: 'POST',
        headers: auth(planner.token),
        body: JSON.stringify({ type: 'plan_summary', content: 'Execution plan v1' }),
      },
    );
    expect(resumePlan.status).toBe(201);

    const refused = await app.request(
      `http://localhost/api/v1/missions/${missionId}/plan-approval`,
      {
        method: 'POST',
        headers: auth(listed.token),
        body: JSON.stringify({ content: 'should not be allowed' }),
      },
    );
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('insufficient_scope');
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
