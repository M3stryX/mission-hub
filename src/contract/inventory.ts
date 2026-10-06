/**
 * Machine-checkable contract inventory for Mission Hub.
 * Keep in sync with schema enums, auth scopes, REST routes, MCP tools,
 * MCP descriptions, and docs/AGENT_USAGE.md.
 */

export const AGENT_USAGE_CONTRACT = {
  version: 'v1.1',
  path: 'docs/AGENT_USAGE.md',
} as const;

export const CONTRACT_ENUMS = {
  mission_status: [
    'backlog',
    'todo',
    'in_progress',
    'review',
    'done',
    'blocked',
  ],
  run_status: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'],
  run_purpose: [
    'research',
    'implementation',
    'runtime_verification',
    'independent_review',
    'incident_analysis',
    'maintenance',
    'migration',
    'benchmark',
    'other',
  ],
  review_state: ['NONE', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'],
  summary_type: [
    'agent_self_report',
    'reviewer_validated',
    'operator_note',
    'research_report',
  ],
  source_kind: ['doc', 'link'],
  session_status: ['OPEN', 'CLOSED', 'ABORTED'],
  claim_release_reason: ['completed', 'failed', 'abandoned', 'expired'],
} as const;

export const CONTRACT_SCOPES = [
  'missions:read',
  'missions:write',
  'runs:read',
  'runs:write',
  'summaries:read',
  'summaries:write',
  'evidence:read',
  'evidence:write',
  'clients:admin',
  'verify:admin',
] as const;

export const CONTRACT_TABLES = [
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
] as const;

export const CONTRACT_REST_ROUTES = [
  'GET /health',
  'GET /ready',
  'GET /api/v1/admin/clients',
  'POST /api/v1/admin/clients',
  'POST /api/v1/admin/clients/:clientId/revoke',
  'DELETE /api/v1/admin/verify-fixtures/:missionId',
  'GET /api/v1/missions',
  'GET /api/v1/missions/:id',
  'POST /api/v1/missions',
  'PATCH /api/v1/missions/:id',
  'GET /api/v1/missions/:id/checklist',
  'POST /api/v1/missions/:id/checklist',
  'PATCH /api/v1/missions/:id/checklist/:itemId',
  'DELETE /api/v1/missions/:id/checklist/:itemId',
  'GET /api/v1/missions/:id/sources',
  'POST /api/v1/missions/:id/sources',
  'DELETE /api/v1/missions/:id/sources/:sourceId',
  'GET /api/v1/missions/:id/events',
  'GET /api/v1/missions/:id/claim',
  'POST /api/v1/missions/:id/claim',
  'POST /api/v1/claims/:claimId/renew',
  'POST /api/v1/claims/:claimId/release',
  'GET /api/v1/missions/:id/runs',
  'GET /api/v1/missions/:id/research-reports',
  'GET /api/v1/missions/:id/research-report',
  'POST /api/v1/runs',
  'PATCH /api/v1/runs/:id/status',
  'GET /api/v1/runs/:id/events',
  'POST /api/v1/runs/:id/summaries',
  'GET /api/v1/runs/:id/summaries',
  'POST /api/v1/runs/:id/evidence',
  'GET /api/v1/runs/:id/evidence',
  'ALL /mcp',
] as const;

export const CONTRACT_MCP_TOOLS = [
  'missions.list',
  'missions.get',
  'missions.create',
  'missions.update',
  'missions.checklist.list',
  'missions.checklist.add',
  'missions.checklist.update',
  'missions.checklist.remove',
  'missions.sources.list',
  'missions.sources.add',
  'missions.sources.remove',
  'missions.events.list',
  'missions.claim.get',
  'missions.claim',
  'missions.claim.renew',
  'missions.claim.release',
  'runs.list',
  'runs.create',
  'runs.updateStatus',
  'research.listReports',
  'research.getCanonicalReport',
  'runs.listEvents',
  'runs.recordSummary',
  'runs.listSummaries',
  'runs.recordEvidence',
  'runs.listEvidence',
] as const;

/** MCP descriptions are lifecycle docs for models — keep aligned with AGENT_USAGE.md. */
export const CONTRACT_MCP_TOOL_DESCRIPTIONS = {
  'missions.list':
    'Discover durable missions (optional query). Prefer list/get before creating duplicates. Business status is not a lock — use claims for exclusive work. See docs/AGENT_USAGE.md v1.',
  'missions.get':
    'Get one durable mission by id. Read checklist/sources/events next for context before claiming or updating.',
  'missions.create':
    'Create a durable mission (business state). Set status todo when actionable. Does not claim or create a run — call missions.claim when exclusive execution is required.',
  'missions.update':
    'Patch durable mission fields including business status (backlog…done/blocked). Never use status as an execution lock; use missions.claim / renew / release.',
  'missions.checklist.list':
    'List ordered checklist gates for a mission (progress decomposition).',
  'missions.checklist.add':
    'Add an ordered checklist gate to a mission.',
  'missions.checklist.update':
    'Update a checklist item (text, done, position) owned by the mission.',
  'missions.checklist.remove':
    'Remove a checklist item owned by the mission.',
  'missions.sources.list':
    'List linked sources (docs/links) for a mission.',
  'missions.sources.add':
    'Attach a unique source path/URL (kind doc|link). Prefer sources over stuffing large docs into the body.',
  'missions.sources.remove':
    'Remove a source owned by the mission.',
  'missions.events.list':
    'List append-only mission audit events (includes claim.acquired/renewed/expired/released and expiry diagnosis).',
  'missions.claim.get':
    'Get the active non-expired claim for a mission, if any. Null means the mission is free to claim.',
  'missions.claim':
    'Atomically claim a mission with a lease and create the linked RUNNING execution run + session. One open claim per mission; conflict → claim_conflict. Prefer this over runs.create when exclusive work is required. See docs/AGENT_USAGE.md v1.',
  'missions.claim.renew':
    'Renew/heartbeat an owned active claim lease. Fails if not owned, already released, or expired.',
  'missions.claim.release':
    'Release an owned claim. completed requires summary+evidence and terminalizes the run COMPLETED; failed|abandoned terminalizes FAILED. Couples claim and run in one transaction.',
  'runs.list':
    'List execution runs for a mission (newest first), optionally filtered by typed purpose. Legacy runs may have purpose=null.',
  'runs.create':
    'Create a run without claiming, optionally with typed purpose (research|implementation|runtime_verification|independent_review|incident_analysis|maintenance|migration|benchmark|other). Prefer missions.claim for exclusive work.',
  'runs.updateStatus':
    'Update run status (PENDING|RUNNING|COMPLETED|FAILED). After claim expiry/reclaim, previous owners are fenced (claim_fenced). Prefer claim.release for terminalization on claimed work.',
  'research.listReports':
    'List all research_report summaries for research-purpose runs on a mission, newest first. The first item is canonical; older reports remain visible.',
  'research.getCanonicalReport':
    'Return the canonical research report for a mission: the newest research_report summary attached to a run with purpose=research, or null.',
  'runs.listEvents':
    'List execution events for a run (status changes, claim events, summaries, evidence).',
  'runs.recordSummary':
    'Append a typed summary (agent_self_report|research_report|reviewer_validated|operator_note) with optional provenance metadata. Required before claim.release completed.',
  'runs.listSummaries':
    'List summaries for a run, optionally filtered by summary type.',
  'runs.recordEvidence':
    'Append evidence (kind, label, uri, metadata). When research taxonomy is supplied, source_type must be one of observed_runtime|real_data|code_config|internal_doc|external_primary|external_community|inference.',
  'runs.listEvidence':
    'List evidence references for a run.',
} as const satisfies Record<(typeof CONTRACT_MCP_TOOLS)[number], string>;

export interface ContractInventory {
  agentUsage: typeof AGENT_USAGE_CONTRACT;
  enums: typeof CONTRACT_ENUMS;
  scopes: typeof CONTRACT_SCOPES;
  tables: typeof CONTRACT_TABLES;
  restRoutes: typeof CONTRACT_REST_ROUTES;
  mcpTools: typeof CONTRACT_MCP_TOOLS;
  mcpToolDescriptions: typeof CONTRACT_MCP_TOOL_DESCRIPTIONS;
}

export function buildContractInventory(): ContractInventory {
  return {
    agentUsage: AGENT_USAGE_CONTRACT,
    enums: CONTRACT_ENUMS,
    scopes: CONTRACT_SCOPES,
    tables: CONTRACT_TABLES,
    restRoutes: CONTRACT_REST_ROUTES,
    mcpTools: CONTRACT_MCP_TOOLS,
    mcpToolDescriptions: CONTRACT_MCP_TOOL_DESCRIPTIONS,
  };
}
