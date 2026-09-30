import type { Pool, PoolClient, QueryResultRow } from 'pg';

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
    const result = await this.pool.query<SummaryRow>(
      `INSERT INTO summaries(run_id, type, content, actor, client_id)
       VALUES ($1,$2::summary_type,$3,$4,$4)
       RETURNING *`,
      [runId, type, content, principal],
    );
    return result.rows[0];
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
  ): Promise<EvidenceRow> {
    const result = await this.pool.query<EvidenceRow>(
      `INSERT INTO evidence(run_id, kind, label, uri, metadata_json)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       RETURNING *`,
      [runId, kind, label, uri, JSON.stringify(metadata)],
    );
    return result.rows[0];
  }

  async listEvidence(runId: number): Promise<EvidenceRow[]> {
    const result = await this.pool.query<EvidenceRow>(
      'SELECT * FROM evidence WHERE run_id = $1 ORDER BY created_at, id',
      [runId],
    );
    return result.rows;
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
