import { readFile } from 'node:fs/promises';
import { Pool, PoolClient } from 'pg';

type JsonObject = Record<string, unknown>;

type MissionStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'blocked';

interface LegacyMission {
  id: number;
  title: string;
  body?: string | null;
  status: MissionStatus | 'cancelled' | string;
  priority: number | string;
  due_at?: string | null;
  source?: string | null;
  tags?: string | null;
  recurrence?: string | null;
  parent_id?: number | null;
  created_at: string;
  updated_at: string;
}

const MISSION_STATUSES = new Set<MissionStatus>([
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
]);

function normalizeMissionStatus(status: string): MissionStatus {
  if (MISSION_STATUSES.has(status as MissionStatus)) {
    return status as MissionStatus;
  }
  // Legacy Piblox used `cancelled` for closed work; V1 has no such enum.
  if (status === 'cancelled') {
    return 'done';
  }
  throw new Error(`Unsupported legacy mission status: ${status}`);
}

function normalizePriority(priority: number | string): number {
  if (typeof priority === 'number' && Number.isInteger(priority)) {
    if (priority < 1 || priority > 5) {
      throw new Error(`Legacy priority out of range: ${priority}`);
    }
    return priority;
  }

  const mapped: Record<string, number> = {
    highest: 1,
    high: 2,
    medium: 3,
    normal: 3,
    low: 4,
    lowest: 5,
  };
  const key = String(priority).toLowerCase();
  if (key in mapped) {
    return mapped[key];
  }
  throw new Error(`Unsupported legacy priority: ${priority}`);
}

interface LegacyChecklistItem {
  id: number;
  mission_id: number;
  item: string;
  done: boolean | number;
  position: number;
  created_at: string;
}

interface LegacySource {
  id: number;
  mission_id: number;
  label: string;
  path: string;
  kind: 'doc' | 'link';
  created_at: string;
}

interface LegacyEvent {
  id: number;
  mission_id: number | null;
  actor: string;
  kind: string;
  payload?: JsonObject | null;
  created_at: string;
}

interface LegacyBundle {
  format: 'mission-hub-legacy-export-v1';
  missions: LegacyMission[];
  mission_checklist_items: LegacyChecklistItem[];
  mission_sources: LegacySource[];
  mission_events: LegacyEvent[];
  cursor_sessions?: JsonObject[];
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const input = process.argv[2];
if (!input) {
  throw new Error('usage: pnpm legacy:import BUNDLE_JSON');
}

const pool = new Pool({ connectionString: databaseUrl });

async function resetSequence(client: PoolClient, table: string) {
  await client.query(
    `SELECT setval(
      pg_get_serial_sequence($1, 'id'),
      COALESCE(MAX(id), 1),
      MAX(id) IS NOT NULL
    ) FROM ${table}`,
    [table],
  );
}

async function run() {
  const bundle = JSON.parse(await readFile(input, 'utf8')) as LegacyBundle;
  if (bundle.format !== 'mission-hub-legacy-export-v1') {
    throw new Error('Unsupported legacy export format');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const mission of bundle.missions) {
      await client.query(
        `INSERT INTO missions(
          id, title, body, status, priority, due_at, source, tags, recurrence,
          parent_id, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11)`,
        [
          mission.id,
          mission.title,
          mission.body ?? null,
          normalizeMissionStatus(mission.status),
          normalizePriority(mission.priority),
          mission.due_at ?? null,
          mission.source ?? null,
          mission.tags ?? null,
          mission.recurrence ?? null,
          mission.created_at,
          mission.updated_at,
        ],
      );
    }

    for (const mission of bundle.missions) {
      if (mission.parent_id != null) {
        await client.query(
          'UPDATE missions SET parent_id = $1 WHERE id = $2',
          [mission.parent_id, mission.id],
        );
      }
    }

    for (const item of bundle.mission_checklist_items) {
      await client.query(
        `INSERT INTO mission_checklist_items(
          id, mission_id, item, done, position, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [item.id, item.mission_id, item.item, Boolean(item.done), item.position, item.created_at],
      );
    }

    for (const source of bundle.mission_sources) {
      await client.query(
        `INSERT INTO mission_sources(
          id, mission_id, label, path, kind, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [source.id, source.mission_id, source.label, source.path, source.kind, source.created_at],
      );
    }

    let skippedEvents = 0;
    for (const event of bundle.mission_events) {
      if (event.mission_id == null) {
        // Legacy search/audit rows without a mission target are not part of V1 SSOT.
        skippedEvents += 1;
        continue;
      }
      await client.query(
        `INSERT INTO mission_events(
          id, mission_id, actor, kind, payload, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          event.id,
          event.mission_id,
          event.actor,
          event.kind,
          event.payload == null ? null : JSON.stringify(event.payload),
          event.created_at,
        ],
      );
    }

    for (const table of [
      'missions',
      'mission_checklist_items',
      'mission_sources',
      'mission_events',
    ]) {
      await resetSequence(client, table);
    }

    await client.query('COMMIT');

    process.stdout.write(
      JSON.stringify({
        missions: bundle.missions.length,
        checklistItems: bundle.mission_checklist_items.length,
        sources: bundle.mission_sources.length,
        events: bundle.mission_events.length - skippedEvents,
        eventsSkippedNullMissionId: skippedEvents,
        cursorSessionsSkipped: bundle.cursor_sessions?.length ?? 0,
      }) + '\n',
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await run();
