# Runtime Adapters

Per-runtime setup for driving Mission Hub as an autonomous agent, plus the runtime
compatibility matrix. Part of the runtime-agnostic Autonomous Agent Kit: the behaviour
reference and policy live in [`docs/AUTONOMOUS_AGENTS.md`](AUTONOMOUS_AGENTS.md), the role
definitions in [`docs/AGENT_ROLES.md`](AGENT_ROLES.md), and the copy-paste bootstrap block in
[`docs/BOOTSTRAP_PROMPT.md`](BOOTSTRAP_PROMPT.md). This document defers to
[`docs/AGENT_USAGE.md`](AGENT_USAGE.md) (contract revision v1.2) for all contract semantics.

**How this matrix was built.** Every non-Hermes cell was measured from the CLIs and config
files of one Linux workstation (2026-10-08: Claude Code 2.1.114, Codex 0.160.1, OpenCode
2.0.17) and from those runtimes' official documentation. Nothing is asserted that was not
observed: an unobserved capability stays `UNKNOWN`, and an unverified capability is never
upgraded to `YES`. The Hermes column is owned by mission #291 (RUNTIME-COMPARE-01) and ships
`PENDING #291` until that mission reports — this kit does not re-score it. Re-verify the
matrix after any runtime upgrade; the versions above are the ones the observations pin.

Verdict vocabulary: `YES` / `NO` (observed capability or absence), `TESTED` (exercised from
the runtime on that workstation), `UNKNOWN` (not observable — see Open questions), and
`PENDING #291` (scored by another mission).

## Compatibility matrix

| Capability | Claude Code 2.1.114 | Codex 0.160.1 | OpenCode 2.0.17 | Hermes |
|---|---|---|---|---|
| MCP client — streamable HTTP | `YES` · `TESTED` — `--transport http` | `YES` · `TESTED` — `--url` | `YES` · `TESTED` — `--url` + `type: remote` | `PENDING #291` |
| MCP client — stdio | `YES` · `TESTED` — 1 server configured | `YES` · `TESTED` — 4 servers configured | `YES` · `TESTED` — 1 local server configured | `PENDING #291` |
| MCP auth | `YES` · `TESTED` — `--header`, OAuth flags | `YES` · `TESTED` — `--bearer-token-env-var`, OAuth flags | `YES` · `TESTED` — `--header key=value` | `PENDING #291` |
| Autonomy loop (repeated unattended) | `NO` — `-p` is one-shot; external driver required | `NO` — `codex exec` is one-shot; external driver required | `NO` — `run` is one-shot; external driver required | `PENDING #291` |
| Subagents | `YES` — built-in + custom (`--agents`) | `YES` — default workflows + `.codex/agents/*.toml` | `YES` — `mode: subagent`, `.opencode/agents/*.md` | `PENDING #291` |
| Parallel background sessions | `YES` — background agents (agent view) | `YES` — app-server daemon (experimental) | `YES` — `serve` + `service` | `PENDING #291` |
| Native scheduler | `NO` — no schedule/cron command | `NO` — no schedule/cron command | `NO` — no schedule/cron command | `PENDING #291` |
| Resume across sessions | `YES` — `--resume` / `--continue` | `YES` — `exec resume` / `fork` | `YES` — `--continue` / `--session` / `--fork` | `PENDING #291` |
| Approval / permission hooks | `YES` — `--permission-mode`, `--allowedTools` | `YES` — `sandbox_mode`, `approval_policy` | `YES` — `permissions` rules, `--auto` | `PENDING #291` |
| Headless / non-interactive | `YES` — `-p` / `--print` | `YES` — `codex exec` | `YES` — `run --prompt` | `PENDING #291` |
| Structured output | `YES` — `--output-format` | `YES` — `--json` | `YES` — `--format json` | `PENDING #291` |

Evidence basis per column: every non-Hermes cell comes from that runtime's CLI `--help`
output, its local configuration file, or its official documentation, all observed on the
workstation and date stated above. The Hermes column is not measured here by design — the
orchestrator overlap guard assigns Hermes capability verdicts to mission #291; the only
Hermes observation used in this kit is the MCP wiring snippet below plus a read-only
`tools/list` probe against the Mission Hub endpoint. No native scheduler exists in the three
non-Hermes runtimes — the absence was checked against their full `--help` output.

## Claude Code

- **Wiring** (writes `~/.claude.json` → `mcpServers`, JSON; default scope `local`, add
  `--scope user` to share across projects):

  ```bash
  claude mcp add --transport http mission-hub http://<HOST>:3000/mcp \
    --header "Authorization: Bearer $MH_MCP_TOKEN"
  ```

  `$MH_MCP_TOKEN` is a placeholder for the client-side environment variable you choose —
  hold the token there and never inline it in prompts, commits, or logs.

- The dual `Accept: application/json, text/event-stream` header required by streamable
  HTTP is sent by the client itself — no manual header entry needed.
- **Bootstrap**: fill the three placeholders in
  [`docs/BOOTSTRAP_PROMPT.md`](BOOTSTRAP_PROMPT.md), then paste it as the first turn of an
  interactive session, or pass the filled prompt to `claude -p` for a one-shot headless run.
- **Schedule / resume**: no native scheduler — drive repeated runs from an external driver
  (system cron, systemd timer, n8n) that invokes `claude -p` with the filled prompt; resume
  a stopped session with `claude --resume <session-id>` or `claude --continue`.
- **Kit posture**: keep the default `--permission-mode`; express the write allowlist
  ([`AUTONOMOUS_AGENTS.md`](AUTONOMOUS_AGENTS.md) §3) with `--allowedTools`.
- **Unsupported / untested**: non-interactive dispatch of *new* background agents is
  `UNKNOWN` in the measured version (no background-dispatch flag in `--help`; the agents
  command only lists sessions) — see Open questions.

## Codex

- **Wiring** (writes `~/.codex/config.toml` → `[mcp_servers.mission-hub]`, TOML):

  ```bash
  codex mcp add mission-hub --url http://<HOST>:3000/mcp \
    --bearer-token-env-var MH_MCP_TOKEN
  ```

- Codex authenticates to streamable-HTTP MCP servers by bearer token held in a named
  environment variable (or OAuth). There is no arbitrary-header flag; Mission Hub's Bearer
  scheme is compatible as-is.
- **Bootstrap**: interactive `codex`, or one-shot `codex exec "<filled prompt>"`.
- **Schedule / resume**: no native scheduler — external driver invoking `codex exec`;
  resume a session with `codex exec resume <session>` or `codex exec fork`.
- **Kit posture**: `sandbox_mode` `read-only` for the pilot, `workspace-write` once the
  allowlist is defined; `approval_policy` gates privileged actions.
- **Unsupported / untested**: the `codex app-server` daemon is marked experimental by its
  own documentation — its production reliability is `UNKNOWN`; do not build the kit's
  driver on it.

## OpenCode

- **Wiring** (writes `~/.config/opencode/opencode.json` → `mcp.servers` with
  `--global`; without `--global` the entry goes to the project config):

  ```bash
  opencode mcp add mission-hub --url http://<HOST>:3000/mcp \
    --header "Authorization=Bearer $MH_MCP_TOKEN" --global
  ```

- Note the header syntax: `--header key=value` (not `Key: value`). Remote servers appear in
  the config as `type: remote`.
- On the workstation where this was measured the binary was not on `PATH` (invoked by full
  path from its install directory) — symlink it or call the full path.
- **Bootstrap**: interactive `opencode`, or one-shot `opencode run --prompt "<filled prompt>"`.
- **Schedule / resume**: no native scheduler — external cron invoking `opencode run`;
  resume with `--continue`, `--session`, or `--fork`.
- **Kit posture**: express the write allowlist with `permissions` rules (allow / deny /
  ask); avoid `--auto` beyond read-only work.
- **Unsupported / untested**: none specific beyond the shared `UNKNOWN` items below.

## Hermes

- **Wiring** (config file `~/.hermes/config.yaml` → `mcp_servers` section; entry shape as
  observed on the measured workstation):

  ```yaml
  mcp_servers:
    mission-hub:
      url: http://<HOST>:3000/mcp
      headers:
        Accept: application/json, text/event-stream
        Authorization: Bearer $MH_MCP_TOKEN
  ```

- This adapter carries the dual `Accept` header explicitly; a read-only `tools/list` probe
  through this wiring was observed working against the Mission Hub MCP endpoint.
- **Bootstrap**: paste the filled [`docs/BOOTSTRAP_PROMPT.md`](BOOTSTRAP_PROMPT.md) block as
  the first turn of a Hermes session.
- **Schedule / resume**: Hermes ships its own scheduler (cron jobs) and session resume —
  this is **one recognised implementation** of the driver role described in
  [`AUTONOMOUS_AGENTS.md`](AUTONOMOUS_AGENTS.md) §5, not a requirement of the kit. Any
  external driver that can call the MCP tools on a schedule satisfies the same pattern.
- **Marker**: Hermes capability verdicts are `PENDING #291` (RUNTIME-COMPARE-01) throughout
  the matrix above; this kit neither scores nor anticipates them.

## Open questions (carried from the observed audit)

Each item is `UNKNOWN` here; the observation that would settle it is named.

1. **Codex non-bearer MCP headers** — Codex has no arbitrary-header flag; whether it can
   reach an MCP server requiring a non-Bearer header (e.g. `X-Api-Key`) is unobserved.
   A single successful `tools/list` through such a server would settle it.
2. **Claude Code non-interactive background dispatch** — how to dispatch *new* background
   agents headlessly in the measured version is unobserved (no dispatch flag in `--help`).
   A successful headless dispatch would settle it.
3. **Codex app-server reliability** — marked experimental; no production-use observation
   exists.
4. **Missed-run recovery for any driver** — the scheduler/resume pattern is documented,
   not proven: no missed-run recovery has been tested for any runtime
   ([`AUTONOMOUS_AGENTS.md`](AUTONOMOUS_AGENTS.md) §7.5).
5. **Hermes capability verdicts** — owned by mission #291; the cells stay `PENDING #291`
   until that mission reports.
