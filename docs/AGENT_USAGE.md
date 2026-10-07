# Mission Hub — Agent Usage Contract

Contract-Version: v1.1  
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

`runs.create` is allowed without a claim (ad-hoc / verify fixtures). Prefer `missions.claim` when serialization matters — it already creates the run. Reuse `externalRunId` for idempotent retries (`UNIQUE(client_id, runtime, external_run_id)`). New runs may declare `purpose`: `research` | `implementation` | `runtime_verification` | `independent_review` | `incident_analysis` | `maintenance` | `migration` | `benchmark` | `other`. Legacy runs keep `purpose = null`; do not infer durable truth during migration.

### Expiry / reclaim / fencing

On reclaim of an expired claim, Hub:

1. Resolves claim → run → agent session
2. Records `claim.expiry_diagnosis` with cause in  
   `SESSION_CLOSED` | `SESSION_ABORTED` | `SESSION_STALE` | `RUN_ALREADY_TERMINAL` | `UNKNOWN`  
   (never invent a cause from "lease expired" alone; `RUNTIME_UNREACHABLE` reserved when a signal exists)
3. Terminalizes a non-terminal previous run (typically `FAILED`) and fences the previous owner (`claim_fenced` / 403 on further mutations)

## 5. Artifact rules

- **Checklist** — ordered gates; mutable.
- **Sources** — unique `(mission, path)`; prefer docs/links over stuffing the body.
- **Summaries** — `agent_self_report` | `research_report` | `reviewer_validated` | `operator_note`. A `research_report` is a run-owned research artifact, not automatically validated truth. Optional summary metadata may link provenance with `validatesSummaryId` or `supersedesSummaryId`.
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

- `agentUsage.version` / `agentUsage.path` — must match this file's `Contract-Version`
- `mcpToolDescriptions` — must match MCP `registerTool` descriptions used at runtime

CI fails on drift. Changing lifecycle semantics requires bumping this contract version.

## 11. Client skill policy

Reusable skills (e.g. `mission-control`) may teach the workflow but **must not** fork semantics. If skill and this contract disagree, **this contract wins**.