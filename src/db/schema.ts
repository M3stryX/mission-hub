import { pgTable, serial, text, timestamp, integer, boolean, jsonb, unique, index, pgEnum } from 'drizzle-orm/pg-core';

// Enums
export const missionStatusEnum = pgEnum('mission_status', ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked']);
export const sessionStatusEnum = pgEnum('session_status', ['OPEN', 'CLOSED', 'ABORTED']);
export const runStatusEnum = pgEnum('run_status', ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);
export const reviewStateEnum = pgEnum('review_state', ['NONE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED']);
export const summaryTypeEnum = pgEnum('summary_type', ['agent_self_report', 'reviewer_validated', 'operator_note']);

// Tables
export const missions = pgTable('missions', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body'),
  status: missionStatusEnum('status').default('backlog').notNull(),
  priority: integer('priority').default(3).notNull(),
  dueAt: timestamp('due_at'),
  source: text('source'),
  tags: text('tags'),
  recurrence: text('recurrence'),
  parentId: integer('parent_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  parentIdx: index('missions_parent_idx').on(table.parentId),
  statusIdx: index('missions_status_idx').on(table.status),
}));

export const agentSessions = pgTable('agent_sessions', {
  id: serial('id').primaryKey(),
  clientId: text('client_id').notNull(),
  runtime: text('runtime').notNull(),
  agent: text('agent').notNull(),
  externalSessionId: text('external_session_id').notNull(),
  correlationId: text('correlation_id'),
  status: sessionStatusEnum('status').default('OPEN').notNull(),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  endedAt: timestamp('ended_at'),
}, (table) => ({
  uniqueSession: unique('unique_client_runtime_ext').on(table.clientId, table.runtime, table.externalSessionId),
  correlationIdx: index('agent_sessions_correlation_idx').on(table.correlationId),
}));

export const executionRuns = pgTable('execution_runs', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id').references(() => agentSessions.id).notNull(),
  missionId: integer('mission_id').references(() => missions.id),
  clientId: text('client_id').notNull(),
  runtime: text('runtime').notNull(),
  agent: text('agent').notNull(),
  externalRunId: text('external_run_id').notNull(),
  correlationId: text('correlation_id'),
  status: runStatusEnum('status').default('PENDING').notNull(),
  reviewState: reviewStateEnum('review_state').default('NONE').notNull(),
  metadataJson: jsonb('metadata_json'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
}, (table) => ({
  uniqueRun: unique('unique_session_ext_run').on(table.sessionId, table.externalRunId),
  missionIdx: index('execution_runs_mission_idx').on(table.missionId),
  correlationIdx: index('execution_runs_correlation_idx').on(table.correlationId),
}));

export const executionEvents = pgTable('execution_events', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').references(() => executionRuns.id).notNull(),
  actor: text('actor').notNull(),
  kind: text('kind').notNull(),
  statusFrom: text('status_from'),
  statusTo: text('status_to'),
  payloadJson: jsonb('payload_json'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  runIdx: index('execution_events_run_idx').on(table.runId),
}));

export const summaries = pgTable('summaries', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').references(() => executionRuns.id).notNull(),
  type: summaryTypeEnum('type').notNull(),
  content: text('content').notNull(),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  runIdx: index('summaries_run_idx').on(table.runId),
}));

export const evidence = pgTable('evidence', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').references(() => executionRuns.id).notNull(),
  type: text('type').notNull(),
  label: text('label').notNull(),
  uri: text('uri').notNull(),
  metadataJson: jsonb('metadata_json'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  runIdx: index('evidence_run_idx').on(table.runId),
}));

export const schemaMigrations = pgTable('schema_migrations', {
  id: serial('id').primaryKey(),
  version: text('version').notNull().unique(),
  appliedAt: timestamp('applied_at').defaultNow().notNull(),
});