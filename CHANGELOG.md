# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Boot diagnostics** — the process prints one startup line naming the
  configuration it is actually running with
  (`env=… allowed_hosts=… db=host:port/dbname`), and the initial migration run
  is retried inside a bounded window (`MISSION_HUB_DB_RETRY_WINDOW_MS`, default
  25s) so a database that starts *after* the application no longer kills it.
  When the window is exhausted the process exits `1` behind a single
  `fatal: migrations failed: <cause>: <host>:<port>/<dbname>` line. No
  credential ever reaches the log.

### Changed
- **`plan_approval` summaries require `approvals:human`** — the generic summary writers (REST `POST /api/v1/runs/:id/summaries` and MCP `runs.recordSummary`) now refuse `type = "plan_approval"` without that scope, mirroring the dedicated plan-approval endpoint. `plan_not_open` and `self_approval` are still not enforced on the generic path.

- **Boot line names the host allowlist instead of counting it** —
  `allowed_hosts=2` becomes `allowed_hosts=mission-hub.lan,…`, and the database
  target is added to the same line.
## [3.0.0] - 2026-10-12

### Changed

- **Refusal vocabulary (contract v3.0)** — a request is now refused by *why*, so
  `401` no longer also means "insufficient scope":
  - `403 {"error":"insufficient_scope","required":[…]}`, with `required` naming
    exactly the scopes the route lacked (not its whole requirement list), when
    the credential is VALID but under-scoped. This replaces the
    `401 {"error":"unauthorized"}` all 34 REST call sites used to return.
  - `401 {"error":"unauthorized"}` is reserved for no credential presented, or a
    token that resolves to no env client, no admin token and no active
    `api_clients` row (unknown or revoked).
  - `400 {"error":"invalid_authorization"}` when an `Authorization` header is
    presented but is not a `Bearer <token>` credential.
  A consumer that tested `status === 401` to detect a bad token must now read it
  as an unknown credential only — a MAJOR change, hence contract `v2.0` →
  `v3.0`. The revision was arbitrated by a **delegated Jev evaluation**
  (`jev-1.13.0`, 2026-10-12, MAJOR, probability 0.82, confidence 0.73), not by
  an operator order. The product version stays `0.1.0`; `v3.0` is the agent
  contract/schema revision.

### Fixed

- **Host policy no longer speaks JSON-RPC on REST routes** — a refused `Host`
  answered `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: …"},
  "id":null}` on `/health`, `/ready`, `/` and every `/api/*` route, because the
  envelope came from the MCP Hono middleware. REST now answers
  `403 {"error":"invalid_host","host":"…"}`; `/mcp` keeps the JSON-RPC envelope,
  which is its own transport's error shape (REST⇄MCP parity is required for
  writable surfaces, not for transport error shapes).
- **Silently dropped client scopes are now named at boot** — a scope that is not
  a known scope, or is privileged (admin-token only), was filtered out of
  `MISSION_HUB_CLIENTS_JSON` without a word, leaving an operator unable to tell
  a typo from a boot that overwrote an existing client. Boot now logs
  `[mission-hub] client=<id> scopes=<n> dropped=<scope>(<reason>),…` for every
  client that lost a scope, and nothing for clients that lost none.

## [2.0.0] - 2026-10-09

### Added

- **Expose mission stage (v2.0)** — `missions.stage` is now part of the
  REST/MCP mission payload: read from `missions.get` / `missions.list`,
  set at create, and patchable via `missions.update` (REST + MCP). The
  contract revision bumps from v1.2 to v2.0 (response shape change).
  Stage transitions remain unguarded — enforcement is still to come.

## [0.1.0] - 2026-10-08

### Added

- **MVP release** — Mission Hub 0.1.0 launches the standalone mission +
  execution-trace service (Hono + PostgreSQL): durable missions, claims
  (lease-based ownership), runs, events, summaries and evidence over two
  parity surfaces (REST + MCP). *Mission Hub 0.1.0 — contract revision 1.2*:
  the product version (`0.1.0`) and the agent contract/schema revision
  (`v1.2`) are now labelled distinctly. The MCP server version is read from
  `package.json` (single authoritative source) instead of a hard-coded literal.

## [1.2.0] - 2026-10-08

### Added

- **Lifecycle gates (v1.2)** — mission stage, plan approval, and Jev gate
  surface. Missions move through a 5-stage lifecycle
  (`research → architecture (Jev gate) → plan → execution → done`). At v1.2
  the Hub records and serves Jev evaluations; enforcement is deferred to
  v2.0. Commit `1ea35c1`, PR #7 (promoted to `main` via PR #8).
- **CI on `dev`** — the verify workflow now triggers on `dev` (PRs and
  pushes), and `AGENTS.md` reflects the 3-branch flow
  (`feature/* → dev → staging → main`). Commit `e91e3fa`, PR #9.
- **Real v1 README + contract coherence** — README replaced with a complete
  v1 overview (surfaces, quick start, lifecycle, architecture, migration,
  contributing); contract inventory links aligned to v1.2 in
  `docs/contract-inventory.json` and `src/contract/inventory.ts`. Commit
  `5d13c23`, PR #10.
- **Autonomous agent kit behaviour reference (W1)** — `docs/AUTONOMOUS_AGENTS.md`
  added: behaviour reference and policy core (authority chain, autonomous
  loop with per-step evidence status, exception paths, eligibility). Commit
  `d116c1a`, PR #11.
