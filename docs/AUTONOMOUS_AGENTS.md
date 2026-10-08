# Autonomous Agent Workflows — Architecture and Policy

Mission Hub is a standalone mission + execution-trace service (Hono + PostgreSQL + MCP). This document is the behaviour reference and policy core for autonomous agent workflows against it. It is part of the runtime-agnostic Autonomous Agent Kit; the getting-started guide is §5–§6 of this document, and the role definitions, bootstrap prompt, and runtime adapters live in the sibling kit documents.

**Authority.** Mission Hub state is the single source of truth. [`docs/AGENT_USAGE.md`](AGENT_USAGE.md) (contract revision v1.2) is the contract source of truth; this guide defers to it and never restates contract semantics — where the two disagree, the contract wins. [DOCUMENTED — AGENT_USAGE.md §3, §11]

*Mission Hub 0.1.0 — contract revision 1.2.* The product version is `0.1.0`; `v1.2` is the agent contract/schema revision.

**Claim discipline.** Every capability claim below carries one status — **DOCUMENTED** (read in the contract or repo source), **IMPLEMENTED** (present in code and the machine inventory), **RUNTIME_WIRED** (reachable over MCP/REST), **TESTED** (exercised from a client runtime), or **OBSERVED** (executed end-to-end on a live instance) — with its evidence pointer:

| Tag | Evidence row |
|-----|--------------|
| [AUDIT A] | Canonical repo, gitflow/ruleset, contract surfaces, approval semantics (`t_6731197b`) |
| [AUDIT B] | Runtime capability matrix, measured from local CLI help and configs (`t_78c7bbb6`) |
| [AUDIT C] | Prior-art reuse inventory (`t_33655bee`) |
| [PROOF D] | End-to-end read-only loop + negative tests on a live instance (`t_240eb13e`) |
| [CONTRACT] | `docs/AGENT_USAGE.md` (contract revision v1.2) or `docs/contract-inventory.json` |

Counts in this guide (29 MCP tools, 36 REST routes, 11 scopes, 12 run purposes, 7 summary types, 7 evidence source types) are sourced from `docs/contract-inventory.json`, never from prose. [IMPLEMENTED — contract-inventory.json]

---

## 1. Authority chain

1. **Mission Hub is the operational SSOT** for missions, claims, runs, checklist, sources, events, summaries, and evidence. [DOCUMENTED — AGENT_USAGE.md §3]
2. **No parallel backlog, lock table, or competing contract.** n8n is a dispatcher/integration layer, not the claim store; Hindsight is memory, not operational state; Kanban is the ephemeral *how* (agent cards), while a Mission is the durable *why*. [DOCUMENTED — AGENT_USAGE.md §3]
3. **Business state is not a lock.** `mission.status` (`backlog`…`done`/`blocked`) is durable goal state only; temporary exclusive ownership lives in `mission_claims` with lease expiry. Never substitute `status = in_progress` for a claim. [DOCUMENTED — AGENT_USAGE.md §2; OBSERVED — PROOF D: a read-only loop ran under a claim while the mission status stayed `done`]
4. **Every agent-facing write exists on both surfaces** (REST `/api/v1/*` and the `mission-hub` MCP server) unless the contract documents otherwise. [DOCUMENTED — AGENT_USAGE.md architecture rules; IMPLEMENTED — 29 MCP tools, 36 REST routes]

## 2. Architecture and behaviour

The autonomous loop, with the ledger status of each step:

```text
discover → eligibility/policy → claim → lease renewal → plan/decompose
        → specialist work → verify → run summary/evidence → release
        → writeback → rescan/resume
```

1. **Discover** — `missions.list` (optional query) / `missions.get`; read checklist, sources, and events for context. Read-only. [OBSERVED — PROOF D: 295 missions listed; a read-only target selected by explicit criteria]
2. **Eligibility / policy** — classify the task against the eligibility table (§3) before any write. This is operator policy applied by the agent, not Hub code. [DOCUMENTED — this guide]
3. **Claim** — `missions.claim` atomically creates the agent session, a `RUNNING` execution run, and the claim in one transaction; one open claim per mission. A second concurrent claim is refused with `claim_conflict` and mutates nothing. [OBSERVED — PROOF D: claim acquired; conflicting claim refused with `claim_conflict`]
4. **Lease renewal** — `missions.claim.renew` heartbeats the owned lease while working. On expiry, the Hub reclaims the claim, diagnoses the owner session/run (never invents a cause), terminalizes a non-terminal previous run (typically `FAILED`), and fences the previous owner. [OBSERVED — PROOF D: expiry, reclaim, `claim.fenced`, and fenced-write refusal reproduced]
5. **Plan / decompose** — break the mission into specialist units; record the execution plan as a `plan_summary` on a `purpose = planning` run. [IMPLEMENTED — typed run purposes and summary types in the inventory]
6. **Specialist work** — execute one scoped unit under the claim (or as a standalone run); update checklist and sources; keep business status accurate with `missions.update`. [OBSERVED — PROOF D: read-only work performed while claimed]
7. **Verify** — check the work against observed evidence, never against the worker's self-report. Independent review stays a separate run (normally `purpose = independent_review`) and may write a `reviewer_validated` summary pointing at the validated report. [IMPLEMENTED — typed purpose/summary in the inventory; DOCUMENTED — AGENT_USAGE.md §6]
8. **Run summary / evidence** — before a successful release, record `runs.recordSummary` + `runs.recordEvidence`. [OBSERVED — PROOF D]
9. **Release** — `missions.claim.release`: `completed` requires ≥1 summary and ≥1 evidence and transitions the run to `COMPLETED` in the same transaction; `failed` / `abandoned` transition the run to `FAILED`. [OBSERVED — PROOF D: release `completed` after summary + evidence]
10. **Writeback** — persist the outcome into the mission (checklist, sources, business status). [OBSERVED — PROOF D: mission events recorded claim acquire/release]
11. **Rescan / resume** — re-list missions and continue with the next eligible unit. [DOCUMENTED — this guide]

### Exception paths

| Condition | Behaviour | Status |
|---|---|---|
| **Claim conflict** | Second claim on a mission with an open claim → `claim_conflict`; no run created, nothing mutated. | OBSERVED — PROOF D |
| **Fencing after lease loss** | Expired claim reclaimed; previous owner's writes refused with `claim_fenced`; renew on the expired claim → `claim_already_released`. | OBSERVED — PROOF D |
| **Failed retry** | A failed unit transitions its run to `FAILED` via release reason `failed`; the claim can then be re-acquired for a retry. | OBSERVED — PROOF D (negative-test runs terminalized `FAILED`) |
| **Release before evidence** | `completed` release without summary + evidence → `claim_release_incomplete {missing:[summary,evidence]}`; the claim stays active. | OBSERVED — PROOF D |
| **Blocked work** | A mission whose durable goal is blocked is set to `blocked` (business state) — never used as an execution lock. | DOCUMENTED — AGENT_USAGE.md §2 |
| **HITL wait** | Work needing a human decision pauses until the human acts; the agent never fabricates the human's answer. | DOCUMENTED — this guide |

## 3. Eligibility and authorization policy

Classification happens before any write. The default posture is least privilege: request only the scopes the task needs (11 exist; see the contract §7).

| Task class | Policy |
|---|---|
| **Read-only** (list/get missions, checklist, sources, events, runs, summaries, evidence, research reports, Jev evaluations) | **Auto-executable by default** with read scopes. |
| **Reversible writes** (create/update missions, checklist, sources; record summaries/evidence; claim/renew/release) | Require a **user-configured allowlist** naming the permitted write surfaces. |
| **Destructive / security / production actions** (client mint/revoke, fixture cleanup, production deploys, schema changes) | Require **explicit human authorization** for each action; never autonomous. |
| **Mission close / merge / delete / reprioritize** | **Never autonomous** — always a human decision. |

Notes:

- The allowlist is operator configuration held by the agent's runtime, not a Hub feature; the Hub enforces only scope-level authorization. [DOCUMENTED — this guide]
- `clients:admin`, `verify:admin`, and `approvals:human` are privileged or mint-forbidden scopes; treat any action needing them as human-only. [DOCUMENTED — AGENT_USAGE.md §7; AUDIT A]
- Destructive verify (`verify:admin` + the allow-destructive-verify env flag) is staging-only and refused on production. [DOCUMENTED — AGENT_USAGE.md §8]

## 4. Evidence and completion rule

1. **Never infer completion from an agent self-report.** An `agent_self_report` summary is a claim, not validated truth; runtime evidence outranks docs and inference for current-state claims. [DOCUMENTED — AGENT_USAGE.md §5–6]
2. **Run completion is not mission business status.** A `COMPLETED` run (and a claim released `completed`) says the execution unit finished; the mission's durable goal state (`mission.status`) is a separate human-facing signal. [DOCUMENTED — AGENT_USAGE.md §2; OBSERVED — PROOF D: run `COMPLETED` while the mission stayed `done`]
3. **Every `completed` release carries ≥1 summary + ≥1 evidence**; the Hub refuses the release otherwise (`claim_release_incomplete`). [OBSERVED — PROOF D]
4. **Research reports are run-owned artifacts**, canonicalized by recency (`research.getCanonicalReport` returns the newest `research_report` on a `purpose = research` run); older reports stay visible and supersession is provenance, not deletion. [IMPLEMENTED — research tools in the inventory; DOCUMENTED — AGENT_USAGE.md §6]

## 5. Getting started

### Connect (MCP)

The MCP server `mission-hub` is served at the streamable-HTTP endpoint `/mcp` — one endpoint, all 29 tools. Authenticate with a Bearer token held in an environment variable, never inline in prompts or commits:

```bash
curl -N http://<HOST>:3000/mcp \
  -H "Authorization: Bearer $MISSION_HUB_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}'
```

The dual `Accept` header is required — streamable HTTP rejects a request that does not advertise both `application/json` and `text/event-stream` (see §6). The token is an env-issued client credential: the server loads clients from `MISSION_HUB_CLIENTS_JSON`; the client side holds the matching token in its own environment. [IMPLEMENTED — `src/app.ts` `/mcp`; `src/auth/config.ts`]

### Capabilities checklist

Confirm the surfaces before planning work. Counts come from the machine inventory, never prose:

| Surface | Count | Source of truth |
|---------|-------|-----------------|
| MCP tools | **29** | `registerTool(` in `src/mcp/server.ts` |
| HTTP routes | **36** | `src/app.ts` — 33 REST under `/api/v1`, plus `/health`, `/ready`, `/mcp` |
| Scopes | **11** | `src/auth/config.ts` |
| Run purposes | **12** | `docs/contract-inventory.json` |
| Summary types | **7** | `docs/contract-inventory.json` |
| Evidence source types | **7** | `docs/contract-inventory.json` |

[IMPLEMENTED — `docs/contract-inventory.json`]

### Minimal authorization policy

Request only the scopes the task needs. The 11 scopes, grouped:

- **Read** — `missions:read`, `runs:read`, `summaries:read`, `evidence:read`
- **Write** — `missions:write`, `runs:write`, `summaries:write`, `evidence:write`
- **Privileged / human-only** — `clients:admin` (mint/revoke), `verify:admin` (staging-only destructive verify), `approvals:human` (record plan approvals)

`clients:admin`, `verify:admin`, and `approvals:human` are mint-forbidden through the admin API; treat any action that needs them as human-only. The Hub enforces scope-level authorization only — the write allowlist is operator configuration held by the agent's runtime (§3). [DOCUMENTED — AGENT_USAGE.md §7; IMPLEMENTED — `src/auth/config.ts`]

### Bootstrap

Copy [`docs/BOOTSTRAP_PROMPT.md`](BOOTSTRAP_PROMPT.md) into the agent's first turn. It is runtime-neutral: it fixes the role, the loop rules, the evidence rule, and the stop conditions, and it carries no host, token, or mission id.

### Read-only pilot recipe

Prove the connection and the read path before any write:

1. `missions.list` — the Hub is reachable and the token resolves.
2. `missions.get` + `missions.checklist.list` + `missions.sources.list` + `missions.events.list` — one mission read end-to-end.
3. `runs.list` + `runs.listSummaries` + `runs.listEvidence` — the execution-trace graph.
4. Stop. No claim, no write.

A read-only pilot is auto-executable by default (§3). [OBSERVED — PROOF D: read-only loop over 295 missions, checklist, sources, events, runs, summaries, evidence]

### Scheduler / resume pattern

Mission Hub has no always-on processor. A continuous loop needs an external driver (cron, n8n, a long-lived agent runtime) that:

1. Calls `missions.list` on a schedule.
2. Applies the eligibility table (§3) to each candidate.
3. Claims the next eligible unit (`missions.claim`) and heartbeats the lease (`missions.claim.renew`) at an interval below the lease — default 300 s, max 3600 s.
4. Records summary + evidence, then releases (`missions.claim.release`).
5. On the next tick, rescans and resumes with the next eligible unit.

If a run is missed, the claim expires and the Hub reclaims it (§2, expiry/reclaim/fencing); the driver's next tick re-discovers the unit. This pattern is documented, not proven — see §7.5. [DOCUMENTED — this guide; IMPLEMENTED — claim/lease in `src/db/store.ts`]

### Verification

Check work against observed evidence, never against the worker's self-report (§4). Independent review is a separate run — normally `purpose = independent_review` — and may write a `reviewer_validated` summary pointing at the validated report. Role definitions: [`docs/AGENT_ROLES.md`](AGENT_ROLES.md). [IMPLEMENTED — typed purpose/summary in the inventory; DOCUMENTED — AGENT_USAGE.md §6]

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Not Acceptable` on `/mcp` | Missing dual `Accept` header | Send `Accept: application/json, text/event-stream` |
| `403 forbidden [approvals:human]` | Expected — the scope is mint-forbidden and unreachable by any available credential | Plan approval is recorded by a human principal, not by the agent (§7.1) |
| `claim_conflict` | Another claim is open on the mission | Wait for the other claim to release/expire, or pick another mission |
| `claim_fenced` | This owner's lease expired and was reclaimed | Stop writing; re-claim if the unit is still eligible |
| `claim_release_incomplete` | `completed` release without ≥1 summary + ≥1 evidence | Record `runs.recordSummary` + `runs.recordEvidence`, then release again |
| `claim_already_released` | Renew/release on an already-released claim | Re-acquire with a fresh `missions.claim` |
| Host-header rejection | The `/mcp` endpoint validates the `Host` header against an allowlist | Send the `Host` the server expects (its own host, not a proxy's) |
| HTTP 200 with `isError: true` | Tool-level errors return 200 + `isError`, not 4xx | Read `content[0].text` for the `{ error, ... }` payload |

Error payloads are JSON in `content[0].text` with an `error` code and context fields (e.g. `claim_conflict { missionId, claimId }`). [IMPLEMENTED — `src/mcp/server.ts`]

## 7. Known limitations (contract v1.2)

These are the honest gaps at contract v1.2. None of them is worked around in this guide.

1. **Plan approval is recorded, not enforced — and currently unreachable.** The `approvals:human` scope is mint-forbidden and dropped from every available auth path, so no credential today can call `missions.planApproval` (observed: MCP `forbidden [approvals:human]`, REST 403). Plan approval is a recorded-intent surface, not an enforced gate. [OBSERVED — PROOF D; AUDIT A]
2. **The summary surface is unguarded.** `runs.recordSummary` accepts `type = "plan_approval"` with only `summaries:write` — no `approvals:human`, no `plan_not_open`, no `self_approval` guard — so an agent can write a human-approval row through the summary surface. This contradicts the contract sentence "written only through the `approvals:human` endpoint" and is tracked as a separate fix mission. [OBSERVED — PROOF D]
3. **No enforced stage gate at contract v1.2.** `missions.stage` (5-stage lifecycle) is record/read only; no code path blocks a run, claim, or transition on stage, and `stage` is not in the REST/MCP mission payload. [DOCUMENTED — AGENT_USAGE.md §12; AUDIT A]
4. **Jev gate is record/read only.** `jev.listEvaluations` / `jev.getGateStatus` serve recorded `jev_decision` summaries; the gate itself is v2.0. [DOCUMENTED — AGENT_USAGE.md §13]
5. **Scheduler/resume after a missed run is untested.** The documented pattern (external driver + claim/lease) has no missed-run recovery evidence; do not assume always-on processing or automatic resume. [DOCUMENTED — AUDIT C; UNTESTED]
6. **Run-level events are not in mission events.** `run.created`, `run.summary_recorded`, `claim.fenced`, etc. surface only via `runs.listEvents`; `missions.events.list` shows claim acquire/expire/release and mission updates only. [OBSERVED — PROOF D]
7. **No native autonomy loop in the mainstream CLIs.** Claude Code, Codex, and OpenCode are one-shot headless runtimes; an external driver is required for a continuous loop. [DOCUMENTED — AUDIT B]
8. **Staging is not a usable verification path** (unreachable with available credentials); no staging-verified claim is made anywhere in this kit. [OBSERVED — PROOF D; AUDIT A]
