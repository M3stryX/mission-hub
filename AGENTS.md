# Agent guide — Mission Hub

Standalone **mission + execution-trace** service (Hono + PostgreSQL + MCP).

| | |
|---|---|
| GitHub | [M3stryX/mission-hub](https://github.com/M3stryX/mission-hub) |
| Prod | `mission-hub.lan` (Dokploy app `mission-hub`, branch `main`) |
| Staging | `mission-hub-staging.lan` (Dokploy app `mission-hub-staging`, branch `staging`) |
| Auth | Option A — hashed API clients in Postgres (`clients:admin` mint/revoke) |
| Agent contract | [`docs/AGENT_USAGE.md`](docs/AGENT_USAGE.md) **v1.2** (authoritative over skills) |

## Non-goals (do not reopen without explicit operator ask)

- Using `mission.status` as a lock or lease
- Putting secrets, tokens, or passwords in chat, commits, or Hindsight
- Skipping REST ↔ MCP parity for writable surfaces
- Running `verify:admin` / destructive fixture cleanup against production

## Architecture rules

1. **SSOT** — Mission Hub owns durable missions, claims, runs, events, summaries, evidence. n8n is a client/dispatcher, not the claim store. Hindsight is memory, not operational state.
2. **Business vs lock** — `mission.status` is business state only. Temporary ownership uses `mission_claims` (lease, renew, release, expiry reclaim).
3. **Atomic claim** — Claim acquisition must create/bind session + run + claim + audit events in one transaction; no orphan claims.
4. **Claim ↔ run coherence** — Release `completed` requires summary + evidence and a COMPLETED run (transitioned atomically if needed). `failed`/`abandoned` terminalize the run to FAILED. Expiry reclaim diagnoses the owner session/run (never invents a cause), records `claim.expiry_diagnosis`, fences the previous owner, and must not leave the previous run RUNNING.
5. **REST ↔ MCP parity** — Every agent-facing write/read must exist on both surfaces unless documented otherwise.
6. **Contract inventory** — Keep `src/contract/inventory.ts` and `docs/contract-inventory.json` aligned with enums, scopes, tables, REST routes, MCP tools, MCP descriptions, and `docs/AGENT_USAGE.md` `Contract-Version`. `pnpm test:contract-inventory` (and CI) enforce this.
7. **Migrations** — SQL under `migrations/`; applied on boot and via `pnpm db:migrate`. Never hand-edit production schema.
8. **Destructive verify** — `verify:admin` cleanup is staging-only and gated by env (`MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY`). Refuse on prod.

## Git workflow

```text
feature/*  →  dev  →  staging  →  main
```

- Never commit or push straight to `main`.
- Feature PRs target **`dev`**.
- Promote `dev` → `staging` → `main` only after verification at each step (and explicit operator OK for prod).
- Conventional commits (`feat:`, `fix:`, `docs:`, …). English only in repo artifacts.
- Do not use `--no-verify` / `--force` on protected branches without explicit human agreement.

## Before proposing a commit or PR

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
# Requires DATABASE_URL pointing at a disposable Postgres
pnpm db:migrate
pnpm test
pnpm build
```

Summarize for the human: commands run, pass/fail, and any migration or contract-inventory impact.

## PR quality bar

- Use the repo PR template (Summary + Test plan + Checklist).
- Link the Mission Hub mission / GitHub issue when one exists (e.g. CLAIM-01 / #195).
- Call out migrations, new scopes, and REST/MCP surface changes explicitly.
- Never include secrets, Bearer tokens, or `.env` contents in the PR body or screenshots.

## Local / CI commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Watch server |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` | Verify |
| `pnpm db:migrate` | Apply SQL migrations |
| `pnpm clients` | Admin client mint/list helpers |
| `pnpm test:contract-inventory` | Inventory drift check |

CI (`.github/workflows/ci.yml`): lint, typecheck, migrate (fresh + idempotent), legacy fixture import, test, build, Docker build. Triggers on PRs to `dev`/`staging`/`main` and pushes to `dev`/`feature/**`.

## Language policy

- Chat with the human: **French**.
- All persistent artifacts: **English** (code, comments, commits, Markdown, PR text).

## Secrets

- Never paste API keys, Bearer tokens, DB passwords, or Dokploy env dumps into chat or memory.
- Prefer scope-limited clients; rotate anything that was ever pasted.
