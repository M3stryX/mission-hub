# Mission Hub

Standalone service for execution tracing and mission management.

## Non-goals
- Production data migration (handled in later gates).
- Vector search (deferred).
- External authentication (deferred).

## Structure
- `src/domain`: Domain logic
- `src/db`: Database schemas/access
- `src/api`: REST API v1
- `src/mcp`: MCP adapter
- `src/auth`: Auth logic
- `src/observability`: Telemetry/logging
