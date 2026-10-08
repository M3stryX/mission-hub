# Mission Hub — Agent Usage Contract

Contract-Version: v1.2  
Status: active  
Applies-to: REST `/api/v1/*` and MCP server `mission-hub`  
Skill pointer: personal/kit skill `mission-control` v3+ **must defer** to this document  
Related: CLAIM-01 (#195), USAGE-01 (#196), `docs/contract-inventory.json`, `AGENTS.md`

English only. Bump `Contract-Version` and `agentUsage.version` in the contract inventory together.

## 1. Purpose

Tell every agent client (Cursor, OpenCode, Hermes/Lyra, DSH/Vega, n8n) how to use Mission Hub without a bespoke mega-prompt or Hindsight as operational state.

## 2. State separation

| Layer | Field / table | Meaning |
|-------|---------------|---------|
| Business | `mission.status` | Durable goal state only (`backlog`…`done`/`blocked`). **Not a lock.** |
| Coordination | `mission_claims` | Temporary exclusive ownership with lease expiry |
| Execution | `execution_runs` | Transient run for one client/runtime/agent, optionally typed by `purpose` |

Never use `mission.status = in_progress` as a substitute for a claim.

## 3. SSOT boundaries

| System | Role |
|--------|------|
| **Mission Hub** | Operational SSOT for missions, claims, runs, checklist, sources, events, summaries, evidence |
| **n8n** | Dispatcher / integration / HITL — not claim SSOT |
| **Hindsight** | Memory and decisions — not mission/claim SSOT |
| **Kanban** | Ephemeral *how* (agent cards). Mission = durable *why* |

## 4. Canonical lifecycle

1. **Discover** — `missions.list` (optional `query`) / `missions.get`; read checklist, sources, events.
2. **Claim** (when exclusive work is required) — `missions.claim` atomically creates session + `RUNNING` run + claim. One open claim per mission. Active foreign claim → `claim_conflict` (409).
3. **Heartbeat** — `missions.claim.renew` while working.
4. **Work** — update checklist/sources; keep business status accurate with `missions.update`.
5. **Report** — before successful release: `runs.recordSummary` + `runs.recordEvidence`.
6. **Release** — `missions.claim.release`:
   - `completed` — requires ≥1 summary and ≥1 evidence; run → `COMPLETED` in the same transaction
   - `failed` / `abandoned` — run → `FAILED` (refuse if already `COMPLETED`)
7. **Close business state** — `missions.update` → `done` (or `blocked`/`review`) when the durable goal is finished.

### Standalone runs

`runs.create` is allowed without a claim (ad-hoc / verify fixtures). Prefer `missions.claim` when serialization matters — it already creates the run. Reuse `externalRunId` for idempotent retries (`UNIQUE(client_id, runtime, external_run_id)`). New runs may declare `purpose`: `research` | `implementation` | `runtime_verification` | `independent_review` | `incident_analysis` | `maintenance` | `migration` | `benchmark` | `other` | `architecture` (new in v1.2) | `planning` (new in v1.2) | `jev_gate` (new in v1.2). Legacy runs keep `purpose = null`; do not infer durable truth during migration.

### Expiry / reclaim / fencing

On reclaim of an expired claim, Hub:

1. Resolves claim → run → agent session
2. Records `claim.expiry_diagnosis` with cause in  
   `SESSION_CLOSED` | `SESSION_ABORTED` | `SESSION_STALE` | `RUN_ALREADY_TERMINAL` | `UNKNOWN`  
   (never invent a cause from “lease expired” alone; `RUNTIME_UNREACHABLE` reserved when a signal exists)
3. Terminalizes a non-terminal previous run (typically `FAILED`) and fences the previous owner (`claim_fenced` / 403 on further mutations)

## 5. Artifact rules

- **Checklist** — ordered gates; mutable.
- **Sources** — unique `(mission, path)`; prefer docs/links over stuffing the body.
- **Summaries** — `agent_self_report` | `research_report` | `reviewer_validated` | `operator_note` | `plan_summary` (new in v1.2) | `plan_approval` (new in v1.2) | `jev_decision` (new in v1.2). A `research_report` is a run-owned research artifact, not automatically validated truth. A `plan_summary` is the mission's execution plan artifact; a `plan_approval` is written only through the `approvals:human` endpoint (see §12). A `jev_decision` is the recorded Jev-gate evaluation (see §13). Optional summary metadata may link provenance with `validatesSummaryId` or `supersedesSummaryId`.
- **Evidence** — `kind`, `label`, `uri`, optional `metadata`. Research-aware metadata may include `source_type` (`observed_runtime` | `real_data` | `code_config` | `internal_doc` | `external_primary` | `external_community` | `inference`), `authority`, `observed_at`, `retrieved_at`, `version`, `supports`, `confidence`, `freshness`, `immutable`, and `ref_type`. Unknown extra metadata remains allowed for backward compatibility; an invalid supplied `source_type` is rejected.
- **Events** — append-only audit; do not fabricate manually.

## 6. Research reports

Research remains inside the existing Mission → Run → Summary → Evidence graph. There is no separate research-report table or database.

- A research execution uses `execution_runs.purpose = research`.
- Its durable report uses `summary.type = research_report`.
- `research.listReports(missionId)` returns all matching reports newest first. Older reports remain visible.
- `research.getCanonicalReport(missionId)` returns the newest matching report. This derived selection is the canonical/current report; it does not copy report content into the mission body.
- Independent review stays a separate run (normally `purpose = independent_review`) and may write a `reviewer_validated` summary whose metadata points to the validated report with `validatesSummaryId`.
- Supersession is provenance, not deletion: a newer report may reference `supersedesSummaryId`; older reports stay queryable.
- Runtime evidence outranks docs/inference for current-state claims. An agent self-report is never promoted automatically to validated truth.

### Writeback compatibility

Existing writeback payloads remain valid because `purpose`, summary metadata, and research taxonomy metadata are optional. Research-aware writers should add:

- run `purpose`;
- summary `type = research_report` when emitting a research report;
- optional summary provenance metadata;
- evidence taxonomy metadata where applicable.

Legacy records remain unclassified unless a later explicit migration classifies them from authoritative evidence.

## 7. Scopes

Lifecycle maps to Bearer scopes: `missions:*`, `runs:*`, `summaries:*`, `evidence:*`.  
`clients:admin` = mint/revoke. `verify:admin` = staging-only fixture cleanup.  
`approvals:human` (new in v1.2) = record human plan approvals (`missions.planApproval` / `POST /api/v1/missions/:id/plan-approval`). It is **mint-forbidden** (`POST /admin/clients` rejects it) and **privileged**: only an env-issued credential (`MISSION_HUB_CLIENTS_JSON`) can carry it — clients resolved from `api_clients` drop privileged scopes at authentication.

## 8. Hosts

| Env | Host |
|-----|------|
| Production | `mission-hub.lan` |
| Staging | `mission-hub-staging.lan` |

Destructive verify (`verify:admin` + `MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY`) is staging-only.

## 9. Secrets

Never paste API tokens, Dokploy env dumps, or DB passwords into chat, PRs, or Hindsight. Rotate after any leak. Prefer status-only Dokploy fields when inspecting deploys.

## 10. Drift control

The machine inventory (`src/contract/inventory.ts` → `docs/contract-inventory.json`) includes:

- `agentUsage.version` / `agentUsage.path` — must match this file’s `Contract-Version`
- `mcpToolDescriptions` — must match MCP `registerTool` descriptions used at runtime

CI fails on drift. Changing lifecycle semantics requires bumping this contract version.

## 11. Client skill policy

Reusable skills (e.g. `mission-control`) may teach the workflow but **must not** fork semantics. If skill and this contract disagree, **this contract wins**.

## 12. Lifecycle stages

`missions.stage` (enum `mission_stage`, default `research`, added by migration `0006`) records where a mission sits in the 5-stage lifecycle. It is **record/read only at v1.2** — nothing in REST or MCP transitions or enforces it yet.

| Stage | Run purpose | Artifact that proves the stage | Gate to the next stage (enforced in v2.0) |
|-------|-------------|-------------------------------|-------------------------------------------|
| `research` | `research` (existing) | canonical `research_report` + evidence | canonical research report exists |
| `architecture` | `architecture` (new in v1.2) | `jev_decision` summary + Jev evidence on a `jev_gate` run | canonical `jev_decision` recorded; `human_necessary` → operator validation |
| `plan` | `planning` (new in v1.2) | `plan_summary` + `plan_approval` | approval by a non-author human principal |
| `execution` | `implementation` (existing) | claim / release rules (existing) | existing claim/release semantics |
| `done` | — | checklist complete + run `COMPLETED` | — |

v1.2 limitations (OQ-7):

- No code path blocks a run, claim, or transition — the guards are v2.0 work.
- `stage` is not part of the REST/MCP mission payload: mission readouts still return the v1.1 field set, so `stage` is currently readable via SQL only. Exposing it is a deliberate contract bump (v2.0).
- `mission.status` (business state) stays authoritative and is never derived from `stage`.

## 13. Jev gate (record/read only at v1.2)

An architecture run records its Jev evaluation as `summary_type = jev_decision` (metadata may carry `checkpoint`) on a `purpose = jev_gate` run, alongside evidence (kind `jev_evaluation`). At v1.2 Mission Hub stores and serves that evaluation; it does not evaluate or block anything — the gate itself is v2.0.

| Surface | Endpoint / tool | Semantics |
|---------|-----------------|-----------|
| MCP | `jev.listEvaluations(missionId, checkpoint?)` | `jev_decision` summaries of one mission, newest first |
| REST | `GET /api/v1/missions/:id/jev-evaluations[?checkpoint=…]` | same rows, `{ evaluations: [...] }` |
| MCP | `jev.getGateStatus()` | unfiltered `jev_decision` rows across all missions |
| REST | `GET /api/v1/jev-gate` | same rows, `{ evaluations: [...] }` |
| MCP | `missions.planApproval(missionId, content)` | write `plan_approval` |
| REST | `POST /api/v1/missions/:id/plan-approval` | same writer (one shared store function) |

Plan-approval rules:

- Scope `approvals:human` is mandatory — `403` without it (`401` when no credential is presented).
- `401 plan_not_open` when the mission has no `purpose = planning` run yet (draft check only, no stage enforcement).
- `409 self_approval` when the caller is the author of that mission's `plan_summary`.
- `404` for an unknown mission id.

Plan approval is only **recorded** at v1.2: neither REST nor MCP writes `missions.stage`.
