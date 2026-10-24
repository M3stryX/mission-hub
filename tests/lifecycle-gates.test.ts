import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import type { ClientCredential, Scope } from '../src/auth/config.js';
import {
  AGENT_USAGE_CONTRACT,
  CONTRACT_ENUMS,
  CONTRACT_SCOPES,
} from '../src/contract/inventory.js';
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
const approverScopes: Scope[] = [...baseScopes, 'approvals:human'];

const newPurposes = ['architecture', 'planning', 'jev_gate'] as const;
const newSummaryTypes = [
  'plan_summary',
  'plan_approval',
  'jev_decision',
] as const;

type ApiBody = {
  mission?: { id: number };
  run?: { id: number; purpose: string | null };
  summary?: { id: number; type: string; client_id: string | null };
  summaries?: Array<{ id: number; type: string; client_id: string | null }>;
  evaluations?: Array<{
    id: number;
    type: string;
    mission_id: number;
    metadata_json: Record<string, unknown> | null;
  }>;
  error?: string;
};

type ToolOutcome = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: { result?: unknown };
};

const parseBody = async (res: { json(): Promise<unknown> }): Promise<ApiBody> =>
  (await res.json()) as ApiBody;

const toolErrorOf = (result: ToolOutcome): string | undefined => {
  const text = result.content?.[0]?.text;
  if (!text) return undefined;
  return (JSON.parse(text) as { error?: string }).error;
};

describe.skipIf(!databaseUrl)('Lifecycle gates (v3.1) contract', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const credentials: ClientCredential[] = [
    {
      clientId: 'operator-1',
      token: 'operator-token',
      scopes: new Set(baseScopes),
    },
    {
      clientId: 'planner-1',
      token: 'planner-token',
      scopes: new Set(approverScopes),
    },
    {
      clientId: 'approver-1',
      token: 'approver-token',
      scopes: new Set(approverScopes),
    },
  ];
  const app = createApp(new MissionHubStore(pool), {
    envCredentials: credentials,
  });

  const auth = (token: string) => ({
    Host: 'localhost',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  const createMission = async (
    title: string,
    token = 'operator-token',
  ): Promise<number> => {
    const res = await app.request('http://localhost/api/v1/missions', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    const id = (await parseBody(res)).mission?.id;
    if (!id) throw new Error('mission create returned no id');
    return id;
  };

  const createRun = async (
    missionId: number,
    purpose: string,
    tag: string,
    token = 'operator-token',
  ): Promise<number> => {
    const res = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        missionId,
        runtime: 'hermes',
        agent: 'builder',
        externalSessionId: `session-${tag}`,
        externalRunId: `run-${tag}`,
        purpose,
      }),
    });
    expect(res.status).toBe(201);
    const runId = (await parseBody(res)).run?.id;
    if (!runId) throw new Error('run create returned no id');
    return runId;
  };

  const recordSummary = async (
    runId: number,
    type: string,
    content: string,
    token = 'operator-token',
    metadata: Record<string, unknown> | null = null,
  ) => {
    const res = await app.request(
      `http://localhost/api/v1/runs/${runId}/summaries`,
      {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ type, content, metadata }),
      },
    );
    return { res, body: await parseBody(res) };
  };

  const connectMcp = async (token: string): Promise<Client> => {
    const client = new Client(
      { name: 'lifecycle-gates-test', version: '1.0.0' },
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
    await client.connect(transport);
    return client;
  };

  const callTool = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolOutcome> =>
    (await client.callTool({ name, arguments: args })) as unknown as
      ToolOutcome;

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE evidence, summaries, execution_events, mission_claims, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions, api_clients RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('publishes the v3.1 lifecycle surface in the contract inventory', () => {
    expect(AGENT_USAGE_CONTRACT.version).toBe('v3.1');
    expect(CONTRACT_SCOPES).toContain('approvals:human');
    for (const purpose of newPurposes) {
      expect(CONTRACT_ENUMS.run_purpose).toContain(purpose);
    }
    for (const type of newSummaryTypes) {
      expect(CONTRACT_ENUMS.summary_type).toContain(type);
    }
    expect(CONTRACT_ENUMS.mission_stage).toEqual([
      'research',
      'architecture',
      'plan',
      'execution',
      'done',
    ]);
    const snapshot = JSON.parse(
      readFileSync(
        new URL('../docs/contract-inventory.json', import.meta.url),
        'utf8',
      ),
    ) as { scopes: string[] };
    expect(snapshot.scopes).toContain('approvals:human');
  });

  it('accepts the new run purposes on runs.create', async () => {
    const missionId = await createMission('New run purposes');
    for (const purpose of newPurposes) {
      const runId = await createRun(missionId, purpose, `purpose-${purpose}`);
      const res = await app.request(
        `http://localhost/api/v1/missions/${missionId}/runs?purpose=${purpose}`,
        { headers: auth('operator-token') },
      );
      expect(res.status).toBe(200);
      const { runs } = (await res.json()) as {
        runs: Array<{ id: number; purpose: string | null }>;
      };
      expect(runs.map((run) => run.id)).toContain(runId);
      expect(runs.every((run) => run.purpose === purpose)).toBe(true);
    }
  });

  it('accepts the new summary types on runs.recordSummary', async () => {
    const missionId = await createMission('New summary types');
    const runId = await createRun(missionId, 'planning', 'summary-types');
    // plan_summary and jev_decision only need summaries:write (operator-token has it)
    for (const type of ['plan_summary', 'jev_decision']) {
      const { res, body } = await recordSummary(
        runId,
        type,
        `recorded ${type}`,
        'operator-token',
        { checkpoint: type },
      );
      expect(res.status).toBe(201);
      expect(body.summary?.type).toBe(type);
    }
    // plan_approval requires approvals:human scope (approver-token has it) and,
    // since run ownership is enforced, a run the approver itself owns.
    const approverRunId = await createRun(
      missionId,
      'planning',
      'summary-types-approver',
      'approver-token',
    );
    const { res, body } = await recordSummary(
      approverRunId,
      'plan_approval',
      'recorded plan_approval',
      'approver-token',
      { checkpoint: 'plan_approval' },
    );
    expect(res.status).toBe(201);
    expect(body.summary?.type).toBe('plan_approval');
    const list = await app.request(
      `http://localhost/api/v1/runs/${approverRunId}/summaries?type=plan_approval`,
      { headers: auth('operator-token') },
    );
    expect(list.status).toBe(200);
    expect((await parseBody(list)).summaries).toHaveLength(1);
  });

  it('refuses plan_approval on the generic summary writers without approvals:human', async () => {
    const missionId = await createMission('Unguarded plan approval');
    const runId = await createRun(missionId, 'planning', 'guard-negative');

    // REST: a summaries:write-only principal is refused.
    const rest = await recordSummary(
      runId,
      'plan_approval',
      'unauthorized approval',
      'operator-token',
      { checkpoint: 'plan_approval' },
    );
    expect(rest.res.status).toBe(403);
    expect(rest.body.error).toBe('insufficient_scope');

    // MCP: same rule on the tool surface.
    const operator = await connectMcp('operator-token');
    const mcpResult = await callTool(operator, 'runs.recordSummary', {
      runId,
      type: 'plan_approval',
      content: 'unauthorized approval via MCP',
      metadata: { checkpoint: 'plan_approval' },
    });
    expect(mcpResult.isError).toBe(true);
    expect(toolErrorOf(mcpResult)).toBe('forbidden');

    // Neither surface persisted anything.
    const listed = await app.request(
      `http://localhost/api/v1/runs/${runId}/summaries?type=plan_approval`,
      { headers: auth('operator-token') },
    );
    expect(listed.status).toBe(200);
    expect((await parseBody(listed)).summaries).toHaveLength(0);
  });

  it('serves jev evaluations over REST and MCP with identical rows', async () => {
    const missionId = await createMission('JEV mission');
    const otherMissionId = await createMission('Other JEV mission');
    const runId = await createRun(missionId, 'jev_gate', 'jev-a');
    const otherRunId = await createRun(otherMissionId, 'jev_gate', 'jev-b');
    await recordSummary(runId, 'jev_decision', 'JEV-A pass', 'operator-token', {
      checkpoint: 'JEV-A',
    });
    await recordSummary(
      runId,
      'jev_decision',
      'JEV-A details',
      'operator-token',
      { checkpoint: 'JEV-A2' },
    );
    await recordSummary(
      otherRunId,
      'jev_decision',
      'JEV-B pass',
      'operator-token',
      { checkpoint: 'JEV-B' },
    );

    const restAll = await parseBody(
      await app.request(
        `http://localhost/api/v1/missions/${missionId}/jev-evaluations`,
        { headers: auth('operator-token') },
      ),
    );
    expect(restAll.evaluations).toHaveLength(2);
    for (const row of restAll.evaluations ?? []) {
      expect(row.type).toBe('jev_decision');
      expect(row.mission_id).toBe(missionId);
    }

    const restFiltered = await parseBody(
      await app.request(
        `http://localhost/api/v1/missions/${missionId}/jev-evaluations?checkpoint=JEV-A`,
        { headers: auth('operator-token') },
      ),
    );
    expect(restFiltered.evaluations).toHaveLength(1);

    const restGate = await parseBody(
      await app.request('http://localhost/api/v1/jev-gate', {
        headers: auth('operator-token'),
      }),
    );
    expect(restGate.evaluations).toHaveLength(3);

    const client = await connectMcp('operator-token');
    try {
      const mcpList = await callTool(client, 'jev.listEvaluations', {
        missionId,
      });
      expect(mcpList.isError).not.toBe(true);
      const mcpRows = (mcpList.structuredContent?.result ?? []) as Array<{
        id: number;
      }>;
      expect(mcpRows.map((row) => row.id)).toEqual(
        (restAll.evaluations ?? []).map((row) => row.id),
      );

      const mcpFiltered = await callTool(client, 'jev.listEvaluations', {
        missionId,
        checkpoint: 'JEV-A',
      });
      expect(mcpFiltered.isError).not.toBe(true);
      expect(
        ((mcpFiltered.structuredContent?.result ?? []) as Array<{
          id: number;
        }>).map((row) => row.id),
      ).toEqual(
        (restFiltered.evaluations ?? []).map((row) => row.id),
      );

      const mcpGate = await callTool(client, 'jev.getGateStatus', {});
      expect(mcpGate.isError).not.toBe(true);
      const mcpGateRows = (mcpGate.structuredContent?.result ?? []) as Array<{
        id: number;
      }>;
      expect(mcpGateRows.map((row) => row.id)).toEqual(
        (restGate.evaluations ?? []).map((row) => row.id),
      );
    } finally {
      await client.close();
    }
  });

  it('enforces plan_not_open, scope and self_approval on plan-approval (REST)', async () => {
    const missionId = await createMission('Plan approval mission');

    const unknown = await app.request(
      'http://localhost/api/v1/missions/999999/plan-approval',
      {
        method: 'POST',
        headers: auth('approver-token'),
        body: JSON.stringify({ content: 'Approved' }),
      },
    );
    expect(unknown.status).toBe(404);

    const noScope = await app.request(
      `http://localhost/api/v1/missions/${missionId}/plan-approval`,
      {
        method: 'POST',
        headers: auth('operator-token'),
        body: JSON.stringify({ content: 'Approved' }),
      },
    );
    expect(noScope.status).toBe(403);
    expect(await parseBody(noScope)).toMatchObject({
      error: 'insufficient_scope',
      required: ['approvals:human'],
    });

    const unauthenticated = await app.request(
      `http://localhost/api/v1/missions/${missionId}/plan-approval`,
      {
        method: 'POST',
        headers: { Host: 'localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Approved' }),
      },
    );
    expect(unauthenticated.status).toBe(401);

    const notOpen = await app.request(
      `http://localhost/api/v1/missions/${missionId}/plan-approval`,
      {
        method: 'POST',
        headers: auth('approver-token'),
        body: JSON.stringify({ content: 'Approved' }),
      },
    );
    expect(notOpen.status).toBe(409);
    expect((await parseBody(notOpen)).error).toBe('plan_not_open');

    // The planning run belongs to the planner: run ownership is enforced on the
    // generic summary writer, so the plan_summary must be written on its own run.
    const planRunId = await createRun(missionId, 'planning', 'plan-run', 'planner-token');
    const planSummary = await recordSummary(
      planRunId,
      'plan_summary',
      'Execution plan v1',
      'planner-token',
    );
    expect(planSummary.res.status).toBe(201);

    const selfApproval = await app.request(
      `http://localhost/api/v1/missions/${missionId}/plan-approval`,
      {
        method: 'POST',
        headers: auth('planner-token'),
        body: JSON.stringify({ content: 'LGTM' }),
      },
    );
    expect(selfApproval.status).toBe(409);
    expect((await parseBody(selfApproval)).error).toBe('self_approval');

    const approved = await app.request(
      `http://localhost/api/v1/missions/${missionId}/plan-approval`,
      {
        method: 'POST',
        headers: auth('approver-token'),
        body: JSON.stringify({ content: 'Approved by human' }),
      },
    );
    expect(approved.status).toBe(201);
    const summary = (await parseBody(approved)).summary;
    expect(summary?.type).toBe('plan_approval');
    expect(summary?.client_id).toBe('approver-1');
  });

  it('mirrors plan-approval semantics over MCP by construction', async () => {
    const missionId = await createMission('MCP plan approval');
    const planRunId = await createRun(missionId, 'planning', 'mcp-plan-run', 'planner-token');
    await recordSummary(
      planRunId,
      'plan_summary',
      'Execution plan v1',
      'planner-token',
    );

    const approver = await connectMcp('approver-token');
    const operator = await connectMcp('operator-token');
    const planner = await connectMcp('planner-token');
    try {
      const withoutPlanMissionId = await createMission(
        'MCP mission without plan',
      );
      const notOpen = await callTool(approver, 'missions.planApproval', {
        missionId: withoutPlanMissionId,
        content: 'Approved',
      });
      expect(notOpen.isError).toBe(true);
      expect(toolErrorOf(notOpen)).toBe('plan_not_open');

      const forbidden = await callTool(operator, 'missions.planApproval', {
        missionId,
        content: 'Approved',
      });
      expect(forbidden.isError).toBe(true);
      expect(toolErrorOf(forbidden)).toBe('forbidden');

      const plannerSelf = await callTool(planner, 'missions.planApproval', {
        missionId,
        content: 'Self approval',
      });
      expect(plannerSelf.isError).toBe(true);
      expect(toolErrorOf(plannerSelf)).toBe('self_approval');

      const approved = await callTool(approver, 'missions.planApproval', {
        missionId,
        content: 'Approved by human',
      });
      expect(approved.isError).not.toBe(true);
      const recorded = approved.structuredContent?.result as {
        type: string;
        client_id: string;
      };
      expect(recorded.type).toBe('plan_approval');
      expect(recorded.client_id).toBe('approver-1');
    } finally {
      await approver.close();
      await operator.close();
      await planner.close();
    }
  });
});
