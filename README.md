# Mission Hub

Standalone **mission + execution-trace** service for agent workflows. Mission Hub is the durable SSOT for missions, claims, runs, summaries and evidence — agents (Cursor, OpenCode, Hermes/Lyra, DSH/Vega, n8n) read and write the same operational truth through two parity surfaces: REST and MCP.

- **Durable missions** — business state (`backlog`…`done`/`blocked`), checklist, sources, append-only events.
- **Claims / leases** — temporary exclusive ownership with heartbeat, expiry reclaim and fencing. `mission.status` is never a lock.
- **Runs** — transient execution runs per client/agent, optionally typed by purpose (`research`, `implementation`, `architecture`, `planning`, `jev_gate`, …).
- **Summaries & evidence** — typed run artifacts (`research_report`, `plan_summary`, `plan_approval`, `jev_decision`, …) with provenance metadata and evidence references.

## Surfaces (measured at write time)

| Surface | Count | Source of truth |
|---------|-------|-----------------|
| MCP tools | **29** | `registerTool(` in `src/mcp/server.ts` |
| HTTP routes | **36** | `app.get\|post\|patch\|delete\|put\|all(` in `src/app.ts` (33 REST under `/api/v1`, plus `/health`, `/ready` and the `/mcp` endpoint) |
| Agent contract | **v2.0** (contract revision) | `docs/AGENT_USAGE.md` (`Contract-Version: v2.0`) |

*Mission Hub 0.1.0 — contract revision 2.0.* The product version is `0.1.0`; `v2.0` is the agent contract/schema revision.

REST ↔ MCP parity is enforced: every agent-facing read/write exists on both surfaces unless documented otherwise. The machine inventory (`src/contract/inventory.ts` → `docs/contract-inventory.json`) tracks enums, scopes, tables, routes and MCP tools; `pnpm test:contract-inventory` (and CI) fail on drift.

## Quick start

```bash
pnpm install --frozen-lockfile
cp .env.example .env          # edit DATABASE_URL (Postgres), tokens
pnpm db:migrate               # apply versioned SQL migrations from migrations/
pnpm dev                      # tsx watch — or: pnpm build && pnpm start
curl http://localhost:3000/health   # → {"status":"ok"}
curl http://localhost:3000/ready    # → DB readiness probe
```

Key environment variables (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `PORT` / `HTTP` | Listen port (default `3000`) / host (default `0.0.0.0`) |
| `MISSION_HUB_ADMIN_TOKEN` | Bootstrap admin Bearer for `/api/v1/admin/clients` (mint/revoke) |
| `MISSION_HUB_CLIENTS_JSON` | Optional seed/fallback clients, upserted hashed on boot |
| `MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY` | Staging-only: allow `verify:admin` fixture cleanup |

Migrations also run automatically on boot. Admin clients are minted with `pnpm clients` (or `POST /api/v1/admin/clients`); the privileged `approvals:human` and `verify:admin` scopes cannot be minted through the admin API.

## Mission lifecycle

Missions move through a 5-stage lifecycle (`missions.stage`, exposed in the mission payload at contract v2.0 — gate enforcement is still to come):

```text
research → architecture (Jev gate) → plan (mandatory human approval) → execution → done
```

1. **Research** — `purpose = research` run; the canonical `research_report` summary + evidence proves the stage.
2. **Architecture / Jev gate** — `purpose = architecture` run records a `jev_decision` summary (with Jev evidence on a `jev_gate` run). At contract v1.2 the Hub stores and serves evaluations; it does not evaluate or block.
3. **Plan** — `purpose = planning` run writes a `plan_summary`; a **human** principal (never the plan author) records `plan_approval` via `POST /api/v1/missions/:id/plan-approval` / `missions.planApproval` (scope `approvals:human`).
4. **Execution** — exclusive work runs under a claim: `missions.claim` (atomic session + run + claim) → heartbeat with `missions.claim.renew` → report with `runs.recordSummary` + `runs.recordEvidence` → `missions.claim.release` (`completed` requires summary + evidence and terminalizes the run `COMPLETED`; `failed`/`abandoned` terminalize `FAILED`).
5. **Done** — checklist complete and run `COMPLETED`; business status closed with `missions.update` → `done`.

Full contract: [`docs/AGENT_USAGE.md`](docs/AGENT_USAGE.md) (contract revision v2.0, authoritative over skills).

## Autonomous Agent Workflows

Mission Hub ships a runtime-agnostic [Autonomous Agent Kit](docs/AUTONOMOUS_AGENTS.md) for agents that drive missions end-to-end: discover → claim → work → verify → release → writeback → resume.

- **Proven:** the read-only loop (list → get → checklist/sources/events → runs/summaries/evidence) ran end-to-end on a live instance.
- **Not proven:** no enforced approval gate at contract v1.2 (plan approval is recorded, not enforced), no scheduler-recovery evidence, and no native autonomy loop in the mainstream CLIs (Claude Code, Codex, OpenCode are one-shot; an external driver is required).
- Kit: [behaviour reference](docs/AUTONOMOUS_AGENTS.md) · [agent roles](docs/AGENT_ROLES.md) · [bootstrap prompt](docs/BOOTSTRAP_PROMPT.md) · [runtime adapters](docs/RUNTIME_ADAPTERS.md)
- Non-goals: mission close/merge/delete/reprioritize are never autonomous; destructive and production actions need explicit human authorization.

## Architecture

```text
src/
├── index.ts            # Entry point: migrations on boot, env-client seeding, HTTP server
├── app.ts              # Hono app — all REST routes, /mcp endpoint, auth wiring
├── auth/
│   ├── config.ts       # Scopes, admin token, client credential loading
│   └── resolve.ts      # Principal resolution (Bearer → client, privileged-scope rules)
├── contract/
│   └── inventory.ts    # Machine contract: enums, scopes, tables, routes, MCP tools
├── db/
│   ├── store.ts        # MissionHubStore — all persistence + claim/run transaction rules
│   └── migrate.ts      # Versioned SQL migration runner
└── mcp/
    └── server.ts       # MCP server `mission-hub` — 29 tools, REST-parity surface
scripts/
├── migrate.ts          # pnpm db:migrate
├── clients.ts          # pnpm clients — admin client mint/list helpers
├── import-legacy.ts    # pnpm legacy:import — transactional legacy JSON import
└── export-legacy-sqlite.py  # pnpm legacy:export — read-only legacy SQLite export
migrations/             # Versioned SQL (applied on boot and via pnpm db:migrate)
tests/                  # Vitest suite + contract-inventory drift gate
docs/                   # AGENT_USAGE.md, contract-inventory.json, migration.md
```

## Migration from legacy Piblox Missions

Migration tooling exists and is the supported path (see [`docs/migration.md`](docs/migration.md)):

```bash
pnpm legacy:export     # read-only export of the canonical legacy SQLite DB → JSON bundle
pnpm db:migrate        # on the fresh Mission Hub Postgres database
pnpm legacy:import     # transactional import of the JSON bundle
```

The path is one-way and evidence-driven; `tests/fixtures/legacy-export.json` covers the import. Large execution artifacts stay outside the database — Mission Hub stores durable evidence references and bounded metadata.

## Contributing

Branch flow:

```text
feature/*  →  dev  →  staging  →  main
```

- Feature PRs target **`dev`**; never commit or push straight to `main`.
- Promote `dev` → `staging` → `main` only after verification at each step.
- Conventional commits (`feat:`, `fix:`, `docs:`, …). English only in repo artifacts.
- Before proposing a commit or PR:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:contract-inventory
```

## Non-goals

- Using `mission.status` as a lock or lease (use claims).
- Vector search (deferred — Postgres full-text `simple` configuration only).
- External authentication (deferred — hashed API clients + admin Bearer today).
- Jev gate enforcement and stage-transition guards (still to come — contract v2.0 exposes `stage` read/write but does not enforce transitions).
- Putting secrets, tokens or passwords in chat, commits or memory.

## Docs & license

- Agent contract: [`docs/AGENT_USAGE.md`](docs/AGENT_USAGE.md) (contract revision v2.0)
- Machine inventory: [`docs/contract-inventory.json`](docs/contract-inventory.json)
- Legacy migration: [`docs/migration.md`](docs/migration.md)
- Agent guide: [`AGENTS.md`](AGENTS.md)
- License: see `LICENSE` (added in the licensing follow-up — mission #303 PR 3).
