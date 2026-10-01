## Summary

<!-- Why this PR exists and what it changes. Link mission/issue: Refs MISSION-… / Closes #NN. -->

-

## Test plan

<!-- Concrete steps reviewers can follow. Prefer commands from AGENTS.md. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm db:migrate` (fresh disposable DB)
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] CI green on this PR

## Checklist

- [ ] No secrets / tokens / `.env` in the diff or PR body
- [ ] REST ↔ MCP parity preserved (or intentional gap documented)
- [ ] Contract inventory updated if enums / scopes / tables / routes / MCP tools changed
- [ ] SQL migration added if schema changed (and noted below)
- [ ] Does not use `mission.status` as a lock (claims/leases only)

## Notes

<!-- Optional: migrations, new scopes, env vars, staging/prod follow-ups, rollback. -->
