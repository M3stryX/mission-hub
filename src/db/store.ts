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

  async listRunsForMission(missionId: number): Promise<RunRow[]> {
    const result = await this.pool.query<RunRow>(
      'SELECT * FROM execution_runs WHERE mission_id = $1 ORDER BY started_at DESC',
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
          correlation_id, provider, model, metadata_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
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
  ): Promise<SummaryRow> {
    return this.transaction(async (client) => {
      const result = await client.query<SummaryRow>(
        `INSERT INTO summaries(run_id, type, content, actor, client_id)
         VALUES ($1,$2::summary_type,$3,$4,$4)
         RETURNING *`,
        [runId, type, content, principal],
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

  async listSummaries(runId: number): Promise<SummaryRow[]> {
    const result = await this.pool.query<SummaryRow>(
      'SELECT * FROM summaries WHERE run_id = $1 ORDER BY created_at, id',
      [runId],
    );
    return result.rows;
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
