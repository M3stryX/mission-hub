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

- **Boot line names the host allowlist instead of counting it** —
  `allowed_hosts=2` becomes `allowed_hosts=mission-hub.lan,…`, and the database
  target is added to the same line.

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
