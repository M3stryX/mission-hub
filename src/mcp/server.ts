import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { hasScopes, type Principal, type Scope } from '../auth/config.js';
import { CONTRACT_MCP_TOOL_DESCRIPTIONS } from '../contract/inventory.js';
import {
  ClaimAlreadyReleasedError,
  ClaimConflictError,
  ClaimExpiredError,
  ClaimFencedError,
  ClaimNotOwnedError,
  ClaimReleaseIncompleteError,
  ClaimReleaseInconsistentError,
  DuplicateSourcePathError,
  MAX_CLAIM_LEASE_SECONDS,
  type MissionHubStore,
} from '../db/store.js';

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

function forbidden(required: readonly Scope[]) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: 'forbidden', required }),
      },
    ],
    isError: true,
  };
}

function toolError(error: string, extra: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error, ...extra }),
      },
    ],
    isError: true,
  };
}

function requireScopes(
  principal: Principal,
  required: readonly Scope[],
): boolean {
  return hasScopes(principal, required);
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
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.list'],
      inputSchema: z.object({ query: z.string().optional() }),
    },
    async ({ query }) =>
      requireScopes(principal, ['missions:read'])
        ? toolResult(await store.listMissions(query))
        : forbidden(['missions:read']),
  );

  server.registerTool(
    'missions.get',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.get'],
      inputSchema: z.object({ id: z.number().int().positive() }),
    },
    async ({ id }) =>
      requireScopes(principal, ['missions:read'])
        ? toolResult(await store.getMission(id))
        : forbidden(['missions:read']),
  );

  server.registerTool(
    'missions.create',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.create'],
      inputSchema: z.object({
        title: z.string().min(1),
        body: z.string().nullable().optional(),
        status: z.string().optional(),
        priority: z.number().int().min(1).max(5).optional(),
        parentId: z.number().int().positive().nullable().optional(),
        tags: z.string().nullable().optional(),
      }),
    },
    async (input) =>
      requireScopes(principal, ['missions:write'])
        ? toolResult(await store.createMission(input, principal.clientId))
        : forbidden(['missions:write']),
  );

  server.registerTool(
    'missions.update',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.update'],
      inputSchema: z.object({
        id: z.number().int().positive(),
        title: z.string().min(1).optional(),
        body: z.string().nullable().optional(),
        status: z.string().optional(),
        priority: z.number().int().min(1).max(5).optional(),
        parentId: z.number().int().positive().nullable().optional(),
        tags: z.string().nullable().optional(),
        dueAt: z.string().nullable().optional(),
        source: z.string().nullable().optional(),
        recurrence: z.string().nullable().optional(),
      }),
    },
    async ({ id, ...input }) => {
      if (!requireScopes(principal, ['missions:write'])) {
        return forbidden(['missions:write']);
      }
      const mission = await store.updateMission(id, input, principal.clientId);
      return mission
        ? toolResult(mission)
        : toolError('not_found', { id });
    },
  );

  server.registerTool(
    'missions.checklist.list',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.checklist.list'],
      inputSchema: z.object({ missionId: z.number().int().positive() }),
    },
    async ({ missionId }) =>
      requireScopes(principal, ['missions:read'])
        ? toolResult(await store.listChecklistItems(missionId))
        : forbidden(['missions:read']),
  );

  server.registerTool(
    'missions.checklist.add',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.checklist.add'],
      inputSchema: z.object({
        missionId: z.number().int().positive(),
        item: z.string().min(1),
        position: z.number().int().min(0).optional(),
      }),
    },
    async ({ missionId, item, position }) => {
      if (!requireScopes(principal, ['missions:write'])) {
        return forbidden(['missions:write']);
      }
      const row = await store.addChecklistItem(
        missionId,
        item,
        position,
        principal.clientId,
      );
      return row ? toolResult(row) : toolError('not_found', { missionId });
    },
  );

  server.registerTool(
    'missions.checklist.update',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.checklist.update'],
      inputSchema: z.object({
        missionId: z.number().int().positive(),
        itemId: z.number().int().positive(),
        item: z.string().min(1).optional(),
        done: z.boolean().optional(),
        position: z.number().int().min(0).optional(),
      }),
    },
    async ({ missionId, itemId, item, done, position }) => {
      if (!requireScopes(principal, ['missions:write'])) {
        return forbidden(['missions:write']);
      }
      const row = await store.updateChecklistItem(
        missionId,
        itemId,
        { item, done, position },
        principal.clientId,
      );
      return row
        ? toolResult(row)
        : toolError('not_found', { missionId, itemId });
    },
  );

  server.registerTool(
    'missions.checklist.remove',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.checklist.remove'],
      inputSchema: z.object({
        missionId: z.number().int().positive(),
        itemId: z.number().int().positive(),
      }),
    },
    async ({ missionId, itemId }) => {
      if (!requireScopes(principal, ['missions:write'])) {
        return forbidden(['missions:write']);
      }
      const row = await store.removeChecklistItem(
        missionId,
        itemId,
        principal.clientId,
      );
      return row
        ? toolResult(row)
        : toolError('not_found', { missionId, itemId });
    },
  );

  server.registerTool(
    'missions.sources.list',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.sources.list'],
      inputSchema: z.object({ missionId: z.number().int().positive() }),
    },
    async ({ missionId }) =>
      requireScopes(principal, ['missions:read'])
        ? toolResult(await store.listSources(missionId))
        : forbidden(['missions:read']),
  );

  server.registerTool(
    'missions.sources.add',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.sources.add'],
      inputSchema: z.object({
        missionId: z.number().int().positive(),
        label: z.string().min(1),
        path: z.string().min(1),
        kind: z.enum(['doc', 'link']),
      }),
    },
    async ({ missionId, label, path, kind }) => {
      if (!requireScopes(principal, ['missions:write'])) {
        return forbidden(['missions:write']);
      }
      try {
        const row = await store.addSource(
          missionId,
          { label, path, kind },
          principal.clientId,
        );
        return row ? toolResult(row) : toolError('not_found', { missionId });
      } catch (error) {
        if (error instanceof DuplicateSourcePathError) {
          return toolError('duplicate_source_path', { missionId, path });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'missions.sources.remove',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.sources.remove'],
      inputSchema: z.object({
        missionId: z.number().int().positive(),
        sourceId: z.number().int().positive(),
      }),
    },
    async ({ missionId, sourceId }) => {
      if (!requireScopes(principal, ['missions:write'])) {
        return forbidden(['missions:write']);
      }
      const row = await store.removeSource(
        missionId,
        sourceId,
        principal.clientId,
      );
      return row
        ? toolResult(row)
        : toolError('not_found', { missionId, sourceId });
    },
  );

  server.registerTool(
    'missions.events.list',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.events.list'],
      inputSchema: z.object({ missionId: z.number().int().positive() }),
    },
    async ({ missionId }) =>
      requireScopes(principal, ['missions:read'])
        ? toolResult(await store.listMissionEvents(missionId))
        : forbidden(['missions:read']),
  );

  server.registerTool(
    'missions.claim.get',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.claim.get'],
      inputSchema: z.object({ missionId: z.number().int().positive() }),
    },
    async ({ missionId }) =>
      requireScopes(principal, ['missions:read'])
        ? toolResult({ claim: await store.getActiveClaim(missionId) })
        : forbidden(['missions:read']),
  );

  server.registerTool(
    'missions.claim',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.claim'],
      inputSchema: z.object({
        missionId: z.number().int().positive(),
        runtime: z.string().min(1),
        agent: z.string().min(1),
        externalSessionId: z.string().min(1),
        externalRunId: z.string().min(1),
        leaseSeconds: z
          .number()
          .int()
          .positive()
          .max(MAX_CLAIM_LEASE_SECONDS)
          .optional(),
        correlationId: z.string().nullable().optional(),
        provider: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
      }),
    },
    async (input) => {
      if (!requireScopes(principal, ['runs:write'])) {
        return forbidden(['runs:write']);
      }
      try {
        const result = await store.claimMission(input, principal.clientId);
        return result
          ? toolResult(result)
          : toolError('not_found', { missionId: input.missionId });
      } catch (error) {
        if (error instanceof ClaimConflictError) {
          return toolError('claim_conflict', {
            missionId: error.missionId,
            claimId: error.claimId,
          });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'missions.claim.renew',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.claim.renew'],
      inputSchema: z.object({
        claimId: z.number().int().positive(),
        leaseSeconds: z
          .number()
          .int()
          .positive()
          .max(MAX_CLAIM_LEASE_SECONDS)
          .optional(),
      }),
    },
    async ({ claimId, leaseSeconds }) => {
      if (!requireScopes(principal, ['runs:write'])) {
        return forbidden(['runs:write']);
      }
      try {
        const claim = await store.renewClaim(
          claimId,
          principal.clientId,
          leaseSeconds,
        );
        return claim
          ? toolResult({ claim })
          : toolError('not_found', { claimId });
      } catch (error) {
        if (error instanceof ClaimNotOwnedError) {
          return toolError('claim_not_owned', { claimId: error.claimId });
        }
        if (error instanceof ClaimExpiredError) {
          return toolError('claim_expired', { claimId: error.claimId });
        }
        if (error instanceof ClaimAlreadyReleasedError) {
          return toolError('claim_already_released', {
            claimId: error.claimId,
          });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'missions.claim.release',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['missions.claim.release'],
      inputSchema: z.object({
        claimId: z.number().int().positive(),
        reason: z.enum(['completed', 'failed', 'abandoned']),
      }),
    },
    async ({ claimId, reason }) => {
      if (!requireScopes(principal, ['runs:write'])) {
        return forbidden(['runs:write']);
      }
      try {
        const claim = await store.releaseClaim(
          claimId,
          principal.clientId,
          reason,
        );
        return claim
          ? toolResult({ claim })
          : toolError('not_found', { claimId });
      } catch (error) {
        if (error instanceof ClaimNotOwnedError) {
          return toolError('claim_not_owned', { claimId: error.claimId });
        }
        if (error instanceof ClaimAlreadyReleasedError) {
          return toolError('claim_already_released', {
            claimId: error.claimId,
          });
        }
        if (error instanceof ClaimReleaseIncompleteError) {
          return toolError('claim_release_incomplete', {
            claimId: error.claimId,
            runId: error.runId,
            missing: error.missing,
          });
        }
        if (error instanceof ClaimReleaseInconsistentError) {
          return toolError('claim_release_inconsistent', {
            claimId: error.claimId,
            runId: error.runId,
            runStatus: error.runStatus,
            reason: error.reason,
          });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'runs.list',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['runs.list'],
      inputSchema: z.object({ missionId: z.number().int().positive() }),
    },
    async ({ missionId }) =>
      requireScopes(principal, ['runs:read'])
        ? toolResult(await store.listRunsForMission(missionId))
        : forbidden(['runs:read']),
  );

  server.registerTool(
    'runs.create',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['runs.create'],
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
    async (input) =>
      requireScopes(principal, ['runs:write'])
        ? toolResult(await store.createRun(input, principal.clientId))
        : forbidden(['runs:write']),
  );

  server.registerTool(
    'runs.updateStatus',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['runs.updateStatus'],
      inputSchema: z.object({
        runId: z.number().int().positive(),
        status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']),
        reviewState: z
          .enum(['NONE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'])
          .optional(),
      }),
    },
    async ({ runId, status, reviewState }) => {
      if (!requireScopes(principal, ['runs:write'])) {
        return forbidden(['runs:write']);
      }
      try {
        return toolResult(
          await store.updateRunStatus(
            runId,
            status,
            reviewState,
            principal.clientId,
          ),
        );
      } catch (error) {
        if (error instanceof ClaimFencedError) {
          return toolError('claim_fenced', {
            missionId: error.missionId,
            claimId: error.claimId,
          });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'runs.listEvents',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['runs.listEvents'],
      inputSchema: z.object({ runId: z.number().int().positive() }),
    },
    async ({ runId }) =>
      requireScopes(principal, ['runs:read'])
        ? toolResult(await store.listRunEvents(runId))
        : forbidden(['runs:read']),
  );

  server.registerTool(
    'runs.recordSummary',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['runs.recordSummary'],
      inputSchema: z.object({
        runId: z.number().int().positive(),
        type: z.enum(['agent_self_report', 'reviewer_validated', 'operator_note']),
        content: z.string().min(1),
      }),
    },
    async ({ runId, type, content }) => {
      if (!requireScopes(principal, ['summaries:write'])) {
        return forbidden(['summaries:write']);
      }
      try {
        return toolResult(
          await store.addSummary(runId, type, content, principal.clientId),
        );
      } catch (error) {
        if (error instanceof ClaimFencedError) {
          return toolError('claim_fenced', {
            missionId: error.missionId,
            claimId: error.claimId,
          });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'runs.listSummaries',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['runs.listSummaries'],
      inputSchema: z.object({ runId: z.number().int().positive() }),
    },
    async ({ runId }) =>
      requireScopes(principal, ['summaries:read'])
        ? toolResult(await store.listSummaries(runId))
        : forbidden(['summaries:read']),
  );

  server.registerTool(
    'runs.recordEvidence',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['runs.recordEvidence'],
      inputSchema: z.object({
        runId: z.number().int().positive(),
        kind: z.string().min(1),
        label: z.string().min(1),
        uri: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    },
    async ({ runId, kind, label, uri, metadata }) => {
      if (!requireScopes(principal, ['evidence:write'])) {
        return forbidden(['evidence:write']);
      }
      try {
        return toolResult(
          await store.addEvidence(
            runId,
            kind,
            label,
            uri,
            metadata ?? null,
            principal.clientId,
          ),
        );
      } catch (error) {
        if (error instanceof ClaimFencedError) {
          return toolError('claim_fenced', {
            missionId: error.missionId,
            claimId: error.claimId,
          });
        }
        throw error;
      }
    },
  );

  server.registerTool(
    'runs.listEvidence',
    {
      description: CONTRACT_MCP_TOOL_DESCRIPTIONS['runs.listEvidence'],
      inputSchema: z.object({ runId: z.number().int().positive() }),
    },
    async ({ runId }) =>
      requireScopes(principal, ['evidence:read'])
        ? toolResult(await store.listEvidence(runId))
        : forbidden(['evidence:read']),
  );

  return server;
}
