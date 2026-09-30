import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Principal } from '../auth/config.js';
import type { MissionHubStore } from '../db/store.js';

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

export function buildMcpServer(
  store: MissionHubStore,
  principal: Principal,
): McpServer {
  const server = new McpServer({
    name: 'mission-hub',
    version: '0.1.0',
  });

  server.registerTool(
    'missions.list',
    {
      description: 'List or search durable missions',
      inputSchema: z.object({ query: z.string().optional() }),
    },
    async ({ query }) => toolResult(await store.listMissions(query)),
  );

  server.registerTool(
    'missions.get',
    {
      description: 'Get one durable mission by id',
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) => toolResult(await store.getMission(id)),
  );

  server.registerTool(
    'missions.create',
    {
      description: 'Create a durable mission',
      inputSchema: z.object({
        title: z.string().min(1),
        body: z.string().nullable().optional(),
        status: z.string().optional(),
        priority: z.number().int().min(1).max(5).optional(),
        parentId: z.number().int().positive().nullable().optional(),
      }),
    },
    async (input) => toolResult(await store.createMission(input, principal.clientId)),
  );

  server.registerTool(
    'runs.list',
    {
      description: 'List execution runs for a mission',
      inputSchema: z.object({ missionId: z.number().int().positive() }),
    },
    async ({ missionId }) => toolResult(await store.listRunsForMission(missionId)),
  );

  server.registerTool(
    'runs.create',
    {
      description: 'Create a durable execution run linked to a mission and agent session',
      inputSchema: z.object({
        missionId: z.number().int().positive(),
        runtime: z.string().min(1),
        agent: z.string().min(1),
        externalSessionId: z.string().min(1),
        externalRunId: z.string().min(1),
        correlationId: z.string().nullable().optional(),
        provider: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
      }),
    },
    async (input) => toolResult(await store.createRun(input, principal.clientId)),
  );

  server.registerTool(
    'runs.updateStatus',
    {
      description: 'Update run status and persist the transition event atomically',
      inputSchema: z.object({
        runId: z.number().int().positive(),
        status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']),
        reviewState: z
          .enum(['NONE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'])
          .optional(),
      }),
    },
    async ({ runId, status, reviewState }) =>
      toolResult(
        await store.updateRunStatus(
          runId,
          status,
          reviewState,
          principal.clientId,
        ),
      ),
  );

  server.registerTool(
    'runs.recordSummary',
    {
      description: 'Append a typed summary to a run',
      inputSchema: z.object({
        runId: z.number().int().positive(),
        type: z.enum(['agent_self_report', 'reviewer_validated', 'operator_note']),
        content: z.string().min(1),
      }),
    },
    async ({ runId, type, content }) =>
      toolResult(
        await store.addSummary(runId, type, content, principal.clientId),
      ),
  );

  server.registerTool(
    'runs.recordEvidence',
    {
      description: 'Append an evidence reference to a run',
      inputSchema: z.object({
        runId: z.number().int().positive(),
        kind: z.string().min(1),
        label: z.string().min(1),
        uri: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    },
    async ({ runId, kind, label, uri, metadata }) =>
      toolResult(
        await store.addEvidence(
          runId,
          kind,
          label,
          uri,
          metadata ?? null,
        ),
      ),
  );

  return server;
}
