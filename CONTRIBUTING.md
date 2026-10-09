# Contributing

Thanks for your interest in contributing to Mission Hub. This document
describes the branch flow, commit conventions, and local quality gates.

## Branch flow

```text
feature/*  →  dev  →  staging  →  main
```

- Create a feature branch from the latest `dev`.
- Open a pull request targeting **`dev`** — never commit or push straight to
  `main` or `staging`.
- Promote `dev` → `staging` → `main` only after verification at each step
  (and explicit operator approval for production).

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature or surface
- `fix:` — bug fix
- `docs:` — documentation only
- `test:` — test additions or fixes
- `chore:` — build, tooling, or dependency changes
- `refactor:` — code change that neither fixes a bug nor adds a feature

All commit messages and repository artifacts are in **English**.

## Pull requests

Use the repository PR template (Summary + Test plan + Checklist). Link the
relevant mission or issue when one exists. Never include secrets, tokens, or
`.env` contents in the PR body or screenshots.

## Local quality gates

Run these before proposing a commit or PR:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:contract-inventory
```

`pnpm db:migrate` requires a disposable PostgreSQL instance (set
`DATABASE_URL`). CI runs the full suite including migrations and a Docker
build.

## Code of conduct

- **No secrets in commits.** Never commit API keys, Bearer tokens, database
  passwords, or `.env` contents. If a secret is committed, rotate it and
  remove it from history.
- **English only** in all persistent artifacts (code, comments, commits,
  Markdown, PR text).
- Respect the architecture rules in [`AGENTS.md`](AGENTS.md) — especially
  REST ↔ MCP parity and the contract inventory drift gate.
