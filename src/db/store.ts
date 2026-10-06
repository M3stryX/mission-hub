import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  generateClientToken,
  hashToken,
  tokenPrefix,
  type Scope,
} from '../auth/config.js';

export interface MissionRow extends QueryResultRow {
  id: number;
  title: string;
  body: string | null;
  status: string;
  priority: number;
  due_at: string | null;
  source: string | null;
  tags: string | null;
  recurrence: string | null;
  parent_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface RunRow extends QueryResultRow {
  id: number;
  mission_id: number;
  session_id: number;
  client_id: string;
  runtime: string;
  agent: string;
  external_run_id: string;
  correlation_id: string | null;
  provider: string | null;
  model: string | null;
  purpose: string | null;
  status: string;
  review_state: string;
  metadata_json: Record<string, unknown> | null;
  started_at: Date;
  finished_at: Date | null;
}

export interface EventRow extends QueryResultRow {
  id: number;
  run_id: number;
  actor: string;
  client_id: string | null;
  kind: string;
  status_from: string | null;
  status_to: string | null;
  payload_json: Record<string, unknown> | null;
  created_at: Date;
}

export interface SummaryRow extends QueryResultRow {
  id: number;
  run_id: number;
  type: string;
  content: string;
  metadata_json: Record<string, unknown> | null;
  actor: string;
  client_id: string | null;
  created_at: Date;
}

export interface EvidenceRow extends QueryResultRow {
  id: number;
  run_id: number;
  kind: string;
  label: string;
  uri: string;
  metadata_json: Record<string, unknown> | null;
  created_at: Date;
}

export interface ChecklistItemRow extends QueryResultRow {
  id: number;
  mission_id: number;
  item: string;
  done: boolean;
  position: number;
  created_at: Date;
}

export interface MissionSourceRow extends QueryResultRow {
  id: number;
  mission_id: number;
  label: string;
  path: string;
  kind: string;
  created_at: Date;
}

export interface MissionEventRow extends QueryResultRow {
  id: number;
  mission_id: number;
  actor: string;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

export class DuplicateSourcePathError extends Error {
  readonly missionId: number;
  readonly path: string;

  constructor(missionId: number, path: string) {
    super('duplicate_source_path');
    this.name = 'DuplicateSourcePathError';
    this.missionId = missionId;
    this.path = path;
  }
}

export class VerifyFixtureRejectedError extends Error {
  readonly missionId: number;

  constructor(missionId: number) {
    super('verify_fixture_rejected');
    this.name = 'VerifyFixtureRejectedError';
    this.missionId = missionId;
  }
}

export class ClaimConflictError extends Error {
  readonly missionId: number;
  readonly claimId: number;

  constructor(missionId: number, claimId: number) {
    super('claim_conflict');
    this.name = 'ClaimConflictError';
    this.missionId = missionId;
    this.claimId = claimId;
  }
}

export class ClaimNotOwnedError extends Error {
  readonly claimId: number;

  constructor(claimId: number) {
    super('claim_not_owned');
    this.name = 'ClaimNotOwnedError';
    this.claimId = claimId;
  }
}

export class ClaimExpiredError extends Error {
  readonly claimId: number;

  constructor(claimId: number) {
    super('claim_expired');
    this.name = 'ClaimExpiredError';
    this.claimId = claimId;
  }
}

export class ClaimAlreadyReleasedError extends Error {
  readonly claimId: number;

  constructor(claimId: number) {
    super('claim_already_released');
    this.name = 'ClaimAlreadyReleasedError';
    this.claimId = claimId;
  }
}

export class ClaimFencedError extends Error {
  readonly missionId: number;
  readonly claimId: number;

  constructor(missionId: number, claimId: number) {
    super('claim_fenced');
    this.name = 'ClaimFencedError';
    this.missionId = missionId;
    this.claimId = claimId;
  }
}

export class ClaimReleaseIncompleteError extends Error {
  readonly claimId: number;
  readonly runId: number;
  readonly missing: string[];

  constructor(claimId: number, runId: number, missing: string[]) {
    super('claim_release_incomplete');
    this.name = 'ClaimReleaseIncompleteError';
    this.claimId = claimId;
    this.runId = runId;
    this.missing = missing;
  }
}

export class ClaimReleaseInconsistentError extends Error {
  readonly claimId: number;
  readonly runId: number;
  readonly runStatus: string;
  readonly reason: string;

  constructor(
    claimId: number,
    runId: number,
    runStatus: string,
    reason: string,
  ) {
    super('claim_release_inconsistent');
    this.name = 'ClaimReleaseInconsistentError';
    this.claimId = claimId;
    this.runId = runId;
    this.runStatus = runStatus;
    this.reason = reason;
  }
}

export const DEFAULT_CLAIM_LEASE_SECONDS = 300;
export const MAX_CLAIM_LEASE_SECONDS = 3600;
export const CLAIM_RELEASE_REASONS = [
  'completed',
  'failed',
  'abandoned',
  'expired',
] as const;
export type ClaimReleaseReason = (typeof CLAIM_RELEASE_REASONS)[number];

export const CLAIM_EXPIRY_CAUSES = [
  'SESSION_CLOSED',
  'SESSION_ABORTED',
  'SESSION_STALE',
  'RUNTIME_UNREACHABLE',
  'RUN_ALREADY_TERMINAL',
  'UNKNOWN',
] as const;
export type ClaimExpiryCause = (typeof CLAIM_EXPIRY_CAUSES)[number];

export interface ClaimExpiryDiagnosis {
  cause: ClaimExpiryCause;
  known: boolean;
  claimId: number;
  runId: number;
  sessionId: number;
  observed: {
    runStatus: string;
    sessionStatus: string;
    sessionLastSeenAt: string;
    claimExpiresAt: string;
    claimClientId: string;
    runtime: string;
    agent: string;
    latestExecutionEventKind: string | null;
  };
  runStatusAfter: string;
}

export interface ClaimRow extends QueryResultRow {
  id: number;
  mission_id: number;
  run_id: number;
  client_id: string;
  runtime: string;
  agent: string;
  lease_seconds: number;
  claimed_at: Date;
  expires_at: Date;
  renewed_at: Date | null;
  released_at: Date | null;
  release_reason: string | null;
}

export interface SessionRow extends QueryResultRow {
  id: number;
  client_id: string;
  runtime: string;
  agent: string;
  external_session_id: string;
  correlation_id: string | null;
  status: string;
  started_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
}

export interface ClaimMissionInput {
  missionId: number;
  runtime: string;
  agent: string;
  externalSessionId: string;
  externalRunId: string;
  leaseSeconds?: number;
  correlationId?: string | null;
  provider?: string | null;
  model?: string | null;
  purpose?: string | null;
}

export interface ClaimResult {
  claim: ClaimRow;
  run: RunRow;
  expiredPreviousClaimId: number | null;
  expiryDiagnosis: ClaimExpiryDiagnosis | null;
}

export const VERIFY_FIXTURE_TAG = 'mh-runtime-verify';
export const VERIFY_FIXTURE_TITLE_PREFIX = '[VERIFY]';

export function isVerifyFixtureMission(mission: {
  title: string;
  tags: string | null;
}): boolean {
  const tags = (mission.tags ?? '')
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const hasTag = tags.includes(VERIFY_FIXTURE_TAG);
  const hasTitle = mission.title.startsWith(VERIFY_FIXTURE_TITLE_PREFIX);
  return hasTag && hasTitle;
}

export interface ApiClientRow extends QueryResultRow {
  id: number;
  client_id: string;
  token_prefix: string;
  token_hash: string;
  scopes: string[];
  created_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

export interface ApiClientPublic {
  id: number;
  clientId: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface CreatedApiClient {
  client: ApiClientPublic;
  token: string;
}

export interface CreateMissionInput {
  title: string;
  body?: string | null;
  status?: string;
  priority?: number;
  dueAt?: string | null;
  source?: string | null;
  tags?: string | null;
  recurrence?: string | null;
  parentId?: number | null;
}

export interface UpdateMissionInput {
  title?: string;
  body?: string | null;
  status?: string;
  priority?: number;
  dueAt?: string | null;
  source?: string | null;
  tags?: string | null;
  recurrence?: string | null;
  parentId?: number | null;
}

export interface CreateRunInput {
  missionId: number;
  runtime: string;
  agent: string;
  externalSessionId: string;
  externalRunId: string;
  correlationId?: string | null;
  provider?: string | null;
  model?: string | null;
  purpose?: string | null;
  metadata?: Record<string, unknown> | null;
}

export class MissionHubStore {
  constructor(private readonly pool: Pool) {}

  async ready(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  async listMissions(query?: string): Promise<MissionRow[]> {
    if (query?.trim()) {
      const result = await this.pool.query<MissionRow>(
        `SELECT id, title, body, status, priority, due_at, source, tags, recurrence,
                parent_id, created_at, updated_at
         FROM missions
         WHERE search_vector @@ plainto_tsquery('simple', $1)
         ORDER BY priority ASC, updated_at DESC`,
        [query],
      );
      return result.rows;
    }

    const result = await this.pool.query<MissionRow>(
      `SELECT id, title, body, status, priority, due_at, source, tags, recurrence,
              parent_id, created_at, updated_at
       FROM missions
       ORDER BY priority ASC, updated_at DESC`,
    );
    return result.rows;
  }

  async getMission(id: number): Promise<MissionRow | null> {
    const result = await this.pool.query<MissionRow>(
      `SELECT id, title, body, status, priority, due_at, source, tags, recurrence,
              parent_id, created_at, updated_at
       FROM missions WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async createMission(
    input: CreateMissionInput,
    actor: string,
  ): Promise<MissionRow> {
    return this.transaction(async (client) => {
      const result = await client.query<MissionRow>(
        `INSERT INTO missions(
          title, body, status, priority, due_at, source, tags, recurrence, parent_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING id, title, body, status, priority, due_at, source, tags,
                  recurrence, parent_id, created_at, updated_at`,
        [
          input.title,
          input.body ?? null,
          input.status ?? 'backlog',
          input.priority ?? 3,
          input.dueAt ?? null,
          input.source ?? null,
          input.tags ?? null,
          input.recurrence ?? null,
          input.parentId ?? null,
        ],
      );

      const mission = result.rows[0];
      await client.query(
        `INSERT INTO mission_events(mission_id, actor, kind, payload)
         VALUES ($1, $2, 'create', $3::jsonb)`,
        [mission.id, actor, JSON.stringify({ status: mission.status })],
      );
      return mission;
    });
  }

  async updateMission(
    id: number,
    input: UpdateMissionInput,
    actor: string,
  ): Promise<MissionRow | null> {
    return this.transaction(async (client) => {
      const current = await client.query<MissionRow>(
        'SELECT * FROM missions WHERE id = $1 FOR UPDATE',
        [id],
      );
      const before = current.rows[0];
      if (!before) {
        return null;
      }

      const result = await client.query<MissionRow>(
        `UPDATE missions
         SET title = COALESCE($2, title),
             body = CASE WHEN $3::boolean THEN $4 ELSE body END,
             status = COALESCE($5::mission_status, status),
             priority = COALESCE($6, priority),
             due_at = CASE WHEN $7::boolean THEN $8 ELSE due_at END,
             source = CASE WHEN $9::boolean THEN $10 ELSE source END,
             tags = CASE WHEN $11::boolean THEN $12 ELSE tags END,
             recurrence = CASE WHEN $13::boolean THEN $14 ELSE recurrence END,
             parent_id = CASE WHEN $15::boolean THEN $16 ELSE parent_id END,
             updated_at = now()
         WHERE id = $1
         RETURNING id, title, body, status, priority, due_at, source, tags,
                   recurrence, parent_id, created_at, updated_at`,
        [
          id,
          input.title ?? null,
          Object.hasOwn(input, 'body'),
          input.body ?? null,
          input.status ?? null,
          input.priority ?? null,
          Object.hasOwn(input, 'dueAt'),
          input.dueAt ?? null,
          Object.hasOwn(input, 'source'),
          input.source ?? null,
          Object.hasOwn(input, 'tags'),
          input.tags ?? null,
          Object.hasOwn(input, 'recurrence'),
          input.recurrence ?? null,
          Object.hasOwn(input, 'parentId'),
          input.parentId ?? null,
        ],
      );

      const mission = result.rows[0];
      await client.query(
        `INSERT INTO mission_events(mission_id, actor, kind, payload)
         VALUES ($1, $2, 'update', $3::jsonb)`,
        [id, actor, JSON.stringify({ before: before.status, after: mission.status })],
      );
      return mission;
    });
  }

  async listRunsForMission(
    missionId: number,
    purpose?: string,
  ): Promise<RunRow[]> {
    const result = purpose
      ? await this.pool.query<RunRow>(
          `SELECT * FROM execution_runs
           WHERE mission_id = $1 AND purpose = $2::run_purpose
           ORDER BY started_at DESC, id DESC`,
          [missionId, purpose],
        )
      : await this.pool.query<RunRow>(
          'SELECT * FROM execution_runs WHERE mission_id = $1 ORDER BY started_at DESC, id DESC',
          [missionId],
        );
    return result.rows;
  }

  async createRun(
    input: CreateRunInput,
    clientId: string,
  ): Promise<RunRow> {
    return this.transaction(async (client) => {
      const session = await client.query<{ id: number }>(
        `INSERT INTO agent_sessions(
          client_id, runtime, agent, external_session_id, correlation_id
        ) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (client_id, runtime, external_session_id)
        DO UPDATE SET last_seen_at = now(), agent = EXCLUDED.agent,
                      correlation_id = COALESCE(EXCLUDED.correlation_id, agent_sessions.correlation_id)
        RETURNING id`,
        [
          clientId,
          input.runtime,
          input.agent,
          input.externalSessionId,
          input.correlationId ?? null,
        ],
      );

      const result = await client.query<RunRow>(
        `INSERT INTO execution_runs(
          mission_id, session_id, client_id, runtime, agent, external_run_id,
          correlation_id, provider, model, purpose, metadata_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::run_purpose,$11::jsonb)
        RETURNING *`,
        [
          input.missionId,
          session.rows[0].id,
          clientId,
          input.runtime,
          input.agent,
          input.externalRunId,
          input.correlationId ?? null,
          input.provider ?? null,
          input.model ?? null,
          input.purpose ?? null,
          JSON.stringify(input.metadata ?? null),
        ],
      );

      const run = result.rows[0];
      await client.query(
        `INSERT INTO execution_events(run_id, actor, client_id, kind, status_to, payload_json)
         VALUES ($1,$2,$2,'run.created',$3,$4::jsonb)`,
        [
          run.id,
          clientId,
          run.status,
          JSON.stringify({ correlationId: run.correlation_id }),
        ],
      );
      return run;
    });
  }

  async updateRunStatus(
    runId: number,
    status: string,
    reviewState: string | undefined,
    clientId: string,
  ): Promise<RunRow | null> {
    return this.transaction(async (client) => {
      const current = await client.query<RunRow>(
        'SELECT * FROM execution_runs WHERE id = $1 FOR UPDATE',
        [runId],
      );
      const before = current.rows[0];
      if (!before) {
        return null;
      }
      await assertRunMutationAllowed(client, before, clientId);

      const result = await client.query<RunRow>(
        `UPDATE execution_runs
         SET status = $2::run_status,
             review_state = COALESCE($3::review_state, review_state),
             finished_at = CASE
               WHEN $2::run_status IN ('COMPLETED','FAILED') THEN COALESCE(finished_at, now())
               ELSE finished_at
             END
         WHERE id = $1
         RETURNING *`,
        [runId, status, reviewState ?? null],
      );

      const run = result.rows[0];
      await client.query(
        `INSERT INTO execution_events(
          run_id, actor, client_id, kind, status_from, status_to, payload_json
        ) VALUES ($1,$2,$2,'run.status_changed',$3::run_status,$4::run_status,$5::jsonb)`,
        [
          runId,
          clientId,
          before.status,
          run.status,
          JSON.stringify({ reviewState: run.review_state }),
        ],
      );
      return run;
    });
  }

  async listRunEvents(runId: number): Promise<EventRow[]> {
    const result = await this.pool.query<EventRow>(
      'SELECT * FROM execution_events WHERE run_id = $1 ORDER BY created_at, id',
      [runId],
    );
    return result.rows;
  }

  async addSummary(
    runId: number,
    type: string,
    content: string,
    principal: string,
    metadata: Record<string, unknown> | null = null,
  ): Promise<SummaryRow> {
    return this.transaction(async (client) => {
      const current = await client.query<RunRow>(
        'SELECT * FROM execution_runs WHERE id = $1 FOR UPDATE',
        [runId],
      );
      const run = current.rows[0];
      if (!run) {
        throw new Error('run_not_found');
      }
      await assertRunMutationAllowed(client, run, principal);

      const result = await client.query<SummaryRow>(
        `INSERT INTO summaries(run_id, type, content, metadata_json, actor, client_id)
         VALUES ($1,$2::summary_type,$3,$4::jsonb,$5,$5)
         RETURNING *`,
        [runId, type, content, JSON.stringify(metadata), principal],
      );
      const summary = result.rows[0];
      await client.query(
        `INSERT INTO execution_events(run_id, actor, client_id, kind, payload_json)
         VALUES ($1,$2,$2,'run.summary_recorded',$3::jsonb)`,
        [
          runId,
          principal,
          JSON.stringify({ summaryId: summary.id, type: summary.type }),
        ],
      );
      return summary;
    });
  }

  async listSummaries(
    runId: number,
    type?: string,
  ): Promise<SummaryRow[]> {
    const result = type
      ? await this.pool.query<SummaryRow>(
          'SELECT * FROM summaries WHERE run_id = $1 AND type = $2::summary_type ORDER BY created_at, id',
          [runId, type],
        )
      : await this.pool.query<SummaryRow>(
          'SELECT * FROM summaries WHERE run_id = $1 ORDER BY created_at, id',
          [runId],
        );
    return result.rows;
  }

  async listResearchReportsForMission(missionId: number): Promise<Array<SummaryRow & {
    mission_id: number;
    purpose: string | null;
    run_status: string;
    review_state: string;
    canonical: boolean;
  }>> {
    const result = await this.pool.query<SummaryRow & {
      mission_id: number;
      purpose: string | null;
      run_status: string;
      review_state: string;
      canonical: boolean;
    }>(
      `SELECT s.*,
              r.mission_id,
              r.purpose,
              r.status AS run_status,
              r.review_state,
              (row_number() OVER (ORDER BY s.created_at DESC, s.id DESC) = 1) AS canonical
       FROM summaries s
       JOIN execution_runs r ON r.id = s.run_id
       WHERE r.mission_id = $1
         AND r.purpose = 'research'::run_purpose
         AND s.type = 'research_report'::summary_type
       ORDER BY s.created_at DESC, s.id DESC`,
      [missionId],
    );
    return result.rows;
  }

  async getCanonicalResearchReport(missionId: number) {
    const reports = await this.listResearchReportsForMission(missionId);
    return reports[0] ?? null;
  }

  async addEvidence(
    runId: number,
    kind: string,
    label: string,
    uri: string,
    metadata: Record<string, unknown> | null,
    actor: string,
  ): Promise<EvidenceRow> {
    return this.transaction(async (client) => {
      const current = await client.query<RunRow>(
        'SELECT * FROM execution_runs WHERE id = $1 FOR UPDATE',
        [runId],
      );
      const run = current.rows[0];
      if (!run) {
        throw new Error('run_not_found');
      }
      await assertRunMutationAllowed(client, run, actor);

      const result = await client.query<EvidenceRow>(
        `INSERT INTO evidence(run_id, kind, label, uri, metadata_json)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         RETURNING *`,
        [runId, kind, label, uri, JSON.stringify(metadata)],
      );
      const evidence = result.rows[0];
      await client.query(
        `INSERT INTO execution_events(run_id, actor, client_id, kind, payload_json)
         VALUES ($1,$2,$2,'run.evidence_recorded',$3::jsonb)`,
        [
          runId,
          actor,
          JSON.stringify({
            evidenceId: evidence.id,
            kind: evidence.kind,
            uri: evidence.uri,
          }),
        ],
      );
      return evidence;
    });
  }

  async listEvidence(runId: number): Promise<EvidenceRow[]> {
    const result = await this.pool.query<EvidenceRow>(
      'SELECT * FROM evidence WHERE run_id = $1 ORDER BY created_at, id',
      [runId],
    );
    return result.rows;
  }

  async listChecklistItems(missionId: number): Promise<ChecklistItemRow[]> {
    const result = await this.pool.query<ChecklistItemRow>(
      `SELECT * FROM mission_checklist_items
       WHERE mission_id = $1
       ORDER BY position ASC, id ASC`,
      [missionId],
    );
    return result.rows;
  }

  async addChecklistItem(
    missionId: number,
    item: string,
    position: number | undefined,
    actor: string,
  ): Promise<ChecklistItemRow | null> {
    return this.transaction(async (client) => {
      const mission = await client.query(
        'SELECT id FROM missions WHERE id = $1 FOR UPDATE',
        [missionId],
      );
      if (!mission.rows[0]) {
        return null;
      }

      let resolvedPosition = position;
      if (resolvedPosition === undefined) {
        const max = await client.query<{ max: number | null }>(
          `SELECT MAX(position) AS max FROM mission_checklist_items WHERE mission_id = $1`,
          [missionId],
        );
        resolvedPosition = (max.rows[0]?.max ?? -1) + 1;
      }

      const result = await client.query<ChecklistItemRow>(
        `INSERT INTO mission_checklist_items(mission_id, item, done, position)
         VALUES ($1, $2, false, $3)
         RETURNING *`,
        [missionId, item, resolvedPosition],
      );
      const row = result.rows[0];
      await client.query(
        `INSERT INTO mission_events(mission_id, actor, kind, payload)
         VALUES ($1, $2, 'checklist.add', $3::jsonb)`,
        [
          missionId,
          actor,
          JSON.stringify({ itemId: row.id, item: row.item, position: row.position }),
        ],
      );
      return row;
    });
  }

  async updateChecklistItem(
    missionId: number,
    itemId: number,
    input: { item?: string; done?: boolean; position?: number },
    actor: string,
  ): Promise<ChecklistItemRow | null> {
    return this.transaction(async (client) => {
      const current = await client.query<ChecklistItemRow>(
        `SELECT * FROM mission_checklist_items
         WHERE id = $1 AND mission_id = $2
         FOR UPDATE`,
        [itemId, missionId],
      );
      const before = current.rows[0];
      if (!before) {
        return null;
      }

      const result = await client.query<ChecklistItemRow>(
        `UPDATE mission_checklist_items
         SET item = COALESCE($3, item),
             done = COALESCE($4, done),
             position = COALESCE($5, position)
         WHERE id = $1 AND mission_id = $2
         RETURNING *`,
        [
          itemId,
          missionId,
          input.item ?? null,
          input.done ?? null,
          input.position ?? null,
        ],
      );
      const row = result.rows[0];
      await client.query(
        `INSERT INTO mission_events(mission_id, actor, kind, payload)
         VALUES ($1, $2, 'checklist.update', $3::jsonb)`,
        [
          missionId,
          actor,
          JSON.stringify({
            itemId,
            before: { item: before.item, done: before.done, position: before.position },
            after: { item: row.item, done: row.done, position: row.position },
          }),
        ],
      );
      return row;
    });
  }

  async removeChecklistItem(
    missionId: number,
    itemId: number,
    actor: string,
  ): Promise<ChecklistItemRow | null> {
    return this.transaction(async (client) => {
      const result = await client.query<ChecklistItemRow>(
        `DELETE FROM mission_checklist_items
         WHERE id = $1 AND mission_id = $2
         RETURNING *`,
        [itemId, missionId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      await client.query(
        `INSERT INTO mission_events(mission_id, actor, kind, payload)
         VALUES ($1, $2, 'checklist.remove', $3::jsonb)`,
        [missionId, actor, JSON.stringify({ itemId, item: row.item })],
      );
      return row;
    });
  }

  async listSources(missionId: number): Promise<MissionSourceRow[]> {
    const result = await this.pool.query<MissionSourceRow>(
      `SELECT * FROM mission_sources
       WHERE mission_id = $1
       ORDER BY id ASC`,
      [missionId],
    );
    return result.rows;
  }

  async addSource(
    missionId: number,
    input: { label: string; path: string; kind: 'doc' | 'link' },
    actor: string,
  ): Promise<MissionSourceRow | null> {
    return this.transaction(async (client) => {
      const mission = await client.query(
        'SELECT id FROM missions WHERE id = $1 FOR UPDATE',
        [missionId],
      );
      if (!mission.rows[0]) {
        return null;
      }

      try {
        const result = await client.query<MissionSourceRow>(
          `INSERT INTO mission_sources(mission_id, label, path, kind)
           VALUES ($1, $2, $3, $4::source_kind)
           RETURNING *`,
          [missionId, input.label, input.path, input.kind],
        );
        const row = result.rows[0];
        await client.query(
          `INSERT INTO mission_events(mission_id, actor, kind, payload)
           VALUES ($1, $2, 'source.add', $3::jsonb)`,
          [
            missionId,
            actor,
            JSON.stringify({
              sourceId: row.id,
              path: row.path,
              kind: row.kind,
            }),
          ],
        );
        return row;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('mission_sources_mission_path_unique')) {
          throw new DuplicateSourcePathError(missionId, input.path);
        }
        throw error;
      }
    });
  }

  async removeSource(
    missionId: number,
    sourceId: number,
    actor: string,
  ): Promise<MissionSourceRow | null> {
    return this.transaction(async (client) => {
      const result = await client.query<MissionSourceRow>(
        `DELETE FROM mission_sources
         WHERE id = $1 AND mission_id = $2
         RETURNING *`,
        [sourceId, missionId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      await client.query(
        `INSERT INTO mission_events(mission_id, actor, kind, payload)
         VALUES ($1, $2, 'source.remove', $3::jsonb)`,
        [
          missionId,
          actor,
          JSON.stringify({ sourceId, path: row.path, kind: row.kind }),
        ],
      );
      return row;
    });
  }

  async listMissionEvents(missionId: number): Promise<MissionEventRow[]> {
    const result = await this.pool.query<MissionEventRow>(
      `SELECT * FROM mission_events
       WHERE mission_id = $1
       ORDER BY created_at ASC, id ASC`,
      [missionId],
    );
    return result.rows;
  }

  async getActiveClaim(missionId: number): Promise<ClaimRow | null> {
    const result = await this.pool.query<ClaimRow>(
      `SELECT * FROM mission_claims
       WHERE mission_id = $1
         AND released_at IS NULL
         AND expires_at > now()
       ORDER BY id DESC
       LIMIT 1`,
      [missionId],
    );
    return result.rows[0] ?? null;
  }

  async getClaim(claimId: number): Promise<ClaimRow | null> {
    const result = await this.pool.query<ClaimRow>(
      'SELECT * FROM mission_claims WHERE id = $1',
      [claimId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Atomically acquire a claim + execution run for a mission.
   * Expired open claims are released as `expired` then replaced.
   */
  async claimMission(
    input: ClaimMissionInput,
    clientId: string,
  ): Promise<ClaimResult | null> {
    const leaseSeconds = Math.min(
      Math.max(input.leaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS, 1),
      MAX_CLAIM_LEASE_SECONDS,
    );

    return this.transaction(async (client) => {
      const mission = await client.query<MissionRow>(
        'SELECT * FROM missions WHERE id = $1 FOR UPDATE',
        [input.missionId],
      );
      if (!mission.rows[0]) {
        return null;
      }

      const open = await client.query<ClaimRow>(
        `SELECT * FROM mission_claims
         WHERE mission_id = $1 AND released_at IS NULL
         FOR UPDATE`,
        [input.missionId],
      );
      let expiredPreviousClaimId: number | null = null;
      let expiryDiagnosis: ClaimExpiryDiagnosis | null = null;
      const existing = open.rows[0];
      if (existing) {
        if (existing.expires_at.getTime() > Date.now()) {
          throw new ClaimConflictError(input.missionId, existing.id);
        }

        const previousRunResult = await client.query<RunRow>(
          'SELECT * FROM execution_runs WHERE id = $1 FOR UPDATE',
          [existing.run_id],
        );
        const previousRun = previousRunResult.rows[0];
        if (!previousRun) {
          throw new Error('claim_run_missing');
        }
        const previousSessionResult = await client.query<SessionRow>(
          'SELECT * FROM agent_sessions WHERE id = $1 FOR UPDATE',
          [previousRun.session_id],
        );
        const previousSession = previousSessionResult.rows[0];
        if (!previousSession) {
          throw new Error('claim_session_missing');
        }
        const latestEvent = await client.query<{ kind: string }>(
          `SELECT kind FROM execution_events
           WHERE run_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
          [previousRun.id],
        );

        expiryDiagnosis = diagnoseClaimExpiry({
          claim: existing,
          run: previousRun,
          session: previousSession,
          latestExecutionEventKind: latestEvent.rows[0]?.kind ?? null,
        });

        await client.query(
          `INSERT INTO mission_events(mission_id, actor, kind, payload)
           VALUES ($1, $2, 'claim.expiry_diagnosis', $3::jsonb)`,
          [input.missionId, clientId, JSON.stringify(expiryDiagnosis)],
        );
        await client.query(
          `INSERT INTO execution_events(run_id, actor, client_id, kind, payload_json)
           VALUES ($1,$2,$2,'claim.expiry_diagnosis',$3::jsonb)`,
          [previousRun.id, clientId, JSON.stringify(expiryDiagnosis)],
        );

        if (
          previousRun.status !== 'COMPLETED' &&
          previousRun.status !== 'FAILED'
        ) {
          const terminal = await client.query<RunRow>(
            `UPDATE execution_runs
             SET status = 'FAILED'::run_status,
                 finished_at = COALESCE(finished_at, now())
             WHERE id = $1
             RETURNING *`,
            [previousRun.id],
          );
          const nextRun = terminal.rows[0];
          expiryDiagnosis = {
            ...expiryDiagnosis,
            runStatusAfter: nextRun.status,
          };
          await client.query(
            `INSERT INTO execution_events(
              run_id, actor, client_id, kind, status_from, status_to, payload_json
            ) VALUES (
              $1,$2,$2,'run.status_changed',$3::run_status,'FAILED'::run_status,$4::jsonb
            )`,
            [
              previousRun.id,
              clientId,
              previousRun.status,
              JSON.stringify({
                via: 'claim.expiry',
                diagnosis: expiryDiagnosis,
              }),
            ],
          );
        }

        await client.query(
          `UPDATE mission_claims
           SET released_at = now(), release_reason = 'expired'
           WHERE id = $1`,
          [existing.id],
        );
        await client.query(
          `INSERT INTO mission_events(mission_id, actor, kind, payload)
           VALUES ($1, $2, 'claim.expired', $3::jsonb)`,
          [
            input.missionId,
            clientId,
            JSON.stringify({
              claimId: existing.id,
              previousClientId: existing.client_id,
              runId: existing.run_id,
              diagnosis: expiryDiagnosis,
              fenced: true,
            }),
          ],
        );
        await client.query(
          `INSERT INTO execution_events(run_id, actor, client_id, kind, payload_json)
           VALUES ($1,$2,$2,'claim.fenced',$3::jsonb)`,
          [
            previousRun.id,
            clientId,
            JSON.stringify({
              claimId: existing.id,
              previousClientId: existing.client_id,
              diagnosis: expiryDiagnosis,
            }),
          ],
        );
        expiredPreviousClaimId = existing.id;
      }

      const session = await client.query<{ id: number }>(
        `INSERT INTO agent_sessions(
          client_id, runtime, agent, external_session_id, correlation_id
        ) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (client_id, runtime, external_session_id)
        DO UPDATE SET last_seen_at = now(), agent = EXCLUDED.agent,
                      correlation_id = COALESCE(EXCLUDED.correlation_id, agent_sessions.correlation_id)
        RETURNING id`,
        [
          clientId,
          input.runtime,
          input.agent,
          input.externalSessionId,
          input.correlationId ?? null,
        ],
      );

      const runResult = await client.query<RunRow>(
        `INSERT INTO execution_runs(
          mission_id, session_id, client_id, runtime, agent, external_run_id,
          correlation_id, provider, model, purpose, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::run_purpose,'RUNNING'::run_status)
        RETURNING *`,
        [
          input.missionId,
          session.rows[0].id,
          clientId,
          input.runtime,
          input.agent,
          input.externalRunId,
          input.correlationId ?? null,
          input.provider ?? null,
          input.model ?? null,
          input.purpose ?? null,
        ],
      );
      const run = runResult.rows[0];
      await client.query(
        `INSERT INTO execution_events(run_id, actor, client_id, kind, status_to, payload_json)
         VALUES ($1,$2,$2,'run.created',$3,$4::jsonb)`,
        [
          run.id,
          clientId,
          run.status,
          JSON.stringify({ via: 'claim', correlationId: run.correlation_id }),
        ],
      );

      const claimResult = await client.query<ClaimRow>(
        `INSERT INTO mission_claims(
          mission_id, run_id, client_id, runtime, agent, lease_seconds, expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $6::integer))
        RETURNING *`,
        [
          input.missionId,
          run.id,
          clientId,
          input.runtime,
          input.agent,
          leaseSeconds,
        ],
      );
      const claim = claimResult.rows[0];
      await client.query(
        `INSERT INTO mission_events(mission_id, actor, kind, payload)
         VALUES ($1, $2, 'claim.acquired', $3::jsonb)`,
        [
          input.missionId,
          clientId,
          JSON.stringify({
            claimId: claim.id,
            runId: run.id,
            runtime: claim.runtime,
            agent: claim.agent,
            leaseSeconds: claim.lease_seconds,
            expiresAt: claim.expires_at.toISOString(),
            expiredPreviousClaimId,
            expiryDiagnosis,
          }),
        ],
      );
      await client.query(
        `INSERT INTO execution_events(run_id, actor, client_id, kind, payload_json)
         VALUES ($1,$2,$2,'claim.acquired',$3::jsonb)`,
        [
          run.id,
          clientId,
          JSON.stringify({ claimId: claim.id, leaseSeconds }),
        ],
      );

      return { claim, run, expiredPreviousClaimId, expiryDiagnosis };
    });
  }

  async renewClaim(
    claimId: number,
    clientId: string,
    leaseSeconds?: number,
  ): Promise<ClaimRow | null> {
    const nextLease = Math.min(
      Math.max(leaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS, 1),
      MAX_CLAIM_LEASE_SECONDS,
    );

    return this.transaction(async (client) => {
      const current = await client.query<ClaimRow>(
        'SELECT * FROM mission_claims WHERE id = $1 FOR UPDATE',
        [claimId],
      );
      const claim = current.rows[0];
      if (!claim) {
        return null;
      }
      if (claim.released_at) {
        throw new ClaimAlreadyReleasedError(claimId);
      }
      if (claim.client_id !== clientId) {
        throw new ClaimNotOwnedError(claimId);
      }
      if (claim.expires_at.getTime() <= Date.now()) {
        throw new ClaimExpiredError(claimId);
      }

      const updated = await client.query<ClaimRow>(
        `UPDATE mission_claims
         SET lease_seconds = $2,
             renewed_at = now(),
             expires_at = now() + make_interval(secs => $2::integer)
         WHERE id = $1
         RETURNING *`,
        [claimId, nextLease],
      );
      const next = updated.rows[0];
      await client.query(
        `INSERT INTO mission_events(mission_id, actor, kind, payload)
         VALUES ($1, $2, 'claim.renewed', $3::jsonb)`,
        [
          next.mission_id,
          clientId,
          JSON.stringify({
            claimId: next.id,
            leaseSeconds: next.lease_seconds,
            expiresAt: next.expires_at.toISOString(),
          }),
        ],
      );
      await client.query(
        `INSERT INTO execution_events(run_id, actor, client_id, kind, payload_json)
         VALUES ($1,$2,$2,'claim.renewed',$3::jsonb)`,
        [
          next.run_id,
          clientId,
          JSON.stringify({
            claimId: next.id,
            leaseSeconds: next.lease_seconds,
          }),
        ],
      );
      return next;
    });
  }

  async releaseClaim(
    claimId: number,
    clientId: string,
    reason: ClaimReleaseReason,
  ): Promise<ClaimRow | null> {
    if (reason === 'expired') {
      throw new Error('invalid_release_reason');
    }

    return this.transaction(async (client) => {
      const current = await client.query<ClaimRow>(
        'SELECT * FROM mission_claims WHERE id = $1 FOR UPDATE',
        [claimId],
      );
      const claim = current.rows[0];
      if (!claim) {
        return null;
      }
      if (claim.released_at) {
        throw new ClaimAlreadyReleasedError(claimId);
      }
      if (claim.client_id !== clientId) {
        throw new ClaimNotOwnedError(claimId);
      }

      const runResult = await client.query<RunRow>(
        'SELECT * FROM execution_runs WHERE id = $1 FOR UPDATE',
        [claim.run_id],
      );
      const run = runResult.rows[0];
      if (!run) {
        throw new Error('claim_run_missing');
      }

      if (reason === 'completed') {
        const summaryCount = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM summaries WHERE run_id = $1',
          [run.id],
        );
        const evidenceCount = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM evidence WHERE run_id = $1',
          [run.id],
        );
        const missing: string[] = [];
        if (Number(summaryCount.rows[0].count) < 1) {
          missing.push('summary');
        }
        if (Number(evidenceCount.rows[0].count) < 1) {
          missing.push('evidence');
        }
        if (missing.length > 0) {
          throw new ClaimReleaseIncompleteError(claimId, run.id, missing);
        }
        if (run.status === 'FAILED') {
          throw new ClaimReleaseInconsistentError(
            claimId,
            run.id,
            run.status,
            reason,
          );
        }
        if (run.status !== 'COMPLETED') {
          await client.query(
            `UPDATE execution_runs
             SET status = 'COMPLETED'::run_status,
                 finished_at = COALESCE(finished_at, now())
             WHERE id = $1`,
            [run.id],
          );
          await client.query(
            `INSERT INTO execution_events(
              run_id, actor, client_id, kind, status_from, status_to, payload_json
            ) VALUES (
              $1,$2,$2,'run.status_changed',$3::run_status,'COMPLETED'::run_status,$4::jsonb
            )`,
            [
              run.id,
              clientId,
              run.status,
              JSON.stringify({ via: 'claim.release', reason }),
            ],
          );
        }
      } else {
        if (run.status === 'COMPLETED') {
          throw new ClaimReleaseInconsistentError(
            claimId,
            run.id,
            run.status,
            reason,
          );
        }
        if (run.status !== 'FAILED') {
          await client.query(
            `UPDATE execution_runs
             SET status = 'FAILED'::run_status,
                 finished_at = COALESCE(finished_at, now())
             WHERE id = $1`,
            [run.id],
          );
          await client.query(
            `INSERT INTO execution_events(
              run_id, actor, client_id, kind, status_from, status_to, payload_json
            ) VALUES (
              $1,$2,$2,'run.status_changed',$3::run_status,'FAILED'::run_status,$4::jsonb
            )`,
            [
              run.id,
              clientId,
              run.status,
              JSON.stringify({ via: 'claim.release', reason }),
            ],
          );
        }
      }

      const updated = await client.query<ClaimRow>(
        `UPDATE mission_claims
         SET released_at = now(), release_reason = $2::claim_release_reason
         WHERE id = $1
         RETURNING *`,
        [claimId, reason],
      );
      const next = updated.rows[0];
      await client.query(
        `INSERT INTO mission_events(mission_id, actor, kind, payload)
         VALUES ($1, $2, 'claim.released', $3::jsonb)`,
        [
          next.mission_id,
          clientId,
          JSON.stringify({
            claimId: next.id,
            runId: next.run_id,
            reason,
          }),
        ],
      );
      await client.query(
        `INSERT INTO execution_events(run_id, actor, client_id, kind, payload_json)
         VALUES ($1,$2,$2,'claim.released',$3::jsonb)`,
        [next.run_id, clientId, JSON.stringify({ claimId: next.id, reason })],
      );
      return next;
    });
  }

  /**
   * Hard-delete a verify fixture mission. Caller must enforce verify:admin,
   * staging host/env, and marker checks before invoking.
   */
  async deleteVerifyFixture(missionId: number): Promise<MissionRow | null> {
    return this.transaction(async (client) => {
      const current = await client.query<MissionRow>(
        'SELECT * FROM missions WHERE id = $1 FOR UPDATE',
        [missionId],
      );
      const mission = current.rows[0];
      if (!mission) {
        return null;
      }
      if (!isVerifyFixtureMission(mission)) {
        throw new VerifyFixtureRejectedError(missionId);
      }

      // execution_runs.mission_id has no ON DELETE CASCADE (by design for
      // normal missions). Verify fixtures must remove runs first so
      // events/summaries/evidence cascade, then drop orphan sessions.
      const sessionIds = await client.query<{ session_id: number }>(
        'SELECT DISTINCT session_id FROM execution_runs WHERE mission_id = $1',
        [missionId],
      );
      await client.query('DELETE FROM execution_runs WHERE mission_id = $1', [
        missionId,
      ]);
      for (const row of sessionIds.rows) {
        await client.query(
          `DELETE FROM agent_sessions AS s
           WHERE s.id = $1
             AND NOT EXISTS (
               SELECT 1 FROM execution_runs AS r WHERE r.session_id = s.id
             )`,
          [row.session_id],
        );
      }

      await client.query('DELETE FROM missions WHERE id = $1', [missionId]);
      return mission;
    });
  }

  async findActiveClientByTokenHash(
    tokenHash: string,
  ): Promise<ApiClientRow | null> {
    const result = await this.pool.query<ApiClientRow>(
      `SELECT * FROM api_clients
       WHERE token_hash = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  }

  async touchClientLastUsed(id: number): Promise<void> {
    await this.pool.query(
      'UPDATE api_clients SET last_used_at = now() WHERE id = $1',
      [id],
    );
  }

  async listClients(): Promise<ApiClientPublic[]> {
    const result = await this.pool.query<ApiClientRow>(
      'SELECT * FROM api_clients ORDER BY client_id',
    );
    return result.rows.map(toPublicClient);
  }

  async createClient(
    clientId: string,
    scopes: readonly Scope[],
  ): Promise<CreatedApiClient> {
    const token = generateClientToken();
    const result = await this.pool.query<ApiClientRow>(
      `INSERT INTO api_clients(client_id, token_prefix, token_hash, scopes)
       VALUES ($1, $2, $3, $4::text[])
       RETURNING *`,
      [clientId, tokenPrefix(token), hashToken(token), [...scopes]],
    );
    return {
      client: toPublicClient(result.rows[0]),
      token,
    };
  }

  async upsertClientFromPlaintext(
    clientId: string,
    token: string,
    scopes: readonly Scope[],
  ): Promise<ApiClientPublic> {
    const result = await this.pool.query<ApiClientRow>(
      `INSERT INTO api_clients(client_id, token_prefix, token_hash, scopes, revoked_at)
       VALUES ($1, $2, $3, $4::text[], NULL)
       ON CONFLICT (client_id) DO UPDATE SET
         token_prefix = EXCLUDED.token_prefix,
         token_hash = EXCLUDED.token_hash,
         scopes = EXCLUDED.scopes,
         revoked_at = NULL
       RETURNING *`,
      [clientId, tokenPrefix(token), hashToken(token), [...scopes]],
    );
    return toPublicClient(result.rows[0]);
  }

  async revokeClient(clientId: string): Promise<ApiClientPublic | null> {
    const result = await this.pool.query<ApiClientRow>(
      `UPDATE api_clients
       SET revoked_at = now()
       WHERE client_id = $1 AND revoked_at IS NULL
       RETURNING *`,
      [clientId],
    );
    return result.rows[0] ? toPublicClient(result.rows[0]) : null;
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function toPublicClient(row: ApiClientRow): ApiClientPublic {
  return {
    id: row.id,
    clientId: row.client_id,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

export function diagnoseClaimExpiry(input: {
  claim: ClaimRow;
  run: RunRow;
  session: SessionRow;
  latestExecutionEventKind: string | null;
}): ClaimExpiryDiagnosis {
  const observed = {
    runStatus: input.run.status,
    sessionStatus: input.session.status,
    sessionLastSeenAt: input.session.last_seen_at.toISOString(),
    claimExpiresAt: input.claim.expires_at.toISOString(),
    claimClientId: input.claim.client_id,
    runtime: input.claim.runtime,
    agent: input.claim.agent,
    latestExecutionEventKind: input.latestExecutionEventKind,
  };

  let cause: ClaimExpiryCause = 'UNKNOWN';
  if (isTerminalRunStatus(input.run.status)) {
    cause = 'RUN_ALREADY_TERMINAL';
  } else if (input.session.status === 'CLOSED') {
    cause = 'SESSION_CLOSED';
  } else if (input.session.status === 'ABORTED') {
    cause = 'SESSION_ABORTED';
  } else if (
    input.session.status === 'OPEN' &&
    input.session.last_seen_at.getTime() < input.claim.expires_at.getTime()
  ) {
    // Heartbeat did not reach the lease end — stale owner session.
    cause = 'SESSION_STALE';
  }

  return {
    cause,
    known: cause !== 'UNKNOWN',
    claimId: input.claim.id,
    runId: input.run.id,
    sessionId: input.session.id,
    observed,
    runStatusAfter: isTerminalRunStatus(input.run.status)
      ? input.run.status
      : 'FAILED',
  };
}

async function assertRunMutationAllowed(
  client: PoolClient,
  run: RunRow,
  clientId: string,
): Promise<void> {
  const active = await client.query<ClaimRow>(
    `SELECT * FROM mission_claims
     WHERE mission_id = $1
       AND released_at IS NULL
       AND expires_at > now()
     ORDER BY id DESC
     LIMIT 1
     FOR SHARE`,
    [run.mission_id],
  );
  const activeClaim = active.rows[0];
  if (activeClaim && activeClaim.client_id !== clientId) {
    throw new ClaimFencedError(run.mission_id, activeClaim.id);
  }

  const linked = await client.query<ClaimRow>(
    `SELECT * FROM mission_claims
     WHERE run_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [run.id],
  );
  const linkedClaim = linked.rows[0];
  if (linkedClaim?.released_at && linkedClaim.release_reason === 'expired') {
    throw new ClaimFencedError(run.mission_id, linkedClaim.id);
  }
}
