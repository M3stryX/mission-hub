# Legacy Piblox Missions migration

Mission Hub V1 uses PostgreSQL as its durable SSOT.

The migration path is deliberately one-way and evidence-driven:

1. Export the canonical legacy SQLite database read-only with `scripts/export-legacy-sqlite.py`.
2. Create an empty Mission Hub PostgreSQL database and apply versioned SQL migrations.
3. Import the JSON bundle transactionally with `scripts/import-legacy.ts`.
4. Verify mission IDs, parent links, checklist items, sources, events and search behavior.
5. Keep legacy `cursor_sessions` in the export report. V1 does not invent mappings when runtime/client identity cannot be proven.
6. Rehearse against staging before any production cutover.

PostgreSQL full-text search uses the `simple` configuration. It replaces SQLite FTS5 behavior but is treated as a new search implementation; exact token-ranking equivalence is not assumed.

Large execution artifacts are stored outside the database. Mission Hub stores durable evidence references and bounded metadata.
