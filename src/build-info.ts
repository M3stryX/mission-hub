/**
 * Build identity — what code is actually answering this process.
 *
 * `version` is read from `package.json` and `contract` from the contract
 * inventory (`src/contract/inventory.ts`, itself gated against
 * `docs/AGENT_USAGE.md` by `pnpm test:contract-inventory`). Both are read from
 * their sources, never retyped as literals that would drift from what ships.
 *
 * `commit` is supplied by the build: `--build-arg MISSION_HUB_COMMIT=<sha>`
 * (wired from CI and Dokploy in the Dockerfile). A build that supplies nothing
 * reports the literal `unknown`, which can never be mistaken for a real
 * revision — the value is never guessed or defaulted to a SHA.
 */
import { readFileSync } from 'node:fs';
import { AGENT_USAGE_CONTRACT } from './contract/inventory.js';

/** Environment variable a build sets to the commit it built. */
export const COMMIT_ENV_KEY = 'MISSION_HUB_COMMIT';

/** Reported when the build supplied no commit. */
export const UNKNOWN_COMMIT = 'unknown';

const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

let productVersion: string | undefined;

/**
 * Product version, read from `package.json` — the single source for it.
 * The default URL resolves beside this module, so it works from `src/` (tsx,
 * vitest) and from `dist/` (the production image) alike.
 */
export function readProductVersion(
  packageJsonUrl: URL = PACKAGE_JSON_URL,
): string {
  if (packageJsonUrl === PACKAGE_JSON_URL) {
    productVersion ??= parseVersion(readFileSync(packageJsonUrl, 'utf8'));
    return productVersion;
  }
  return parseVersion(readFileSync(packageJsonUrl, 'utf8'));
}

/** Contract revision, read from the contract inventory. */
export function readContractVersion(): string {
  return AGENT_USAGE_CONTRACT.version;
}

/**
 * Commit the running build was made from.
 * Absent or blank build value → `unknown`, never an invented revision.
 */
export function readCommit(
  env: Record<string, string | undefined> = process.env,
): string {
  const commit = (env[COMMIT_ENV_KEY] ?? '').trim();
  return commit.length > 0 ? commit : UNKNOWN_COMMIT;
}

function parseVersion(raw: string): string {
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error('package.json declares no version');
  }
  return parsed.version;
}
