import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import {
  MISSION_BODY_EXCERPT_CHARS,
  MISSION_LIST_DEFAULT_LIMIT,
  MISSION_LIST_MAX_LIMIT,
  MissionHubStore,
} from '../src/db/store.js';

const databaseUrl = process.env.DATABASE_URL;

/**
 * The listing used to serialize every mission with its full body: 2 003 083
 * bytes for 368 missions, above the 1 MiB MCP server-sent-event ceiling, so an
 * unfiltered `missions.list` failed outright. These tests pin the bounds, not
 * the implementation: projection, pagination and the payload ceiling.
 */
const SEEDED_BODY = 'body '.repeat(1000); // ~5 000 chars, the production mean is ~4 945
const SEEDED_MISSIONS = 400;
const PAYLOAD_CEILING_BYTES = 512 * 1024;
const SSE_CEILING_BYTES = 1_048_576;

describe.skipIf(!databaseUrl)('mission list bounds', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const app = createApp(new MissionHubStore(pool), {
    envCredentials: [
      {
        clientId: 'list-bounds-test',
        token: 'list-bounds-token',
        scopes: new Set(['missions:read', 'missions:write'] as const),
      },
    ],
    adminToken: 'list-bounds-admin-token',
  });
  const auth = {
    Host: 'localhost',
    Authorization: 'Bearer list-bounds-token',
    'Content-Type': 'application/json',
  };

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE evidence, summaries, execution_events, mission_claims, execution_runs, agent_sessions, mission_events, mission_sources, mission_checklist_items, missions, api_clients RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedMissions(count: number): Promise<void> {
    await pool.query(
      `INSERT INTO missions (title, body, status, stage, priority)
       SELECT 'Seeded mission ' || g, $2, 'todo'::mission_status, 'research'::mission_stage, 3
       FROM generate_series(1, $1) AS g`,
      [count, SEEDED_BODY],
    );
  }

  it('keeps the unfiltered payload under 512 KB with 400 seeded missions', async () => {
    await seedMissions(SEEDED_MISSIONS);

    const res = await app.request('http://localhost/api/v1/missions', { headers: auth });
    expect(res.status).toBe(200);

    const raw = await res.text();
    const size = Buffer.byteLength(raw, 'utf8');
    expect(size).toBeLessThan(PAYLOAD_CEILING_BYTES);
    expect(size).toBeLessThan(SSE_CEILING_BYTES);

    const page = JSON.parse(raw) as {
      missions: unknown[];
      total: number;
      limit: number;
      offset: number;
      nextOffset: number | null;
    };
    expect(page.total).toBe(SEEDED_MISSIONS);
    expect(page.limit).toBe(MISSION_LIST_DEFAULT_LIMIT);
    expect(page.offset).toBe(0);
    expect(page.missions).toHaveLength(MISSION_LIST_DEFAULT_LIMIT);
    expect(page.nextOffset).toBe(MISSION_LIST_DEFAULT_LIMIT);
  });

  it('never returns a full mission body — only an excerpt and its length', async () => {
    await seedMissions(3);

    const res = await app.request('http://localhost/api/v1/missions', { headers: auth });
    const page = (await res.json()) as {
      missions: Array<Record<string, unknown>>;
    };

    for (const mission of page.missions) {
      expect(mission).not.toHaveProperty('body');
      expect(typeof mission.body_excerpt).toBe('string');
      expect((mission.body_excerpt as string).length).toBeLessThanOrEqual(
        MISSION_BODY_EXCERPT_CHARS,
      );
      expect(mission.body_length).toBe(SEEDED_BODY.length);
    }
  });

  it('serves the full body through missions.get, so nothing is lost', async () => {
    await seedMissions(1);
    const res = await app.request('http://localhost/api/v1/missions/1', { headers: auth });
    expect(res.status).toBe(200);

    const payload = (await res.json()) as { mission: { body: string } };
    expect(payload.mission.body).toBe(SEEDED_BODY);
  });

  it('paginates with offset and reports the next page boundary', async () => {
    await seedMissions(120);

    const res = await app.request(
      `http://localhost/api/v1/missions?limit=${MISSION_LIST_MAX_LIMIT}&offset=100`,
      { headers: auth },
    );
    const page = (await res.json()) as {
      missions: Array<{ id: number }>;
      total: number;
      limit: number;
      offset: number;
      nextOffset: number | null;
    };

    expect(page.total).toBe(120);
    expect(page.limit).toBe(MISSION_LIST_MAX_LIMIT);
    expect(page.offset).toBe(100);
    expect(page.missions).toHaveLength(20);
    expect(page.nextOffset).toBeNull();
  });

  it('refuses an out-of-contract limit instead of silently ignoring it', async () => {
    const res = await app.request(
      `http://localhost/api/v1/missions?limit=${MISSION_LIST_MAX_LIMIT + 1}`,
      { headers: auth },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('filters by business status and by text query', async () => {
    await seedMissions(10);
    await pool.query(
      `INSERT INTO missions (title, body, status, stage, priority)
       VALUES ('Zebra calibration note', 'unique-token-zebra', 'blocked', 'execution', 1)`,
    );

    const blocked = await app.request('http://localhost/api/v1/missions?status=blocked', {
      headers: auth,
    });
    const blockedPage = (await blocked.json()) as {
      missions: Array<{ title: string }>;
      total: number;
    };
    expect(blockedPage.total).toBe(1);
    expect(blockedPage.missions[0]?.title).toBe('Zebra calibration note');

    const searched = await app.request('http://localhost/api/v1/missions?q=zebra', {
      headers: auth,
    });
    const searchedPage = (await searched.json()) as {
      missions: Array<{ title: string }>;
      total: number;
    };
    expect(searchedPage.total).toBe(1);
    expect(searchedPage.missions[0]?.title).toBe('Zebra calibration note');
  });
});
