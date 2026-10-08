import { hostHeaderValidation } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  ALL_SERVICE_SCOPES,
  parseScopes,
  type Principal,
  type Scope,
} from './auth/config.js';
import {
  requirePrincipal,
  resolvePrincipal,
  type AuthResolverOptions,
} from './auth/resolve.js';
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
  PlanNotOpenError,
  SelfApprovalError,
  VERIFY_FIXTURE_TAG,
  VerifyFixtureRejectedError,
  type MissionHubStore,
} from './db/store.js';
import { buildMcpServer } from './mcp/server.js';

const missionStatus = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
]);

const createMissionSchema = z.object({
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  status: missionStatus.optional(),
  priority: z.number().int().min(1).max(5).optional(),
  dueAt: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  tags: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  parentId: z.number().int().positive().nullable().optional(),
});

const updateMissionSchema = createMissionSchema.partial();

const runPurpose = z.enum([
  'research',
  'implementation',
  'runtime_verification',
  'independent_review',
  'incident_analysis',
  'maintenance',
  'migration',
  'benchmark',
  'other',
  'architecture',
  'planning',
  'jev_gate',
]);

const createRunSchema = z.object({
  missionId: z.number().int().positive(),
  runtime: z.string().min(1),
  agent: z.string().min(1),
  externalSessionId: z.string().min(1),
  externalRunId: z.string().min(1),
  correlationId: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  purpose: runPurpose.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const claimMissionSchema = z.object({
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
  purpose: runPurpose.nullable().optional(),
});

const renewClaimSchema = z.object({
  leaseSeconds: z
    .number()
    .int()
    .positive()
    .max(MAX_CLAIM_LEASE_SECONDS)
    .optional(),
});

const releaseClaimSchema = z.object({
  reason: z.enum(['completed', 'failed', 'abandoned']),
});

const updateRunStatusSchema = z.object({
  status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']),
  reviewState: z
    .enum(['NONE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'])
    .optional(),
});

const summaryType = z.enum([
  'agent_self_report',
  'research_report',
  'reviewer_validated',
  'operator_note',
  'plan_summary',
  'plan_approval',
  'jev_decision',
]);

const summaryMetadataSchema = z
  .object({
    schemaVersion: z.string().min(1).optional(),
    validatesSummaryId: z.number().int().positive().optional(),
    supersedesSummaryId: z.number().int().positive().optional(),
  })
  .passthrough();

const summarySchema = z.object({
  type: summaryType,
  content: z.string().min(1),
  metadata: summaryMetadataSchema.nullable().optional(),
});

const planApprovalSchema = z.object({
  content: z.string().min(1),
  metadata: summaryMetadataSchema.nullable().optional(),
});

const evidenceSourceType = z.enum([
  'observed_runtime',
  'real_data',
  'code_config',
  'internal_doc',
  'external_primary',
  'external_community',
  'inference',
]);

const evidenceMetadataSchema = z
  .object({
    source_type: evidenceSourceType.optional(),
    authority: z.string().min(1).optional(),
    observed_at: z.string().min(1).optional(),
    retrieved_at: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    supports: z.string().min(1).optional(),
    confidence: z.union([z.string().min(1), z.number().min(0).max(1)]).optional(),
    freshness: z.string().min(1).optional(),
    immutable: z.boolean().optional(),
    ref_type: z.string().min(1).optional(),
  })
  .passthrough();

const evidenceSchema = z.object({
  kind: z.string().min(1),
  label: z.string().min(1),
  uri: z.string().min(1),
  metadata: evidenceMetadataSchema.nullable().optional(),
});

const createClientSchema = z.object({
  clientId: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
  scopes: z.array(z.string()).min(1),
});

const checklistCreateSchema = z.object({
  item: z.string().min(1),
  position: z.number().int().min(0).optional(),
});

const checklistUpdateSchema = z.object({
  item: z.string().min(1).optional(),
  done: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

const sourceCreateSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(['doc', 'link']),
});

const STAGING_HOSTS = new Set([
  'mission-hub-staging.lan',
  'mission-staging.lan',
  'mission-hub-staging.mestryx.dev',
  'localhost',
  '127.0.0.1',
]);

const PROD_HOSTS = new Set(['mission-hub.lan', 'mission.lan']);

function parseId(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export type CreateAppOptions = AuthResolverOptions & {
  allowDestructiveVerify?: boolean;
};

function hasServiceScope(principal: Principal): boolean {
  return ALL_SERVICE_SCOPES.some((scope) => principal.scopes.has(scope));
}

function requestHost(header: string | undefined): string {
  return (header ?? '').split(':')[0].trim().toLowerCase();
}

export function createApp(
  store: MissionHubStore,
  options: CreateAppOptions = {},
) {
  const authOptions = options;
  const allowDestructiveVerify =
    options.allowDestructiveVerify ??
    process.env.MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY === 'true';

  const app = new Hono();
  app.use(
    '*',
    hostHeaderValidation([
      'localhost',
      '127.0.0.1',
      'mission.lan',
      'mission-staging.lan',
      'mission-hub-staging.lan',
      'mission-hub.lan',
      'mission-hub-staging.mestryx.dev',
    ]),
  );

  async function principalFor(
    authorization: string | undefined,
    scopes: readonly Scope[],
  ): Promise<Principal | null> {
    return requirePrincipal(authorization, store, authOptions, scopes);
  }

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/ready', async (c) => {
    try {
      await store.ready();
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ status: 'not_ready' }, 503);
    }
  });

  app.get('/api/v1/admin/clients', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'clients:admin',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ clients: await store.listClients() });
  });

  app.post('/api/v1/admin/clients', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'clients:admin',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const parsed = createClientSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    let scopes: Scope[];
    try {
      scopes = parseScopes(parsed.data.scopes);
    } catch {
      return c.json({ error: 'invalid_scopes' }, 400);
    }
    try {
      const created = await store.createClient(parsed.data.clientId, scopes);
      return c.json(
        {
          client: created.client,
          token: created.token,
        },
        201,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message.includes('api_clients_client_id_unique') ||
        message.includes('duplicate key')
      ) {
        return c.json({ error: 'client_exists' }, 409);
      }
      throw error;
    }
  });

  app.post('/api/v1/admin/clients/:clientId/revoke', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'clients:admin',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const client = await store.revokeClient(c.req.param('clientId'));
    return client ? c.json({ client }) : c.json({ error: 'not_found' }, 404);
  });

  app.delete('/api/v1/admin/verify-fixtures/:missionId', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'verify:admin',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);

    const host = requestHost(c.req.header('host'));
    if (PROD_HOSTS.has(host) || !allowDestructiveVerify) {
      return c.json({ error: 'destructive_verify_forbidden' }, 403);
    }
    if (!STAGING_HOSTS.has(host)) {
      return c.json({ error: 'destructive_verify_host_forbidden' }, 403);
    }

    const missionId = parseId(c.req.param('missionId'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);

    try {
      const mission = await store.deleteVerifyFixture(missionId);
      return mission
        ? c.json({ deleted: true, mission })
        : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof VerifyFixtureRejectedError) {
        return c.json(
          {
            error: 'verify_fixture_rejected',
            requiredTag: VERIFY_FIXTURE_TAG,
          },
          403,
        );
      }
      throw error;
    }
  });

  app.get('/api/v1/missions', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ missions: await store.listMissions(c.req.query('q')) });
  });

  app.get('/api/v1/missions/:id', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const id = parseId(c.req.param('id'));
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const mission = await store.getMission(id);
    return mission ? c.json({ mission }) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/api/v1/missions', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const parsed = createMissionSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const mission = await store.createMission(parsed.data, principal.clientId);
    return c.json({ mission }, 201);
  });

  app.patch('/api/v1/missions/:id', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const id = parseId(c.req.param('id'));
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const parsed = updateMissionSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const mission = await store.updateMission(
      id,
      parsed.data,
      principal.clientId,
    );
    return mission ? c.json({ mission }) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/api/v1/missions/:id/checklist', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    if (!(await store.getMission(missionId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ items: await store.listChecklistItems(missionId) });
  });

  app.post('/api/v1/missions/:id/checklist', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = checklistCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const item = await store.addChecklistItem(
      missionId,
      parsed.data.item,
      parsed.data.position,
      principal.clientId,
    );
    return item ? c.json({ item }, 201) : c.json({ error: 'not_found' }, 404);
  });

  app.patch('/api/v1/missions/:id/checklist/:itemId', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    const itemId = parseId(c.req.param('itemId'));
    if (!missionId || !itemId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = checklistUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    if (
      parsed.data.item === undefined &&
      parsed.data.done === undefined &&
      parsed.data.position === undefined
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const item = await store.updateChecklistItem(
      missionId,
      itemId,
      parsed.data,
      principal.clientId,
    );
    return item ? c.json({ item }) : c.json({ error: 'not_found' }, 404);
  });

  app.delete('/api/v1/missions/:id/checklist/:itemId', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    const itemId = parseId(c.req.param('itemId'));
    if (!missionId || !itemId) return c.json({ error: 'invalid_id' }, 400);
    const item = await store.removeChecklistItem(
      missionId,
      itemId,
      principal.clientId,
    );
    return item ? c.json({ item }) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/api/v1/missions/:id/sources', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    if (!(await store.getMission(missionId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ sources: await store.listSources(missionId) });
  });

  app.post('/api/v1/missions/:id/sources', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = sourceCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const source = await store.addSource(
        missionId,
        parsed.data,
        principal.clientId,
      );
      return source
        ? c.json({ source }, 201)
        : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof DuplicateSourcePathError) {
        return c.json({ error: 'duplicate_source_path' }, 409);
      }
      throw error;
    }
  });

  app.delete('/api/v1/missions/:id/sources/:sourceId', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    const sourceId = parseId(c.req.param('sourceId'));
    if (!missionId || !sourceId) return c.json({ error: 'invalid_id' }, 400);
    const source = await store.removeSource(
      missionId,
      sourceId,
      principal.clientId,
    );
    return source ? c.json({ source }) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/api/v1/missions/:id/events', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    if (!(await store.getMission(missionId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ events: await store.listMissionEvents(missionId) });
  });

  app.get('/api/v1/missions/:id/claim', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    if (!(await store.getMission(missionId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ claim: await store.getActiveClaim(missionId) });
  });

  app.post('/api/v1/missions/:id/claim', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = claimMissionSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const result = await store.claimMission(
        { missionId, ...parsed.data },
        principal.clientId,
      );
      return result
        ? c.json(result, 201)
        : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof ClaimConflictError) {
        return c.json(
          {
            error: 'claim_conflict',
            missionId: error.missionId,
            claimId: error.claimId,
          },
          409,
        );
      }
      throw error;
    }
  });

  app.post('/api/v1/claims/:claimId/renew', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const claimId = parseId(c.req.param('claimId'));
    if (!claimId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = renewClaimSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const claim = await store.renewClaim(
        claimId,
        principal.clientId,
        parsed.data.leaseSeconds,
      );
      return claim ? c.json({ claim }) : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof ClaimNotOwnedError) {
        return c.json({ error: 'claim_not_owned', claimId: error.claimId }, 403);
      }
      if (error instanceof ClaimExpiredError) {
        return c.json({ error: 'claim_expired', claimId: error.claimId }, 409);
      }
      if (error instanceof ClaimAlreadyReleasedError) {
        return c.json(
          { error: 'claim_already_released', claimId: error.claimId },
          409,
        );
      }
      throw error;
    }
  });

  app.post('/api/v1/claims/:claimId/release', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const claimId = parseId(c.req.param('claimId'));
    if (!claimId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = releaseClaimSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const claim = await store.releaseClaim(
        claimId,
        principal.clientId,
        parsed.data.reason,
      );
      return claim ? c.json({ claim }) : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof ClaimNotOwnedError) {
        return c.json({ error: 'claim_not_owned', claimId: error.claimId }, 403);
      }
      if (error instanceof ClaimAlreadyReleasedError) {
        return c.json(
          { error: 'claim_already_released', claimId: error.claimId },
          409,
        );
      }
      if (error instanceof ClaimReleaseIncompleteError) {
        return c.json(
          {
            error: 'claim_release_incomplete',
            claimId: error.claimId,
            runId: error.runId,
            missing: error.missing,
          },
          409,
        );
      }
      if (error instanceof ClaimReleaseInconsistentError) {
        return c.json(
          {
            error: 'claim_release_inconsistent',
            claimId: error.claimId,
            runId: error.runId,
            runStatus: error.runStatus,
            reason: error.reason,
          },
          409,
        );
      }
      throw error;
    }
  });

  app.get('/api/v1/missions/:id/runs', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    const purposeRaw = c.req.query('purpose');
    const purpose = purposeRaw ? runPurpose.safeParse(purposeRaw) : null;
    if (purpose && !purpose.success) {
      return c.json({ error: 'invalid_purpose' }, 400);
    }
    return c.json({
      runs: await store.listRunsForMission(
        missionId,
        purpose?.success ? purpose.data : undefined,
      ),
    });
  });

  app.get('/api/v1/missions/:id/research-reports', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:read',
      'summaries:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    return c.json({
      reports: await store.listResearchReportsForMission(missionId),
    });
  });

  app.get('/api/v1/missions/:id/research-report', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:read',
      'summaries:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    return c.json({
      report: await store.getCanonicalResearchReport(missionId),
    });
  });

  app.get('/api/v1/missions/:id/jev-evaluations', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:read',
      'summaries:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    const checkpoint = c.req.query('checkpoint') || undefined;
    return c.json({
      evaluations: await store.listJevEvaluationsForMission(
        missionId,
        checkpoint,
      ),
    });
  });

  app.get('/api/v1/jev-gate', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:read',
      'summaries:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ evaluations: await store.listJevEvaluations() });
  });

  app.post('/api/v1/missions/:id/plan-approval', async (c) => {
    const principal = await resolvePrincipal(
      c.req.header('authorization'),
      store,
      authOptions,
    );
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (!principal.scopes.has('approvals:human')) {
      return c.json({ error: 'forbidden', required: ['approvals:human'] }, 403);
    }
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = planApprovalSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const summary = await store.recordPlanApproval(
        missionId,
        parsed.data.content,
        principal.clientId,
        parsed.data.metadata ?? null,
      );
      return summary
        ? c.json({ summary }, 201)
        : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof PlanNotOpenError) {
        return c.json({ error: 'plan_not_open', missionId }, 401);
      }
      if (error instanceof SelfApprovalError) {
        return c.json({ error: 'self_approval', missionId }, 409);
      }
      throw error;
    }
  });

  app.post('/api/v1/runs', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const parsed = createRunSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const run = await store.createRun(parsed.data, principal.clientId);
    return c.json({ run }, 201);
  });

  app.patch('/api/v1/runs/:id/status', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const runId = parseId(c.req.param('id'));
    if (!runId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = updateRunStatusSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const run = await store.updateRunStatus(
        runId,
        parsed.data.status,
        parsed.data.reviewState,
        principal.clientId,
      );
      return run ? c.json({ run }) : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof ClaimFencedError) {
        return c.json(
          {
            error: 'claim_fenced',
            missionId: error.missionId,
            claimId: error.claimId,
          },
          403,
        );
      }
      throw error;
    }
  });

  app.get('/api/v1/runs/:id/events', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'runs:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const runId = parseId(c.req.param('id'));
    if (!runId) return c.json({ error: 'invalid_id' }, 400);
    return c.json({ events: await store.listRunEvents(runId) });
  });

  app.post('/api/v1/runs/:id/summaries', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'summaries:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const runId = parseId(c.req.param('id'));
    if (!runId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = summarySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const summary = await store.addSummary(
        runId,
        parsed.data.type,
        parsed.data.content,
        principal.clientId,
        parsed.data.metadata ?? null,
      );
      return c.json({ summary }, 201);
    } catch (error) {
      if (error instanceof ClaimFencedError) {
        return c.json(
          {
            error: 'claim_fenced',
            missionId: error.missionId,
            claimId: error.claimId,
          },
          403,
        );
      }
      throw error;
    }
  });

  app.get('/api/v1/runs/:id/summaries', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'summaries:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const runId = parseId(c.req.param('id'));
    if (!runId) return c.json({ error: 'invalid_id' }, 400);
    const typeRaw = c.req.query('type');
    const type = typeRaw ? summaryType.safeParse(typeRaw) : null;
    if (type && !type.success) {
      return c.json({ error: 'invalid_summary_type' }, 400);
    }
    return c.json({
      summaries: await store.listSummaries(
        runId,
        type?.success ? type.data : undefined,
      ),
    });
  });

  app.post('/api/v1/runs/:id/evidence', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'evidence:write',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const runId = parseId(c.req.param('id'));
    if (!runId) return c.json({ error: 'invalid_id' }, 400);
    const parsed = evidenceSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const evidence = await store.addEvidence(
        runId,
        parsed.data.kind,
        parsed.data.label,
        parsed.data.uri,
        parsed.data.metadata ?? null,
        principal.clientId,
      );
      return c.json({ evidence }, 201);
    } catch (error) {
      if (error instanceof ClaimFencedError) {
        return c.json(
          {
            error: 'claim_fenced',
            missionId: error.missionId,
            claimId: error.claimId,
          },
          403,
        );
      }
      throw error;
    }
  });

  app.get('/api/v1/runs/:id/evidence', async (c) => {
    const principal = await principalFor(c.req.header('authorization'), [
      'evidence:read',
    ]);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const runId = parseId(c.req.param('id'));
    if (!runId) return c.json({ error: 'invalid_id' }, 400);
    return c.json({ evidence: await store.listEvidence(runId) });
  });

  app.all('/mcp', async (c) => {
    const principal = await resolvePrincipal(
      c.req.header('authorization'),
      store,
      authOptions,
    );
    if (!principal || !hasServiceScope(principal)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const handler = createMcpHandler(
      () => buildMcpServer(store, principal),
      { responseMode: 'json' },
    );
    return handler.fetch(c.req.raw);
  });

  return app;
}
