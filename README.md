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
curl http://localhost:3000/health   # → {"status":"ok","version":"0.1.0","contract":"v2.0","commit":"unknown","env":"development"}
curl http://localhost:3000/ready    # → {"status":"ready"}, or 503 {"status":"not_ready"} when the database is unreachable
```

**Which code is answering.** `GET /health` also reports the build identity: `version` (read from `package.json`), `contract` (the agent contract revision), `commit` (the commit the running build was made from) and `env`. Compare it with the revision you expect — the check that catches a redeploy which served a cached image, since a stale image keeps reporting its old `commit`:

```bash
curl -s http://localhost:3000/health    # → {"status":"ok","version":"0.1.0","contract":"v2.0","commit":"<sha>","env":"staging"}
git rev-parse HEAD                      # the revision you expected to be serving
```

`commit` is `unknown` when the build was given none — never a guessed revision.

Compiled entry point (same server, no watcher):

```bash
pnpm build
pnpm start
```

Where the configuration comes from: `pnpm dev`, `pnpm start` and `pnpm clients` load `.env`; `pnpm db:migrate` and `pnpm legacy:import` read `DATABASE_URL` from the process environment; `pnpm legacy:export` takes its paths as arguments. Migrations also run automatically on boot, so the explicit migration step is only needed to prepare a database without starting the server.

The server answers only on the host names listed in `MISSION_HUB_ALLOWED_HOSTS`: a request carrying any other `Host` header is refused with `403`. Loopback (`127.0.0.1`, `localhost`) is always accepted and never needs listing — the container probes its own liveness over loopback. The variable is therefore exactly the names the deployment is served on, and the built-in default is loopback only, so every deployed environment sets it — and refuses to boot without it.

The first line the process prints names the configuration it is actually running with:

```text
[mission-hub] env=production allowed_hosts=mission-hub.lan db=postgres:5432/mission_hub
```

Environment, the host names the request guard applies (the list, not a count), and the database target (`host:port/dbname`) — never the credentials. Read that line before anything else: a log that stops after it is a database that never came up, and the line that follows says why.

### 2. Docker image

The repository `Dockerfile` builds a two-stage Node 22 Alpine image; the runtime stage carries the compiled server and `migrations/`, and applies pending migrations on boot.

```bash
# bake the revision into the image so GET /health can be compared with it
docker build --build-arg MISSION_HUB_COMMIT="$(git rev-parse HEAD)" -t mission-hub .
docker run --rm -p 3000:3000 --env-file .env mission-hub
curl http://localhost:3000/health
```

- The container listens on `HOST`/`PORT` (`0.0.0.0:3000` by default) and exposes port `3000`.
- The image bakes its build identity: `--build-arg MISSION_HUB_COMMIT=<sha>` is what `GET /health` reports as `commit` (CI passes `github.sha`). A build that passes no argument serves `unknown`, and a redeploy that served a stale cached image keeps reporting its previous `commit` — which is how you tell one from a fresh build.
- `DATABASE_URL` has to be reachable from inside the container: point it at a host name or IP, never `localhost` (inside the container, `localhost` is the container itself).
- The image declares a container `HEALTHCHECK` that probes `/health` on `$PORT` (30s interval, 5s timeout, 15s start period, 3 retries), so Docker reports the container state directly:

```bash
docker inspect --format '{{.State.Health.Status}}' <container>   # starting → healthy
```

- The process is fail-safe on the database rather than fail-fast: migrations run before the HTTP listener starts, and a database that is not up yet is retried inside a bounded window (`MISSION_HUB_DB_RETRY_WINDOW_MS`, default 25s) so the application survives a database that starts *after* it. When the window runs out the container exits `1` behind exactly one line, which is the one to read when a deployment "succeeds" but never answers:

```text
[mission-hub] fatal: migrations failed: connect ECONNREFUSED 127.0.0.1:5432: postgres:5432/mission_hub
```

  The line carries the cause and the target (`host:port/dbname`) and never a credential — a wrong `DATABASE_URL` and a dead database are told apart without shelling into the host. Keep the window below the platform's health-check tolerance so a genuinely unreachable database still fails the deployment.

### 3. Dokploy (branch → environment variables)

Production and staging are Dokploy applications that build the repository `Dockerfile` for the branch configured on the application:

| Application | Branch | Public host |
|-------------|--------|-------------|
| `mission-hub` | `main` | `mission-hub.lan` |
| `mission-hub-staging` | `staging` | `mission-hub-staging.lan` |

Deployment is branch-driven (`feature/* → dev → staging → main`, see Contributing); no build command and no port override are needed, because the image reads `PORT` and `HOST` from the environment. Each application needs its own values for:

- `DATABASE_URL` — that application's PostgreSQL database.
- `MISSION_HUB_ADMIN_TOKEN` — a distinct bootstrap admin Bearer per application.
- `MISSION_HUB_ALLOWED_HOSTS` — the host names the application must answer on (its public domain and internal name), otherwise requests are refused with `403`. List only the deployment's own names: loopback is built in and always accepted. Required outside development: an environment that leaves it unset refuses to boot.
- `MISSION_HUB_ENV` — `staging` or `production` for a deployed application; leave it unset for local work (unset means `development`, and any other value refuses to boot rather than guess).
- `NODE_ENV=production` — set it on every deployed application, staging included: Node libraries switch to their production behaviour on it. It is not what names the environment; `MISSION_HUB_ENV` is.
- `MISSION_HUB_CLIENTS_JSON` — optional seeded clients.
- `MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY` — must stay `false` outside staging. It is the only gate for the fixture-cleanup endpoint; the environment name does not enable it.

Those values belong in the platform's secret store: never commit them and never paste them into CI logs, PR bodies, chat or memory.

## Configuration

Environment variables (see `.env.example`; the committed values are placeholders):

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | — (required) | PostgreSQL connection string. The server, `pnpm db:migrate` and the legacy tooling fail without it; the boot line reports `db=unconfigured` when it is missing. |
| `PORT` | `3000` | HTTP listen port. |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `MISSION_HUB_ALLOWED_HOSTS` | loopback only (`localhost`, `127.0.0.1`) | Comma-separated exact host names accepted in the `Host` header; entries are trimmed, empty ones dropped, ports ignored. The code ships **no deployment topology**: a deployed environment sets this variable to the names it is served on, and the server refuses to boot when a non-development environment leaves it unset or empty. Loopback (`127.0.0.1`, `localhost`) is **built in** and accepted in every environment, so it never belongs in this list — the container's own health probe uses it. Any other host is answered with `403`. No wildcards, no regex. |
| `MISSION_HUB_ENV` | `development` | `development`, `staging` or `production` — the deployment's own name, under the conventional `*_ENV` key (`NODE_ENV`, `RAILS_ENV`, `APP_ENV`). Unset or blank means `development`; an unrecognized value stops the process at boot instead of silently becoming `development`. Purpose: the boot line's identity (`env=… allowed_hosts=… db=…`) and the rule that a non-development deployment must declare its Host allowlist. It gates **no route**. |
| `MISSION_HUB_DB_RETRY_WINDOW_MS` | `25000` | How long boot keeps retrying the initial migrations while the database is unreachable (milliseconds). `0` means a single attempt. Keep it below the platform's health-check tolerance. |
| `MISSION_HUB_DB_RETRY_INITIAL_MS` | `1000` | First retry delay; each further attempt doubles it, up to the maximum below. |
| `MISSION_HUB_DB_RETRY_MAX_MS` | `8000` | Cap on a single retry delay. |
| `MISSION_HUB_COMMIT` | — (unset → `unknown`) | Commit the running build was made from, reported by `GET /health`. Supplied by the image build (`--build-arg MISSION_HUB_COMMIT=<sha>`, wired in CI), so it describes the built artefact; a build that supplies nothing reports `unknown` rather than a guessed revision. |
| `NODE_ENV` | — | Not read by this code. Set `NODE_ENV=production` on every deployed application (staging included) so the Node libraries it uses take their production paths. |
| `MISSION_HUB_ADMIN_TOKEN` | — | Bootstrap admin Bearer for client administration on both surfaces: REST `/api/v1/admin/clients` (create/list/revoke) and the MCP tools `clients.list` / `clients.create` / `clients.revoke`. It carries only the privileged `clients:admin` scope, so `/mcp` admits it explicitly for those tools. Never grant it to a service client. |
| `MISSION_HUB_CLIENTS_JSON` | — | Optional seed/fallback clients, upserted hashed on boot. `verify:admin` can only be seeded this way — it cannot be minted through the admin API. |
| `MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY` | `false` | The **only** gate for `DELETE /api/v1/admin/verify-fixtures/:missionId` (with the `verify:admin` scope): staging-only, must never be `true` in production. The deployment environment does not enable it. |

Admin clients are minted with `pnpm clients create <clientId> --scopes <scope,scope>`, listed with `pnpm clients list` and revoked with `pnpm clients revoke <clientId>`; the same operations exist as `POST`, `GET` and `POST /api/v1/admin/clients/:clientId/revoke`, and over MCP as `clients.create` / `clients.list` / `clients.revoke` (admin token only — a scoped service client gets `forbidden` with `required: ["clients:admin"]`). A created client's plaintext token is returned once and never retrievable again. The privileged `approvals:human` and `verify:admin` scopes cannot be minted through the admin API.

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
├── index.ts            # Entry point: boot line, retried migrations, env-client seeding, HTTP server
├── boot.ts             # Boot diagnostics: effective-config line, DB retry window, one fatal line
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
