import type { Pool } from 'pg';
import { runMigrations } from './db/migrate.js';

/**
 * Boot diagnostics: what a deployment says at startup, and how long it
 * tolerates a database that is not up yet.
 *
 * Two failures motivated this module:
 *
 * 1. In compose/orchestration the database legitimately starts *after* the
 *    application. Migrations ran once, before `serve()`, with no retry, so a
 *    late database meant an immediate `exit 1` — the container disappeared and
 *    the platform reported the deployment as done.
 * 2. The boot line named the allowlist by *count* (`allowed_hosts=2`) and said
 *    nothing about which database the process was talking to, so a log reader
 *    could not tell a wrongly configured `DATABASE_URL` from a dead database.
 *
 * Everything here is credential-free: {@link describeDatabaseTarget} renders
 * `host:port/dbname` and {@link redactDatabaseSecrets} scrubs the connection
 * string out of any text (driver errors sometimes echo it back) before a line
 * reaches a log. The password never leaves the process.
 */

/** Port PostgreSQL itself falls back to when the URL omits one. */
const DEFAULT_POSTGRES_PORT = '5432';

/** Rendered when the URL does not name that part (e.g. no path). */
const ABSENT_PART = 'default';

/** Rendered when `DATABASE_URL` is unset or blank. */
export const UNCONFIGURED_DATABASE_TARGET = 'unconfigured';

/** Rendered when `DATABASE_URL` is set but is not a parsable URL. */
export const UNPARSABLE_DATABASE_TARGET = 'unparsable';

const REDACTED = '***';

/**
 * Credential-free description of the database this process talks to:
 * `host:port/dbname`. Suitable for a log line, safe in a screenshot.
 *
 * The connection string is never returned, and a string that cannot be parsed
 * degrades to a fixed marker instead of echoing the input back.
 */
export function describeDatabaseTarget(
  connectionString: string | undefined | null,
): string {
  const raw = (connectionString ?? '').trim();
  if (raw.length === 0) return UNCONFIGURED_DATABASE_TARGET;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return UNPARSABLE_DATABASE_TARGET;
  }

  if (url.hostname.length === 0) return UNPARSABLE_DATABASE_TARGET;

  const port = url.port.length > 0 ? url.port : DEFAULT_POSTGRES_PORT;
  const path = url.pathname.replace(/^\//, '');
  const dbname = path.length > 0 ? path : ABSENT_PART;

  return `${url.hostname}:${port}/${dbname}`;
}

/**
 * Removes every credential the connection string carries from `text`.
 *
 * Driver errors occasionally quote the connection string back (`Invalid URL`,
 * SASL failures, TLS errors), and those messages are the ones a fatal line has
 * to print. The full URL and the password — raw and percent-decoded — are
 * replaced; the longest match goes first so the whole URL is not left half
 * substituted by the password-sized hit inside it.
 */
export function redactDatabaseSecrets(
  text: string,
  connectionString: string | undefined | null,
): string {
  const raw = (connectionString ?? '').trim();
  if (raw.length === 0) return text;

  const secrets = new Set<string>([raw]);
  try {
    const url = new URL(raw);
    if (url.password.length > 0) {
      secrets.add(url.password);
      try {
        secrets.add(decodeURIComponent(url.password));
      } catch {
        // Malformed percent-encoding: the raw form above is already covered.
      }
      secrets.add(`${url.username}:${url.password}`);
    }
  } catch {
    // Unparsable URL: only the raw string is known, and it is already listed.
  }

  let redacted = text;
  for (const secret of [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

/** One-line rendering of an unknown thrown value — no stack, no newlines. */
export function describeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error);
  const collapsed = message.replace(/\s*\r?\n\s*/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : 'unknown error';
}

/**
 * The single startup line. It names the *effective* configuration — the
 * environment, the host list the request guard applies, and the database
 * target — because that is the line that tells a log reader whether the
 * process is talking to the database anyone expected.
 */
export function formatBootLine(options: {
  env: string;
  allowedHosts: readonly string[];
  databaseTarget: string;
}): string {
  return (
    `[mission-hub] env=${options.env} ` +
    `allowed_hosts=${options.allowedHosts.join(',')} ` +
    `db=${options.databaseTarget}`
  );
}

/**
 * The one unambiguous fatal line, printed immediately before the process exits
 * non-zero: `fatal: migrations failed: <cause>: <host>:<port>/<dbname>`.
 * Credentials are redacted and the message is collapsed to a single line, so a
 * log search for `fatal: migrations failed:` finds the cause and the target.
 */
export function formatMigrationFailureLine(
  error: unknown,
  databaseTarget: string,
  connectionString?: string | null,
): string {
  const cause = redactDatabaseSecrets(describeError(error), connectionString);
  return `[mission-hub] fatal: migrations failed: ${cause}: ${databaseTarget}`;
}

/**
 * Progress line while the database is still down. Deliberately different from
 * the fatal line so the fatal marker stays unambiguous in a log search.
 */
export function formatDatabaseRetryLine(options: {
  error: unknown;
  delayMs: number;
  attempt: number;
  windowMs: number;
  databaseTarget: string;
  connectionString?: string | null;
}): string {
  const cause = redactDatabaseSecrets(
    describeError(options.error),
    options.connectionString,
  );
  return (
    `[mission-hub] database not ready (${options.databaseTarget}): ${cause} — ` +
    `retrying migrations in ${options.delayMs}ms ` +
    `(attempt ${options.attempt} within a ${options.windowMs}ms window)`
  );
}

/**
 * Retry/backoff policy for the initial migration run.
 *
 * `windowMs` is the whole tolerance for a late database; delays grow
 * exponentially from `initialDelayMs` up to `maxDelayMs`. The defaults retry
 * six times over ~23s, which covers a container that starts before its
 * database without making a genuinely wrong `DATABASE_URL` hang forever.
 */
export type DbRetryPolicy = {
  windowMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_DB_RETRY_POLICY: DbRetryPolicy = {
  windowMs: 25_000,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
};

/** Environment keys overriding {@link DEFAULT_DB_RETRY_POLICY}. */
export const DB_RETRY_ENV_KEYS = {
  windowMs: 'MISSION_HUB_DB_RETRY_WINDOW_MS',
  initialDelayMs: 'MISSION_HUB_DB_RETRY_INITIAL_MS',
  maxDelayMs: 'MISSION_HUB_DB_RETRY_MAX_MS',
} as const;

/** Safety net: a pathological policy can never spin forever. */
const MAX_DB_RETRY_ATTEMPTS = 50;

function readDurationMs(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${key}="${raw}" is not a valid duration in milliseconds. ` +
        `Expected a non-negative integer, or leave it unset for ${fallback}. ` +
        'Refusing to start rather than guess the retry window.',
    );
  }
  return parsed;
}

export function resolveDbRetryPolicy(
  env: Record<string, string | undefined> = process.env,
): DbRetryPolicy {
  return {
    windowMs: readDurationMs(
      env,
      DB_RETRY_ENV_KEYS.windowMs,
      DEFAULT_DB_RETRY_POLICY.windowMs,
    ),
    initialDelayMs: readDurationMs(
      env,
      DB_RETRY_ENV_KEYS.initialDelayMs,
      DEFAULT_DB_RETRY_POLICY.initialDelayMs,
    ),
    maxDelayMs: readDurationMs(
      env,
      DB_RETRY_ENV_KEYS.maxDelayMs,
      DEFAULT_DB_RETRY_POLICY.maxDelayMs,
    ),
  };
}

export type DbRetryAttempt = {
  attempt: number;
  delayMs: number;
  elapsedMs: number;
  error: unknown;
};

export type RunMigrationsWithRetryOptions = {
  policy?: DbRetryPolicy;
  run?: (pool: Pool) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onRetry?: (attempt: DbRetryAttempt) => void;
  onRecovered?: (info: { attempts: number; elapsedMs: number }) => void;
};

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs the migrations, retrying while the database is unreachable.
 *
 * The first attempt is immediate; afterwards the wait grows exponentially and
 * the loop gives up once the next delay would land past `windowMs` (a
 * `windowMs` of `0` therefore means "one attempt, no retry"). When the window
 * is exhausted the last error is rethrown untouched so the caller decides how
 * to report and exit; a late-but-alive database is logged through
 * `onRecovered` instead of being retried silently.
 */
export async function runMigrationsWithRetry(
  pool: Pool,
  options: RunMigrationsWithRetryOptions = {},
): Promise<void> {
  const policy = options.policy ?? resolveDbRetryPolicy();
  const run = options.run ?? runMigrations;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();

  let attempt = 0;
  let delayMs = policy.initialDelayMs;

  for (;;) {
    attempt += 1;

    try {
      await run(pool);
      if (attempt > 1) {
        options.onRecovered?.({ attempts: attempt, elapsedMs: now() - startedAt });
      }
      return;
    } catch (error) {
      const elapsedMs = now() - startedAt;
      const outOfWindow =
        elapsedMs >= policy.windowMs || elapsedMs + delayMs > policy.windowMs;

      if (outOfWindow || attempt >= MAX_DB_RETRY_ATTEMPTS) throw error;

      options.onRetry?.({ attempt, delayMs, elapsedMs, error });
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, policy.maxDelayMs);
    }
  }
}
