import { hostHeaderValidation } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  ALL_SERVICE_SCOPES,
  countEffectiveApprovers,
  parseScopes,
  type Principal,
  type Scope,
} from './auth/config.js';
import {
  authenticateAndAuthorize,
  resolvePrincipal,
  type AuthResolverOptions,
  type AuthResult,
} from './auth/resolve.js';
import {
  readCommit,
  readContractVersion,
  readProductVersion,
} from './build-info.js';
import {
  ClaimAlreadyReleasedError,
  ClaimConflictError,
  ClaimExpiredError,
  ClaimFencedError,
  ClaimNotOwnedError,
  ClaimReleaseIncompleteError,
  ClaimReleaseInconsistentError,
  DuplicateSourcePathError,
  formatClaimConflictError,
  MAX_CLAIM_LEASE_SECONDS,
  MISSION_LIST_MAX_LIMIT,
  PlanNotOpenError,
  RunNotOwnedError,
  RunExistsError,
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

const missionStage = z.enum([
  'research',
  'architecture',
  'plan',
  'execution',
  'done',
]);

const createMissionSchema = z.object({
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  status: missionStatus.optional(),
  stage: missionStage.optional(),
  priority: z.number().int().min(1).max(5).optional(),
  dueAt: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  tags: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  parentId: z.number().int().positive().nullable().optional(),
});

const updateMissionSchema = createMissionSchema.partial();

/**
 * Query contract for `GET /api/v1/missions` (contract v3.2).
 *
 * Before v3.2 the route accepted only `q` and serialized every mission with its
 * full body: 2.0 MiB for 368 missions, which is above the 1 MiB MCP SSE ceiling.
 * Every other parameter was silently ignored, so a client had no way to bound
 * the response. Bounds are now explicit and validated instead of ignored.
 */
const missionListQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: missionStatus.optional(),
  stage: missionStage.optional(),
  parentId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(MISSION_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

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
  delegatedClients: z.array(z.string().min(1)).max(10).optional(),
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

/**
 * Built-in Host allowlist used when `MISSION_HUB_ALLOWED_HOSTS` is not set.
 *
 * Loopback only, on purpose: the code carries no deployment topology, so a new
 * or renamed host never requires a code change or a release. A deployed
 * environment declares the names it answers on through
 * `MISSION_HUB_ALLOWED_HOSTS` and refuses to boot without them (see
 * `assertHostAllowlistConfigured`).
 * Matching is exact (one entry per hostname) — no wildcard, no regex.
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
];

function parseId(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export type CreateAppOptions = AuthResolverOptions & {
  allowDestructiveVerify?: boolean;
};

/**
 * Whether a principal may open the MCP surface (`ALL /mcp`).
 *
 * Service clients qualify through their service scopes. The bootstrap admin
 * principal carries only `clients:admin` — never a service scope — so it is
 * admitted explicitly: without this, a token authenticated as admin would be
 * rejected by `/mcp` and the `clients.*` tools would be unreachable, leaving
 * client administration REST-only.
 */
function canUseMcpSurface(principal: Principal): boolean {
  return (
    ALL_SERVICE_SCOPES.some((scope) => principal.scopes.has(scope)) ||
    principal.scopes.has('clients:admin')
  );
}

function requestHost(header: string | undefined): string {
  return (header ?? '').split(':')[0].trim().toLowerCase();
}

/**
 * Resolves the request Host allowlist from the environment.
 *
 * `MISSION_HUB_ALLOWED_HOSTS` is a comma-separated list of hostnames: each entry
 * is trimmed and empty entries are dropped. When the variable is unset, the
 * built-in default applies: loopback only, which suits local development.
 * A defined-but-empty variable therefore yields an empty allowlist.
 */
export function getAllowedHosts(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const configured = env.MISSION_HUB_ALLOWED_HOSTS;
  if (configured === undefined) return [...DEFAULT_ALLOWED_HOSTS];
  return configured
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Loopback names every deployment accepts, on top of its own allowlist.
 *
 * The container probes its own liveness over loopback — the Dockerfile
 * `HEALTHCHECK` calls `http://127.0.0.1:${PORT}/health` — while the request
 * guard below is app-wide (`app.use('*', ...)`). A deployment that listed only
 * its public names would therefore answer its own health probe with `403` and
 * be marked unhealthy, so loopback is a built-in constant rather than a
 * deployment setting: it is never a name a deployment is *reached* by, and it
 * cannot be forgotten the way an environment entry can.
 */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];

/**
 * The effective allowlist the request guard applies: the configured names plus
 * the built-in {@link LOOPBACK_HOSTS}. `getAllowedHosts` stays the *configured*
 * list so the boot assertion cannot be satisfied by the built-in entries.
 */
export function allowedHostsFor(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [...new Set([...getAllowedHosts(env), ...LOOPBACK_HOSTS])];
}

/**
 * Exact (non wildcard) Host allowlist check. The incoming header is normalized
 * the same way as the request middleware: port stripped, trimmed, lowercased.
 */
export function isHostAllowed(
  host: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const normalized = requestHost(host);
  if (normalized.length === 0) return false;
  return allowedHostsFor(env).includes(normalized);
}

/**
 * Deployment environment, from `MISSION_HUB_ENV` — the conventional `*_ENV`
 * name (`NODE_ENV`, `RAILS_ENV`, `APP_ENV`).
 *
 * Unset or blank means `development`. An unrecognized value — a misspelled
 * `prod`, a stray `production-eu` — is a configuration error and throws: the
 * whole point of this variable is to name the deployment, so silently
 * degrading it to `development` would hide exactly the mistake it exists to
 * catch.
 *
 * This is a label and a boot policy, never a capability. It decides whether
 * the Host allowlist is mandatory at boot; it gates no route (the
 * destructive-verify switch is a separate, explicit, orthogonal flag).
 */
export type MissionHubEnv = 'development' | 'staging' | 'production';

export const DEPLOYMENT_ENVS: readonly MissionHubEnv[] = [
  'development',
  'staging',
  'production',
];

export function getEnv(
  env: Record<string, string | undefined> = process.env,
): MissionHubEnv {
  const value = (env.MISSION_HUB_ENV ?? '').trim().toLowerCase();
  if (value.length === 0) return 'development';
  if ((DEPLOYMENT_ENVS as readonly string[]).includes(value)) {
    return value as MissionHubEnv;
  }
  throw new Error(
    `MISSION_HUB_ENV="${env.MISSION_HUB_ENV}" is not a valid environment. ` +
      `Expected one of ${DEPLOYMENT_ENVS.join(', ')}, or unset for development. ` +
      'Refusing to start rather than guess which environment this is.',
  );
}

/**
 * A deployed environment must declare the Host names it answers on.
 *
 * With the loopback-only default, an unset or empty `MISSION_HUB_ALLOWED_HOSTS`
 * would make the deployment boot normally and then refuse every real request
 * with `403` — an outage disguised as a client error. Failing at boot instead
 * makes the misconfiguration loud and immediate.
 */
export function assertHostAllowlistConfigured(
  env: Record<string, string | undefined> = process.env,
): void {
  const deploymentEnv = getEnv(env);
  if (deploymentEnv === 'development') return;

  if (env.MISSION_HUB_ALLOWED_HOSTS === undefined) {
    throw new Error(
      `MISSION_HUB_ALLOWED_HOSTS must be set when MISSION_HUB_ENV=${deploymentEnv}: ` +
        'the built-in default is loopback only, so the deployment would refuse ' +
        'every request with 403. Set it to the host names this deployment is ' +
        'served on (comma-separated).',
    );
  }

  const hosts = getAllowedHosts(env);
  if (hosts.length === 0) {
    throw new Error(
      `MISSION_HUB_ALLOWED_HOSTS resolves to an empty allowlist ` +
        `(MISSION_HUB_ENV=${deploymentEnv}): every request would be refused ` +
        'with 403. List at least one host name.',
    );
  }
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
  // Host policy is a transport decision, so the refusal body follows the
  // protocol of the route being called: `/mcp` keeps the MCP transport's
  // JSON-RPC envelope, every REST route answers a REST body. Dressing a REST
  // refusal in a JSON-RPC envelope hands a REST client an error shape its own
  // protocol never produces (contract v3.2).
  app.use('*', async (c, next) => {
    if (c.req.path === '/mcp') return next();
    if (isHostAllowed(c.req.header('host'))) return next();
    return c.json(
      { error: 'invalid_host', host: requestHost(c.req.header('host')) },
      403,
    );
  });
  app.use('/mcp', hostHeaderValidation(allowedHostsFor()));

  /**
   * Authenticate + authorize, keeping *why* a request was refused: `401` for an
   * unknown credential, `400` for an unparsable `Authorization` header, and
   * `403 insufficient_scope` (listing the missing scopes) for a valid but
   * under-scoped one. Collapsing those into a single `401` tells an integrator
   * holding a valid token to rotate a secret that is not the problem.
   */
  async function principalOr(
    authorization: string | undefined,
    scopes: readonly Scope[],
  ): Promise<AuthResult> {
    return authenticateAndAuthorize(authorization, store, authOptions, scopes);
  }

  // Liveness + build identity: which version, contract revision and commit is
  // actually answering. Read-only, unauthenticated, and deliberately free of
  // store access so it answers even when the database is unhealthy.
  // `approvers` is a count, never the ids: a deployment whose allowlist is empty has a
  // dead plan-approval route, and a caller must be able to tell that apart from a
  // client simply lacking the scope. Both used to answer the same bare 403.
  const approverCount = countEffectiveApprovers(options.approverClients, options.envCredentials ?? []);
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      version: readProductVersion(),
      contract: readContractVersion(),
      commit: readCommit(),
      env: getEnv(),
      approvers: approverCount,
    }),
  );

  app.get('/ready', async (c) => {
    try {
      await store.ready();
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ status: 'not_ready' }, 503);
    }
  });

  app.get('/api/v1/admin/clients', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'clients:admin',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    return c.json({ clients: await store.listClients() });
  });

  app.post('/api/v1/admin/clients', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'clients:admin',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
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
    const auth = await principalOr(c.req.header('authorization'), [
      'clients:admin',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const client = await store.revokeClient(c.req.param('clientId'));
    return client ? c.json({ client }) : c.json({ error: 'not_found' }, 404);
  });

  app.delete('/api/v1/admin/verify-fixtures/:missionId', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'verify:admin',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }

    // The explicit switch, plus the `verify:admin` scope checked above, is the
    // whole gate. The deployment environment deliberately does not enter this
    // decision: a name is a label, not a capability. This switch must never be
    // true outside staging (see SECURITY.md).
    if (!allowDestructiveVerify) {
      return c.json({ error: 'destructive_verify_forbidden' }, 403);
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
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const parsedQuery = missionListQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // REST spells the text filter `q`; the store and MCP spell it `query`.
    const { q, ...bounds } = parsedQuery.data;
    return c.json(await store.listMissions({ query: q, ...bounds }));
  });

  app.get('/api/v1/missions/:id', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const id = parseId(c.req.param('id'));
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    const mission = await store.getMission(id);
    return mission ? c.json({ mission }) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/api/v1/missions', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
    const parsed = createMissionSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const mission = await store.createMission(parsed.data, principal.clientId);
    return c.json({ mission }, 201);
  });

  app.patch('/api/v1/missions/:id', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    if (!(await store.getMission(missionId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ items: await store.listChecklistItems(missionId) });
  });

  app.post('/api/v1/missions/:id/checklist', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    if (!(await store.getMission(missionId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ sources: await store.listSources(missionId) });
  });

  app.post('/api/v1/missions/:id/sources', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    if (!(await store.getMission(missionId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ events: await store.listMissionEvents(missionId) });
  });

  app.get('/api/v1/missions/:id/claim', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'missions:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    if (!(await store.getMission(missionId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ claim: await store.getActiveClaim(missionId) });
  });

  app.post('/api/v1/missions/:id/claim', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
            message: formatClaimConflictError(error),
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
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
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
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:read',
      'summaries:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    return c.json({
      reports: await store.listResearchReportsForMission(missionId),
    });
  });

  app.get('/api/v1/missions/:id/research-report', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:read',
      'summaries:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const missionId = parseId(c.req.param('id'));
    if (!missionId) return c.json({ error: 'invalid_id' }, 400);
    return c.json({
      report: await store.getCanonicalResearchReport(missionId),
    });
  });

  app.get('/api/v1/missions/:id/jev-evaluations', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:read',
      'summaries:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
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
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:read',
      'summaries:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    return c.json({ evaluations: await store.listJevEvaluations() });
  });

  app.post('/api/v1/missions/:id/plan-approval', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'approvals:human',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
        return c.json({ error: 'plan_not_open', missionId }, 409);
      }
      if (error instanceof SelfApprovalError) {
        return c.json({ error: 'self_approval', missionId }, 409);
      }
      throw error;
    }
  });

  app.post('/api/v1/runs', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
    const parsed = createRunSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const run = await store.createRun(parsed.data, principal.clientId);
      return c.json({ run }, 201);
    } catch (error) {
      if (error instanceof RunExistsError) {
        return c.json(
          {
            error: 'run_exists',
            externalRunId: error.externalRunId,
            runId: error.runId,
          },
          409,
        );
      }
      throw error;
    }
  });

  app.patch('/api/v1/runs/:id/status', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
      if (error instanceof RunNotOwnedError) {
        return c.json(
          {
            error: 'run_not_owned',
            runId: error.runId,
            ownerClientId: error.ownerClientId,
          },
          403,
        );
      }
      throw error;
    }
  });

  app.get('/api/v1/runs/:id/events', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'runs:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const runId = parseId(c.req.param('id'));
    if (!runId) return c.json({ error: 'invalid_id' }, 400);
    return c.json({ events: await store.listRunEvents(runId) });
  });

  app.post('/api/v1/runs/:id/summaries', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'summaries:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;

    // Guard: plan_approval summaries require the approvals:human scope, mirroring
    // the dedicated plan-approval endpoint. Scope-only gate: the generic path does
    // NOT enforce plan_not_open or self_approval.
    const body = await c.req.json();
    const parsed = summarySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    if (
      parsed.data.type === 'plan_approval' &&
      !principal.scopes.has('approvals:human')
    ) {
      return c.json(
        { error: 'insufficient_scope', required: ['approvals:human'] },
        403,
      );
    }

    const runId = parseId(c.req.param('id'));
    if (!runId) return c.json({ error: 'invalid_id' }, 400);
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
      if (error instanceof RunNotOwnedError) {
        return c.json(
          {
            error: 'run_not_owned',
            runId: error.runId,
            ownerClientId: error.ownerClientId,
          },
          403,
        );
      }
      throw error;
    }
  });

  app.get('/api/v1/runs/:id/summaries', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'summaries:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
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
    const auth = await principalOr(c.req.header('authorization'), [
      'evidence:write',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
    const principal = auth.principal;
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
      if (error instanceof RunNotOwnedError) {
        return c.json(
          {
            error: 'run_not_owned',
            runId: error.runId,
            ownerClientId: error.ownerClientId,
          },
          403,
        );
      }
      throw error;
    }
  });

  app.get('/api/v1/runs/:id/evidence', async (c) => {
    const auth = await principalOr(c.req.header('authorization'), [
      'evidence:read',
    ]);
    if (!auth.ok) {
      return c.json(auth.failure.body, auth.failure.status);
    }
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
    if (!principal || !canUseMcpSurface(principal)) {
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
