# Mission Hub

Standalone **mission + execution-trace** service for agent workflows. Mission Hub is the durable SSOT for missions, claims, runs, summaries and evidence — agents (Cursor, OpenCode, Hermes/Lyra, DSH/Vega, n8n) read and write the same operational truth through two parity surfaces: REST and MCP.

- **Durable missions** — business state (`backlog`…`done`/`blocked`), checklist, sources, append-only events.
- **Claims / leases** — temporary exclusive ownership with heartbeat, expiry reclaim and fencing. `mission.status` is never a lock.
- **Runs** — transient execution runs per client/agent, optionally typed by purpose (`research`, `implementation`, `architecture`, `planning`, `jev_gate`, …).
- **Summaries & evidence** — typed run artifacts (`research_report`, `plan_summary`, `plan_approval`, `jev_decision`, …) with provenance metadata and evidence references.

*Mission Hub 0.1.0 — agent contract revision v2.0.* The product version is `0.1.0`; `v2.0` is the agent contract/schema revision.

REST ↔ MCP parity is enforced: every agent-facing read/write exists on both surfaces unless documented otherwise. The machine inventory (`src/contract/inventory.ts` → `docs/contract-inventory.json`) tracks enums, scopes, tables, routes and MCP tools; `pnpm test:contract-inventory` (and CI) fail on drift.

## Requirements

- **Node.js 22 or newer** (`engines.node` in `package.json`).
- **pnpm 9.12** (`packageManager` in `package.json`; Corepack can provide that pinned version).
- **PostgreSQL 17** — a disposable local instance is enough for development; CI uses `postgres:17-alpine`.

## Installation

### 1. Local development (pnpm)

```bash
pnpm install --frozen-lockfile
cp .env.example .env          # every value in that file is a placeholder: replace DATABASE_URL and the tokens

# `pnpm db:migrate` reads DATABASE_URL from the process environment — it does not load .env
export DATABASE_URL='postgres://user:REPLACE_ME@localhost:5432/mission_hub'
pnpm db:migrate               # apply versioned SQL migrations from migrations/

pnpm dev                      # tsx watch on http://localhost:3000
curl http://localhost:3000/health   # → {"status":"ok"}
curl http://localhost:3000/ready    # → {"status":"ready"}, or 503 {"status":"not_ready"} when the database is unreachable
```

Compiled entry point (same server, no watcher):

```bash
pnpm build
pnpm start
```

Where the configuration comes from: `pnpm dev`, `pnpm start` and `pnpm clients` load `.env`; `pnpm db:migrate` and `pnpm legacy:import` read `DATABASE_URL` from the process environment; `pnpm legacy:export` takes its paths as arguments. Migrations also run automatically on boot, so the explicit migration step is only needed to prepare a database without starting the server.

The server answers only on the host names listed in `MISSION_HUB_ALLOWED_HOSTS`: a request carrying any other `Host` header is refused with `403`. The built-in default is loopback only (`localhost`, `127.0.0.1`), so every deployed stage sets the variable — and refuses to boot without it.

### 2. Docker image

The repository `Dockerfile` builds a two-stage Node 22 Alpine image; the runtime stage carries the compiled server and `migrations/`, and applies pending migrations on boot.

```bash
docker build -t mission-hub .
docker run --rm -p 3000:3000 --env-file .env mission-hub
curl http://localhost:3000/health
```

- The container listens on `HOST`/`PORT` (`0.0.0.0:3000` by default) and exposes port `3000`.
- `DATABASE_URL` has to be reachable from inside the container: point it at a host name or IP, never `localhost` (inside the container, `localhost` is the container itself).
- The image declares a container `HEALTHCHECK` that probes `/health` on `$PORT` (30s interval, 5s timeout, 15s start period, 3 retries), so Docker reports the container state directly:

```bash
docker inspect --format '{{.State.Health.Status}}' <container>   # starting → healthy
```

- The process is fail-fast on the database: migrations run before the HTTP listener starts, so a container whose database is unreachable exits instead of serving traffic.

### 3. Dokploy (branch → environment variables)

Production and staging are Dokploy applications that build the repository `Dockerfile` for the branch configured on the application:

| Application | Branch | Public host |
|-------------|--------|-------------|
| `mission-hub` | `main` | `mission-hub.lan` |
| `mission-hub-staging` | `staging` | `mission-hub-staging.lan` |

Deployment is branch-driven (`feature/* → dev → staging → main`, see Contributing); no build command and no port override are needed, because the image reads `PORT` and `HOST` from the environment. Each application needs its own values for:

- `DATABASE_URL` — that application's PostgreSQL database.
- `MISSION_HUB_ADMIN_TOKEN` — a distinct bootstrap admin Bearer per application.
- `MISSION_HUB_ALLOWED_HOSTS` — the host names the application must answer on (its public domain and internal name), otherwise requests are refused with `403`. Required outside development: a stage that leaves it unset refuses to boot.
- `MISSION_HUB_STAGE` — `staging` or `production` for a deployed application; leave it unset for local work.
- `MISSION_HUB_CLIENTS_JSON` — optional seeded clients.
- `MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY` — must stay `false` outside staging.

Those values belong in the platform's secret store: never commit them and never paste them into CI logs, PR bodies, chat or memory.

## Configuration

Environment variables (see `.env.example`; the committed values are placeholders):

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | — (required) | PostgreSQL connection string. The server, `pnpm db:migrate` and the legacy tooling fail fast without it. |
| `PORT` | `3000` | HTTP listen port. |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `MISSION_HUB_ALLOWED_HOSTS` | loopback only (`localhost`, `127.0.0.1`) | Comma-separated exact host names accepted in the `Host` header; entries are trimmed, empty ones dropped, ports ignored. The code ships **no deployment topology**: a deployed stage sets this variable to the names it is served on, and the server refuses to boot when a non-development stage leaves it unset or empty. Any other host is answered with `403`. No wildcards, no regex. |
| `MISSION_HUB_STAGE` | `development` | `staging` or `production` for a deployed application; any other value (including unset) is `development`. Decides whether the Host allowlist is mandatory at boot and whether `DELETE /api/v1/admin/verify-fixtures/:missionId` is reachable. |
| `MISSION_HUB_ADMIN_TOKEN` | — | Bootstrap admin Bearer for `/api/v1/admin/clients` (create/list/revoke). Never grant it to a service client. |
| `MISSION_HUB_CLIENTS_JSON` | — | Optional seed/fallback clients, upserted hashed on boot. `verify:admin` can only be seeded this way — it cannot be minted through the admin API. |
| `MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY` | `false` | Staging-only: enable `DELETE /api/v1/admin/verify-fixtures/:missionId` (requires the `verify:admin` scope and `MISSION_HUB_STAGE=staging`). |

Admin clients are minted with `pnpm clients create <clientId> --scopes <scope,scope>`, listed with `pnpm clients list` and revoked with `pnpm clients revoke <clientId>`; the same operations exist as `POST`, `GET` and `POST /api/v1/admin/clients/:clientId/revoke`. The privileged `approvals:human` and `verify:admin` scopes cannot be minted through the admin API.

## Mission lifecycle

Missions move through a 5-stage lifecycle (`missions.stage`, exposed in the mission payload at contract v2.0 — gate enforcement is still to come):

```text
research → architecture (Jev gate) → plan (mandatory human approval) → execution → done
```

1. **Research** — `purpose = research` run; the canonical `research_report` summary + evidence proves the stage.
2. **Architecture / Jev gate** — `purpose = architecture` run records a `jev_decision` summary (with Jev evidence on a `jev_gate` run). At contract v2.0 the Hub stores and serves evaluations; it does not evaluate or block.
3. **Plan** — `purpose = planning` run writes a `plan_summary`; a **human** principal (never the plan author) records `plan_approval` via `POST /api/v1/missions/:id/plan-approval` / `missions.planApproval` (scope `approvals:human`).
4. **Execution** — exclusive work runs under a claim: `missions.claim` (atomic session + run + claim) → heartbeat with `missions.claim.renew` → report with `runs.recordSummary` + `runs.recordEvidence` → `missions.claim.release` (`completed` requires summary + evidence and terminalizes the run `COMPLETED`; `failed`/`abandoned` terminalize `FAILED`).
5. **Done** — checklist complete and run `COMPLETED`; business status closed with `missions.update` → `done`.

Full contract: [`docs/AGENT_USAGE.md`](docs/AGENT_USAGE.md) (contract revision v2.0, authoritative over skills).

## Autonomous Agent Workflows

Mission Hub ships a runtime-agnostic [Autonomous Agent Kit](docs/AUTONOMOUS_AGENTS.md) for agents that drive missions end-to-end: discover → claim → work → verify → release → writeback → resume.

- **Proven:** the read-only loop (list → get → checklist/sources/events → runs/summaries/evidence) ran end-to-end on a live instance.
- **Not proven:** no enforced approval gate at contract v2.0 (plan approval is recorded, not enforced), no scheduler-recovery evidence, and no native autonomy loop in the mainstream CLIs (Claude Code, Codex, OpenCode are one-shot; an external driver is required).
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
    └── server.ts       # MCP server `mission-hub` — REST-parity surface
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
pnpm legacy:export <legacy.sqlite> <bundle.json>   # read-only export of the legacy SQLite DB
pnpm db:migrate                                    # on the fresh Mission Hub Postgres database
pnpm legacy:import <bundle.json>                   # transactional import of the JSON bundle
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
- License: MIT — see [`LICENSE`](LICENSE)
