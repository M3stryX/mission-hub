# Agent Roles

Runtime-neutral role definitions for autonomous agent workflows against Mission Hub. A role is a set of duties and prohibitions, not a credential — any runtime can play any role, and the credential's scopes decide what the role may actually write. The contract ([`docs/AGENT_USAGE.md`](AGENT_USAGE.md), contract revision v2.0) owns all semantics and the behaviour reference ([`docs/AUTONOMOUS_AGENTS.md`](AUTONOMOUS_AGENTS.md)) owns the policy; if this file disagrees with either, they win.

## Mission Supervisor

The driver of the loop. One supervisor per mission (or per mission batch).

- **Purpose** — move eligible missions through the loop: discover, classify, claim, decompose, dispatch, aggregate, release, writeback, rescan.
- **Required tool surface** — `missions.list`, `missions.get`, `missions.claim`, `missions.claim.renew`, `missions.claim.release`, `missions.update`, `missions.events.list`, `runs.list`, `runs.listSummaries`, `runs.listEvidence`, `research.listReports`, `research.getCanonicalReport`.
- **Lifecycle duties** — apply the eligibility table before any write; claim before exclusive work; heartbeat the lease; record summary + evidence before a `completed` release; keep `mission.status` accurate; rescan after each unit.
- **Exit conditions** — the mission's durable goal is `done`/`blocked`, or no eligible unit remains.
- **Prohibitions** — never close, merge, delete, or reprioritize a mission; never fabricate a human's answer to a HITL wait; never treat `mission.status` as a lock.

## Mission Worker

One scoped unit of work, executed under a claim (or as a standalone run).

- **Purpose** — execute exactly one unit: the thing the supervisor claimed or scheduled.
- **Required tool surface** — `missions.get`, `missions.checklist.list` / `missions.checklist.add` / `missions.checklist.update`, `missions.sources.list` / `missions.sources.add`, `missions.update`, `runs.recordSummary`, `runs.recordEvidence`, `missions.claim.release`.
- **Lifecycle duties** — read the unit's context first; do the scoped work; update checklist and sources; record a typed summary + evidence; release the claim (`completed` with evidence, or `failed`).
- **Exit conditions** — the unit is done (summary + evidence recorded, claim released) or failed (claim released `failed`).
- **Prohibitions** — never author the reviewer's summary; never release `completed` without evidence; never work outside the claimed unit.

## Independent Reviewer (optional)

A separate run that validates the worker's output against observed evidence.

- **Purpose** — verify, not execute. Answer: does the evidence support the claim?
- **Required tool surface** — `missions.get`, `runs.list`, `runs.listSummaries`, `runs.listEvidence`, `missions.events.list`, `runs.recordSummary` (type `reviewer_validated`).
- **Lifecycle duties** — read the unit's claimed output and its evidence; re-check current state against runtime evidence, not the worker's self-report; write a `reviewer_validated` summary whose metadata points at the validated report (`validatesSummaryId`) or record the rejection.
- **Exit conditions** — a `reviewer_validated` summary is recorded, or the rejection is recorded with evidence.
- **Prohibitions** — never review work this run authored; never hold the claim on the mission under review; never treat an `agent_self_report` as validated truth.

## Scope ceiling per role

| Role | Read scopes | Write scopes | Never |
|------|-------------|--------------|-------|
| Supervisor | `missions:read`, `runs:read`, `summaries:read`, `evidence:read` | `missions:write`, `runs:write`, `summaries:write`, `evidence:write` | `clients:admin`, `verify:admin`, `approvals:human` |
| Worker | `missions:read`, `runs:read`, `summaries:read`, `evidence:read` | `missions:write`, `runs:write`, `summaries:write`, `evidence:write` | `clients:admin`, `verify:admin`, `approvals:human` |
| Reviewer | `missions:read`, `runs:read`, `summaries:read`, `evidence:read` | `summaries:write` (review artifacts only) | `missions:write`, `runs:write`, `evidence:write`, `clients:admin`, `verify:admin`, `approvals:human` |

The Hub enforces scope-level authorization only; the write allowlist is operator configuration held by the agent's runtime. [DOCUMENTED — AGENT_USAGE.md §7; IMPLEMENTED — `src/auth/config.ts`]
