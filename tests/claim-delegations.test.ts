import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import type { ClientCredential, Scope } from '../src/auth/config.js';
import { MissionHubStore } from '../src/db/store.js';

/**
 * Delegated run writes (migrations/0007_claim_delegations.sql).
 *
 * The guard in `assertRunMutationAllowed` fenced every write while another client held the active
 * claim, which made hub-and-spoke delivery impossible: the coordinator holds the claim for the whole
 * mission. A claim may now name the clients it delegates to, and a delegated client may write on runs
 * it owns inside that mission — for as long as that claim is the active one.
 */
const databaseUrl = process.env.DATABASE_URL;
const workerScopes: Scope[] = [
  'missions:read',
  'runs:read',
  'runs:write',
  'summaries:read',
  'summaries:write',
  'evidence:read',
  'evidence:write',
];

const coordinatorScopes: Scope[] = [...workerScopes, 'missions:write'];

describe.skipIf(!databaseUrl)('claim delegations', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const credentials: ClientCredential[] = [
    { clientId: 'coordinator', token: 'coordinator-token', scopes: new Set(coordinatorScopes) },
    { clientId: 'delegate-b', token: 'delegate-b-token', scopes: new Set(workerScopes) },
    { clientId: 'stranger-c', token: 'stranger-c-token', scopes: new Set(workerScopes) },
    {
      clientId: 'coordinator-2',
      token: 'coordinator-2-token',
      scopes: new Set(coordinatorScopes),
    },
  ];
  const app = createApp(new MissionHubStore(pool), {
    envCredentials: credentials,
    adminToken: 'delegation-admin-token',
  });
  const host = { Host: 'localhost' };

  const authFor = (token: string) => ({
    ...host,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });
  const coordinator = authFor('coordinator-token');
  const delegateB = authFor('delegate-b-token');
  const strangerC = authFor('stranger-c-token');
  const coordinator2 = authFor('coordinator-2-token');

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
      headers: coordinator,
      body: JSON.stringify({ title: 'Delegation target' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mission: { id: number } };
    return body.mission.id;
  }

  async function claim(missionId: number, headers: typeof coordinator, extra: object = {}) {
    const res = await app.request(`http://localhost/api/v1/missions/${missionId}/claim`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        runtime: 'cursor',
        agent: 'delegation-test',
        externalSessionId: `session-${Math.random().toString(36).slice(2)}`,
        externalRunId: `run-${Math.random().toString(36).slice(2)}`,
        leaseSeconds: 120,
        ...extra,
      }),
    });
    return res;
  }

  async function createRun(missionId: number, headers: typeof coordinator) {
    const res = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        missionId,
        runtime: 'cursor',
        agent: 'worker',
        externalSessionId: `ws-${Math.random().toString(36).slice(2)}`,
        externalRunId: `wr-${Math.random().toString(36).slice(2)}`,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { run: { id: number } };
    return body.run.id;
  }

  async function writeSummary(runId: number, headers: typeof coordinator) {
    return app.request(`http://localhost/api/v1/runs/${runId}/summaries`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'agent_self_report', content: 'receipt body' }),
    });
  }

  async function writeEvidence(runId: number, headers: typeof coordinator) {
    return app.request(`http://localhost/api/v1/runs/${runId}/evidence`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'verification',
        label: 'checker output',
        uri: 'git:M3stryX/ai-reusable-kit@89dd354:scripts/check-souls.py',
      }),
    });
  }

  it('lets a delegated client write a receipt while the coordinator holds the claim', async () => {
    const missionId = await createMission();
    const claimed = await claim(missionId, coordinator, { delegatedClients: ['delegate-b'] });
    expect(claimed.status).toBe(201);
    const claimBody = (await claimed.json()) as { claim: { id: number } };

    const runId = await createRun(missionId, delegateB);
    expect((await writeSummary(runId, delegateB)).status).toBe(201);
    expect((await writeEvidence(runId, delegateB)).status).toBe(201);

    const delegated = await pool.query(
      'SELECT client_id FROM claim_delegations WHERE claim_id = $1',
      [claimBody.claim.id],
    );
    expect(delegated.rows.map((row: { client_id: string }) => row.client_id)).toEqual(['delegate-b']);
  });

  it('still fences a client that was never delegated', async () => {
    const missionId = await createMission();
    expect((await claim(missionId, coordinator, { delegatedClients: ['delegate-b'] })).status).toBe(201);

    const runId = await createRun(missionId, strangerC);
    // REST maps the fence to 403 (the MCP transport reports the same refusal as toolError).
    const summary = await writeSummary(runId, strangerC);
    expect(summary.status).toBe(403);
    expect(((await summary.json()) as { error: string }).error).toBe('claim_fenced');
    expect((await writeEvidence(runId, strangerC)).status).toBe(403);
  });

  it('drops the delegation when another client takes the claim', async () => {
    const missionId = await createMission();
    const first = await claim(missionId, coordinator, { delegatedClients: ['delegate-b'] });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      claim: { id: number; run_id: number };
      run: { id: number };
    };
    const claimId = firstBody.claim.id;

    // A `completed` release requires a summary and evidence on the claim's own run.
    expect((await writeSummary(firstBody.run.id, coordinator)).status).toBe(201);
    expect((await writeEvidence(firstBody.run.id, coordinator)).status).toBe(201);

    const released = await app.request(`http://localhost/api/v1/claims/${claimId}/release`, {
      method: 'POST',
      headers: coordinator,
      body: JSON.stringify({ reason: 'completed' }),
    });
    expect(released.status).toBe(200);

    expect((await claim(missionId, coordinator2)).status).toBe(201);

    const runId = await createRun(missionId, delegateB);
    const summary = await writeSummary(runId, delegateB);
    expect(summary.status).toBe(403);
    expect(((await summary.json()) as { error: string }).error).toBe('claim_fenced');
  });

  it('ignores a delegation naming the claim holder itself', async () => {
    const missionId = await createMission();
    const claimed = await claim(missionId, coordinator, { delegatedClients: ['coordinator'] });
    expect(claimed.status).toBe(201);
    const claimId = ((await claimed.json()) as { claim: { id: number } }).claim.id;

    const rows = await pool.query('SELECT client_id FROM claim_delegations WHERE claim_id = $1', [
      claimId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  /**
   * Run ownership (execution_runs.client_id). A delegation used to open the fence
   * without checking who owns the run, so a delegated client could write into any
   * run of the mission. The rule is: the claim holder writes anywhere in its
   * mission, everyone else writes only on its own runs.
   */
  it('refuses a delegated client writing on another client run (run_not_owned)', async () => {
    const missionId = await createMission();
    expect((await claim(missionId, coordinator, { delegatedClients: ['delegate-b'] })).status).toBe(
      201,
    );

    const foreignRunId = await createRun(missionId, strangerC);
    const summary = await writeSummary(foreignRunId, delegateB);

    expect(summary.status).toBe(403);
    const body = (await summary.json()) as { error: string; runId: number; ownerClientId: string };
    expect(body.error).toBe('run_not_owned');
    expect(body.runId).toBe(foreignRunId);
    expect(body.ownerClientId).toBe('stranger-c');
    expect((await writeEvidence(foreignRunId, delegateB)).status).toBe(403);
  });

  it('refuses the claim holder a foreign run too — there is no holder exception', async () => {
    const missionId = await createMission();
    expect((await claim(missionId, coordinator)).status).toBe(201);

    const foreignRunId = await createRun(missionId, strangerC);
    const res = await writeSummary(foreignRunId, coordinator);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('run_not_owned');
  });

  it('still releases a claim after its holder wrote the claim run (no exception needed)', async () => {
    // The claim's run is created by claimMission with the holder as owner, so
    // releaseClaim never needs to write into a foreign run — it only counts.
    const missionId = await createMission();
    const claimed = await claim(missionId, coordinator);
    expect(claimed.status).toBe(201);
    const claimBody = (await claimed.json()) as {
      claim: { id: number };
      run: { id: number };
    };

    expect((await writeSummary(claimBody.run.id, coordinator)).status).toBe(201);
    expect((await writeEvidence(claimBody.run.id, coordinator)).status).toBe(201);

    const released = await app.request(
      `http://localhost/api/v1/claims/${claimBody.claim.id}/release`,
      { method: 'POST', headers: coordinator, body: JSON.stringify({ reason: 'completed' }) },
    );
    expect(released.status).toBe(200);
  });

  it('refuses a foreign run even without any active claim', async () => {
    const missionId = await createMission();
    const foreignRunId = await createRun(missionId, strangerC);

    const summary = await writeSummary(foreignRunId, delegateB);
    expect(summary.status).toBe(403);
    expect(((await summary.json()) as { error: string }).error).toBe('run_not_owned');
  });

  it('lets a client write on its own run without any claim', async () => {
    const missionId = await createMission();
    const ownRunId = await createRun(missionId, delegateB);

    expect((await writeSummary(ownRunId, delegateB)).status).toBe(201);
    expect((await writeEvidence(ownRunId, delegateB)).status).toBe(201);
  });

  it('refuses a foreign run on runs.updateStatus too', async () => {
    const missionId = await createMission();
    expect((await claim(missionId, coordinator, { delegatedClients: ['delegate-b'] })).status).toBe(
      201,
    );
    const foreignRunId = await createRun(missionId, strangerC);

    const res = await app.request(`http://localhost/api/v1/runs/${foreignRunId}/status`, {
      method: 'PATCH',
      headers: delegateB,
      body: JSON.stringify({ status: 'COMPLETED' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('run_not_owned');
  });

  it('mirrors run_not_owned over MCP (toolError, not a silent refusal)', async () => {
    const missionId = await createMission();
    expect((await claim(missionId, coordinator, { delegatedClients: ['delegate-b'] })).status).toBe(
      201,
    );
    const foreignRunId = await createRun(missionId, strangerC);

    const connect = async (token: string): Promise<Client> => {
      const client = new Client(
        { name: 'claim-delegations-test', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const headers = new Headers(request.headers);
          headers.set('host', 'localhost');
          return app.fetch(new Request(request, { headers }));
        },
      });
      await client.connect(transport);
      return client;
    };

    const delegate = await connect('delegate-b-token');
    try {
      const result = (await delegate.callTool({
        name: 'runs.recordSummary',
        arguments: { runId: foreignRunId, type: 'agent_self_report', content: 'from the delegate' },
      })) as unknown as { isError?: boolean; content?: Array<{ text?: string }> };
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
        error?: string;
        runId?: number;
        ownerClientId?: string;
      };
      expect(payload.error).toBe('run_not_owned');
      expect(payload.runId).toBe(foreignRunId);
      expect(payload.ownerClientId).toBe('stranger-c');
    } finally {
      await delegate.close();
    }
  });
});
