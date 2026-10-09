import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ALL_SERVICE_SCOPES, PRIVILEGED_SCOPES } from '../src/auth/config.js';
import {
  AGENT_USAGE_CONTRACT,
  CONTRACT_MCP_TOOLS,
  CONTRACT_MCP_TOOL_DESCRIPTIONS,
  buildContractInventory,
} from '../src/contract/inventory.js';

const databaseUrl = process.env.DATABASE_URL;
const snapshot = JSON.parse(
  readFileSync(new URL('../docs/contract-inventory.json', import.meta.url), 'utf8'),
) as ReturnType<typeof buildContractInventory>;

describe('contract inventory drift gate', () => {
  it('matches the versioned inventory snapshot', () => {
    expect(buildContractInventory()).toEqual(snapshot);
  });

  it('keeps auth scope exports aligned with inventory scopes', () => {
    // approvals:human is exported by both auth groups per the scope plan
    // (ALL_SERVICE_SCOPES + PRIVILEGED_SCOPES); the inventory lists each
    // scope once, so de-duplicate before comparing.
    const fromCode = [
      ...new Set([...ALL_SERVICE_SCOPES, ...PRIVILEGED_SCOPES]),
    ].sort();
    expect([...snapshot.scopes].sort()).toEqual(fromCode);
  });

  it('keeps MCP tool list and description map keys aligned', () => {
    expect(Object.keys(CONTRACT_MCP_TOOL_DESCRIPTIONS).sort()).toEqual(
      [...CONTRACT_MCP_TOOLS].sort(),
    );
    expect(snapshot.mcpTools).toEqual([...CONTRACT_MCP_TOOLS]);
    expect(snapshot.mcpToolDescriptions).toEqual(CONTRACT_MCP_TOOL_DESCRIPTIONS);
  });

  it('keeps AGENT_USAGE.md Contract-Version aligned with inventory', () => {
    const doc = readFileSync(
      new URL('../docs/AGENT_USAGE.md', import.meta.url),
      'utf8',
    );
    const match = doc.match(/^Contract-Version:\s*(\S+)/m);
    expect(match?.[1]).toBe(AGENT_USAGE_CONTRACT.version);
    expect(snapshot.agentUsage).toEqual(AGENT_USAGE_CONTRACT);
    expect(doc).toContain('mission_claims');
    expect(doc).toContain('missions.claim');
  });
});

describe.skipIf(!databaseUrl)('contract inventory against live schema', () => {
  const pool = new Pool({ connectionString: databaseUrl });

  it('matches PostgreSQL enums and public tables', async () => {
    const enums = await pool.query<{ typname: string; enumlabel: string }>(
      `SELECT t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
         AND t.typname = ANY($1::text[])
       ORDER BY t.typname, e.enumsortorder`,
      [Object.keys(snapshot.enums)],
    );

    const grouped: Record<string, string[]> = {};
    for (const row of enums.rows) {
      grouped[row.typname] ??= [];
      grouped[row.typname].push(row.enumlabel);
    }
    expect(grouped).toEqual(snapshot.enums);

    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename`,
    );
    expect(tables.rows.map((row) => row.tablename).sort()).toEqual(
      [...snapshot.tables].sort(),
    );

    await pool.end();
  });
});
