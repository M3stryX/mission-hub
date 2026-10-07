import {
  AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const missionStatusEnum = pgEnum('mission_status', [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked',
]);

export const sourceKindEnum = pgEnum('source_kind', ['doc', 'link']);
export const sessionStatusEnum = pgEnum('session_status', ['OPEN', 'CLOSED', 'ABORTED']);
export const runStatusEnum = pgEnum('run_status', ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);
export const runPurposeEnum = pgEnum('run_purpose', [
  'research',
  'implementation',
  'runtime_verification',
  'independent_review',
  'incident_analysis',
  'maintenance',
  'migration',
  'benchmark',
  'other',
]);
export const reviewStateEnum = pgEnum('review_state', [
  'NONE',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
]);
export const summaryTypeEnum = pgEnum('summary_type', [
  'agent_self_report',
  'reviewer_validated',
  'operator_note',
  'research_report',
]);

export const missions = pgTable(
  'missions',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body'),
    status: missionStatusEnum('status').notNull().default('backlog'),
    priority: integer('priority').notNull().default(3),
    dueAt: text('due_at'),
    source: text('source'),
    tags: text('tags'),
    recurrence: text('recurrence'),
    parentId: integer('parent_id').references((): AnyPgColumn => missions.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('missions_status_idx').on(table.status),
    parentIdx: index('missions_parent_idx').on(table.parentId),
  }),
);

export const missionChecklistItems = pgTable(
  'mission_checklist_items',
  {
    id: serial('id').primaryKey(),
    missionId: integer('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    item: text('item').notNull(),
    done: boolean('done').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionPositionIdx: index('mission_checklist_items_mission_position_idx').on(
      table.missionId,
      table.position,
    ),
  }),
);

export const missionSources = pgTable(
  'mission_sources',
  {
    id: serial('id').primaryKey(),
    missionId: integer('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    path: text('path').notNull(),
    kind: sourceKindEnum('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionPathUnique: uniqueIndex('mission_sources_mission_path_uidx').on(
      table.missionId,
      table.path,
    ),
  }),
);

export const missionEvents = pgTable(
  'mission_events',
  {
    id: serial('id').primaryKey(),
    missionId: integer('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    actor: text('actor').notNull().default('system'),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    missionCreatedIdx: index('mission_events_mission_created_idx').on(
      table.missionId,
      table.createdAt,
    ),
  }),
);

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: serial('id').primaryKey(),
    clientId: text('client_id').notNull(),
    runtime: text('runtime').notNull(),
    agent: text('agent').notNull(),
    externalSessionId: text('external_session_id').notNull(),
    correlationId: text('correlation_id'),
    status: sessionStatusEnum('status').notNull().default('OPEN'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => ({
    externalSessionUnique: uniqueIndex('agent_sessions_client_runtime_external_uidx').on(
      table.clientId,
      table.runtime,
      table.externalSessionId,
    ),
    correlationIdx: index('agent_sessions_correlation_idx').on(table.correlationId),
  }),
);

export const executionRuns = pgTable(
  'execution_runs',
  {
    id: serial('id').primaryKey(),
    missionId: integer('mission_id')
      .notNull()
      .references(() => missions.id),
    sessionId: integer('session_id')
      .notNull()
      .references(() => agentSessions.id),
    clientId: text('client_id').notNull(),
    runtime: text('runtime').notNull(),
    agent: text('agent').notNull(),
    externalRunId: text('external_run_id').notNull(),
    correlationId: text('correlation_id'),
    provider: text('provider'),
    model: text('model'),
    purpose: runPurposeEnum('purpose'),
    status: runStatusEnum('status').notNull().default('PENDING'),
    reviewState: reviewStateEnum('review_state').notNull().default('NONE'),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown> | null>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => ({
    externalRunUnique: uniqueIndex('execution_runs_client_runtime_external_uidx').on(
      table.clientId,
      table.runtime,
      table.externalRunId,
    ),
    missionIdx: index('execution_runs_mission_idx').on(table.missionId),
    missionPurposeIdx: index('execution_runs_mission_purpose_idx').on(
      table.missionId,
      table.purpose,
    ),
    sessionIdx: index('execution_runs_session_idx').on(table.sessionId),
    correlationIdx: index('execution_runs_correlation_idx').on(table.correlationId),
  }),
);

export const executionEvents = pgTable(
  'execution_events',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => executionRuns.id, { onDelete: 'cascade' }),
    actor: text('actor').notNull(),
    clientId: text('client_id'),
    kind: text('kind').notNull(),
    statusFrom: runStatusEnum('status_from'),
    statusTo: runStatusEnum('status_to'),
    payloadJson: jsonb('payload_json').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runCreatedIdx: index('execution_events_run_created_idx').on(table.runId, table.createdAt),
  }),
);

export const summaries = pgTable(
  'summaries',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => executionRuns.id, { onDelete: 'cascade' }),
    type: summaryTypeEnum('type').notNull(),
    content: text('content').notNull(),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown> | null>(),
    actor: text('actor').notNull(),
    clientId: text('client_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runCreatedIdx: index('summaries_run_created_idx').on(table.runId, table.createdAt),
  }),
);

export const evidence = pgTable(
  'evidence',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => executionRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    uri: text('uri').notNull(),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runCreatedIdx: index('evidence_run_created_idx').on(table.runId, table.createdAt),
  }),
);

export const apiClients = pgTable(
  'api_clients',
  {
    id: serial('id').primaryKey(),
    clientId: text('client_id').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    clientIdUnique: uniqueIndex('api_clients_client_id_uidx').on(table.clientId),
    tokenHashUnique: uniqueIndex('api_clients_token_hash_uidx').on(table.tokenHash),
  }),
);

export const schemaMigrations = pgTable('schema_migrations', {
  version: text('version').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});
