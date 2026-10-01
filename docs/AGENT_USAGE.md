# Mission Hub — Agent Usage Contract

Contract-Version: v1  
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
| Execution | `execution_runs` | Transient run for one client/runtime/agent |

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

`runs.create` is allowed without a claim (ad-hoc / verify fixtures). Prefer `missions.claim` when serialization matters — it already creates the run. Reuse `externalRunId` for idempotent retries (`UNIQUE(client_id, runtime, external_run_id)`).

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
- **Summaries** — `agent_self_report` | `reviewer_validated` | `operator_note`. Prefer validated when evidence exists.
- **Evidence** — `kind`, `label`, `uri`, optional `metadata` (CI run URL, commit SHA, deploy id, n8n execution id).
- **Events** — append-only audit; do not fabricate manually.

## 6. Scopes

Lifecycle maps to Bearer scopes: `missions:*`, `runs:*`, `summaries:*`, `evidence:*`.  
`clients:admin` = mint/revoke. `verify:admin` = staging-only fixture cleanup.

## 7. Hosts

| Env | Host |
|-----|------|
| Production | `mission-hub.lan` |
| Staging | `mission-hub-staging.lan` |

Destructive verify (`verify:admin` + `MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY`) is staging-only.

## 8. Secrets

Never paste API tokens, Dokploy env dumps, or DB passwords into chat, PRs, or Hindsight. Rotate after any leak. Prefer status-only Dokploy fields when inspecting deploys.

## 9. Drift control

The machine inventory (`src/contract/inventory.ts` → `docs/contract-inventory.json`) includes:

- `agentUsage.version` / `agentUsage.path` — must match this file’s `Contract-Version`
- `mcpToolDescriptions` — must match MCP `registerTool` descriptions used at runtime

CI fails on drift. Changing lifecycle semantics requires bumping this contract version.

## 10. Client skill policy

Reusable skills (e.g. `mission-control`) may teach the workflow but **must not** fork semantics. If skill and this contract disagree, **this contract wins**.
