# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
