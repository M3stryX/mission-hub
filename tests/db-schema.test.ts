import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL V1 schema', () => {
  const pool = new Pool({ connectionString: databaseUrl });

  beforeAll(async () => {
    await pool.query('SELECT 1');
    await pool.query(
      'TRUNCATE evidence, summaries, execution_events, mission_claims, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions RESTART IDENTITY CASCADE',
    );
    await pool.query(
      `INSERT INTO missions(
        id, title, body, status, priority, source, tags, created_at, updated_at
      ) VALUES
        (10, 'Parent mission', 'PostgreSQL migration rehearsal parent', 'in_progress', 1, 'fixture', 'migration,test', now(), now()),
        (11, 'Child mission', 'Semantic-free full text search parity check', 'todo', 2, 'fixture', 'migration,test', now(), now())`,
    );
    await pool.query('UPDATE missions SET parent_id = 10 WHERE id = 11');
    await pool.query(
      `INSERT INTO mission_checklist_items(id, mission_id, item, done, position)
       VALUES (20, 11, 'Preserve checklist', false, 0)`,
    );
    await pool.query(
      `INSERT INTO mission_sources(id, mission_id, label, path, kind)
       VALUES (30, 11, 'Spec', 'docs/spec.md', 'doc')`,
    );
    await pool.query(
      `INSERT INTO mission_events(id, mission_id, actor, kind, payload)
       VALUES (40, 11, 'mcp', 'create', '{"status":"todo"}'::jsonb)`,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('contains all V1 durable tables', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`,
    );

    const tables = result.rows.map((row) => row.table_name);
    for (const required of [
      'missions',
      'mission_checklist_items',
      'mission_sources',
      'mission_events',
      'agent_sessions',
      'execution_runs',
      'execution_events',
      'summaries',
      'evidence',
      'api_clients',
      'mission_claims',
      'schema_migrations',
    ]) {
      expect(tables).toContain(required);
    }
  });

  it('stores hashed api clients with unique client_id and token_hash', async () => {
    await pool.query('TRUNCATE api_clients RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO api_clients(client_id, token_prefix, token_hash, scopes)
       VALUES ('fixture-client', 'mh_fixture', $1, ARRAY['missions:read']::text[])`,
      ['a'.repeat(64)],
    );

    await expect(
      pool.query(
        `INSERT INTO api_clients(client_id, token_prefix, token_hash, scopes)
         VALUES ('fixture-client', 'mh_other', $1, ARRAY['missions:write']::text[])`,
        ['b'.repeat(64)],
      ),
    ).rejects.toThrow();

    await expect(
      pool.query(
        `INSERT INTO api_clients(client_id, token_prefix, token_hash, scopes)
         VALUES ('other-client', 'mh_other', $1, ARRAY['missions:write']::text[])`,
        ['a'.repeat(64)],
      ),
    ).rejects.toThrow();
  });

  it('preserves representative legacy mission relationships and records', async () => {
    const mission = await pool.query(
      'SELECT id, parent_id, status, priority FROM missions WHERE id = 11',
    );
    expect(mission.rows[0]).toMatchObject({
      id: 11,
      parent_id: 10,
      status: 'todo',
      priority: 2,
    });

    const checklist = await pool.query(
      'SELECT id, mission_id, item, done, position FROM mission_checklist_items WHERE id = 20',
    );
    expect(checklist.rows[0]).toMatchObject({
      id: 20,
      mission_id: 11,
      item: 'Preserve checklist',
      done: false,
      position: 0,
    });

    expect((await pool.query('SELECT count(*)::int AS count FROM mission_sources')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM mission_events')).rows[0].count).toBe(1);
  });

  it('supports PostgreSQL full-text search over mission title and body', async () => {
    const result = await pool.query(
      `SELECT id
       FROM missions
       WHERE search_vector @@ plainto_tsquery('simple', $1)`,
      ['full text search'],
    );

    expect(result.rows.map((row) => row.id)).toContain(11);
  });

  it('enforces execution trace uniqueness and foreign keys', async () => {
    const session = await pool.query<{ id: number }>(
      `INSERT INTO agent_sessions(
        client_id, runtime, agent, external_session_id, correlation_id
      ) VALUES ('test-client', 'test-runtime', 'test-agent', 'session-1', 'corr-1')
      RETURNING id`,
    );

    const sessionId = session.rows[0].id;

    await pool.query(
      `INSERT INTO execution_runs(
        mission_id, session_id, client_id, runtime, agent, external_run_id,
        correlation_id, status, review_state
      ) VALUES (11, $1, 'test-client', 'test-runtime', 'test-agent', 'run-1',
        'corr-1', 'RUNNING', 'NONE')`,
      [sessionId],
    );

    await expect(
      pool.query(
        `INSERT INTO execution_runs(
          mission_id, session_id, client_id, runtime, agent, external_run_id
        ) VALUES (11, $1, 'test-client', 'test-runtime', 'test-agent', 'run-1')`,
        [sessionId],
      ),
    ).rejects.toThrow();
  });
});
