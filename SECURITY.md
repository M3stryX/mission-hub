# Security Policy

## Supported versions

Mission Hub is a self-hosted service. Only the latest commit on `main` is
supported with security fixes. Older commits and feature branches are not
backported — upgrade to `main` to receive fixes.

| Version | Supported |
|---------|-----------|
| `main` (latest) | Yes |
| Older commits / feature branches | No |

## Reporting a vulnerability

Please report vulnerabilities privately — do **not** open a public issue.

- Open a GitHub private vulnerability report on this repository, or
- Contact the operator directly through a private channel.

Include: affected version/commit, a description of the issue, and steps to
reproduce. We aim to acknowledge reports within a few days.

## Secrets are never pasted

**Never** paste sessions, tokens, `.env` values, Bearer credentials, database
passwords, or any other secret into issues, pull requests, chat, or any other
public or shared space. If a secret was exposed, rotate it immediately and
invalidate the compromised value.

## Deployment model

Mission Hub is **operator-controlled and self-hosted**. There is no hosted or
managed offering. The operator is responsible for:

- Network exposure and reverse-proxy / TLS termination
- Secret management (admin token, database credentials, client tokens)
- Keeping the deployment on a supported commit

The `verify:admin` destructive cleanup endpoint is staging-only and gated by
the `MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY` environment variable. It must never
be enabled in production.
