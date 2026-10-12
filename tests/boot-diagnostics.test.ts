import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DB_RETRY_ENV_KEYS,
  DEFAULT_DB_RETRY_POLICY,
  describeDatabaseTarget,
  describeError,
  formatBootLine,
  formatDatabaseRetryLine,
  formatMigrationFailureLine,
  redactDatabaseSecrets,
  resolveDbRetryPolicy,
  runMigrationsWithRetry,
  UNCONFIGURED_DATABASE_TARGET,
  UNPARSABLE_DATABASE_TARGET,
} from '../src/boot.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const SECRET = 'super-secret-password';
const URL_WITH_SECRET = `postgres://hubuser:${SECRET}@db.internal:5433/mission_hub`;
const TARGET = 'db.internal:5433/mission_hub';

/**
 * The late-database test needs a real PostgreSQL to proxy to, so it announces
 * itself as skipped when no `DATABASE_URL` is configured (same intent as the
 * `describe.skipIf(!databaseUrl)` gate in the other database-backed suites).
 */
const liveDatabaseUrl = process.env.DATABASE_URL;

/** Env keys the boot tests own, so a developer's shell or `.env` cannot leak in. */
const OWNED_ENV_KEYS = [
  'MISSION_HUB_ENV',
  'MISSION_HUB_ALLOWED_HOSTS',
  'MISSION_HUB_CLIENTS_JSON',
  'MISSION_HUB_ADMIN_TOKEN',
  'MISSION_HUB_ALLOW_DESTRUCTIVE_VERIFY',
];

describe('describeDatabaseTarget', () => {
  it('renders host:port/dbname and never the credentials', () => {
    const target = describeDatabaseTarget(URL_WITH_SECRET);

    expect(target).toBe(TARGET);
    expect(target).not.toContain(SECRET);
    expect(target).not.toContain('hubuser');
  });

  it('falls back to the PostgreSQL default port and to a placeholder dbname', () => {
    expect(describeDatabaseTarget('postgres://db.internal/mission_hub')).toBe(
      'db.internal:5432/mission_hub',
    );
    expect(describeDatabaseTarget('postgres://db.internal:5433')).toBe(
      'db.internal:5433/default',
    );
  });

  it('names an absent or unreadable configuration without echoing it', () => {
    expect(describeDatabaseTarget(undefined)).toBe(UNCONFIGURED_DATABASE_TARGET);
    expect(describeDatabaseTarget('   ')).toBe(UNCONFIGURED_DATABASE_TARGET);

    const leaked = describeDatabaseTarget(`not a url ${SECRET}`);
    expect(leaked).toBe(UNPARSABLE_DATABASE_TARGET);
    expect(leaked).not.toContain(SECRET);
  });
});

describe('redactDatabaseSecrets', () => {
  it('removes the whole connection string, the password and its userinfo pair', () => {
    const text = `failed for ${URL_WITH_SECRET} using ${SECRET} (hubuser:${SECRET})`;

    const redacted = redactDatabaseSecrets(text, URL_WITH_SECRET);

    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain('hubuser');
    expect(redacted).not.toContain(URL_WITH_SECRET);
  });

  it('removes a percent-encoded password in both its encoded and decoded form', () => {
    const encoded = 'p%40ss%3Aword';
    const connectionString = `postgres://hubuser:${encoded}@db.internal:5433/mission_hub`;
    const text = `boom ${encoded} / p@ss:word`;

    const redacted = redactDatabaseSecrets(text, connectionString);

    expect(redacted).not.toContain(encoded);
    expect(redacted).not.toContain('p@ss:word');
  });

  it('leaves text untouched when there is no connection string to redact', () => {
    expect(redactDatabaseSecrets('connect ECONNREFUSED 127.0.0.1:1', undefined)).toBe(
      'connect ECONNREFUSED 127.0.0.1:1',
    );
  });
});

describe('boot lines', () => {
  it('names the effective configuration, listing hosts instead of counting them', () => {
    const line = formatBootLine({
      env: 'staging',
      allowedHosts: ['mission-hub-staging.lan', 'mission-hub-staging'],
      databaseTarget: TARGET,
    });

    expect(line).toBe(
      '[mission-hub] env=staging allowed_hosts=mission-hub-staging.lan,mission-hub-staging db=db.internal:5433/mission_hub',
    );
  });

  it('prints exactly one fatal line, with the cause, the target and no credentials', () => {
    const line = formatMigrationFailureLine(
      new Error(`getaddrinfo ENOTFOUND for ${URL_WITH_SECRET}`),
      TARGET,
      URL_WITH_SECRET,
    );

    expect(line).toBe(
      '[mission-hub] fatal: migrations failed: getaddrinfo ENOTFOUND for ***: db.internal:5433/mission_hub',
    );
    expect(line).not.toContain(SECRET);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('collapses a multi-line driver error so the fatal marker stays one line', () => {
    const line = formatMigrationFailureLine(
      new Error('connect ECONNREFUSED\n  at Socket\n  at TCPConnectWrap'),
      TARGET,
    );

    expect(line).toBe(
      '[mission-hub] fatal: migrations failed: connect ECONNREFUSED at Socket at TCPConnectWrap: db.internal:5433/mission_hub',
    );
  });

  it('reports an unknown throwable without inventing a message', () => {
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError(new Error('   '))).toBe('unknown error');
    expect(describeError('plain string')).toBe('plain string');
  });

  it('marks retry progress differently from the fatal line', () => {
    const line = formatDatabaseRetryLine({
      error: new Error(`connect ECONNREFUSED ${URL_WITH_SECRET}`),
      delayMs: 1000,
      attempt: 2,
      windowMs: 25_000,
      databaseTarget: TARGET,
      connectionString: URL_WITH_SECRET,
    });

    expect(line).toBe(
      '[mission-hub] database not ready (db.internal:5433/mission_hub): ' +
        'connect ECONNREFUSED *** — retrying migrations in 1000ms ' +
        '(attempt 2 within a 25000ms window)',
    );
    expect(line).not.toContain('fatal:');
  });
});

describe('resolveDbRetryPolicy', () => {
  it('defaults to a window inside the 10-30s tolerance', () => {
    const policy = resolveDbRetryPolicy({});

    expect(policy).toEqual(DEFAULT_DB_RETRY_POLICY);
    expect(policy.windowMs).toBeGreaterThanOrEqual(10_000);
    expect(policy.windowMs).toBeLessThanOrEqual(30_000);
  });

  it('reads overrides and treats a blank value as unset', () => {
    const policy = resolveDbRetryPolicy({
      [DB_RETRY_ENV_KEYS.windowMs]: ' 1500 ',
      [DB_RETRY_ENV_KEYS.initialDelayMs]: '',
      [DB_RETRY_ENV_KEYS.maxDelayMs]: '0',
    });

    expect(policy).toEqual({
      windowMs: 1500,
      initialDelayMs: DEFAULT_DB_RETRY_POLICY.initialDelayMs,
      maxDelayMs: 0,
    });
  });

  it('refuses to guess when a duration is not a non-negative integer', () => {
    for (const value of ['25s', '-1', '1.5', 'NaN']) {
      expect(() =>
        resolveDbRetryPolicy({ [DB_RETRY_ENV_KEYS.windowMs]: value }),
      ).toThrowError(/MISSION_HUB_DB_RETRY_WINDOW_MS/);
    }
  });
});

describe('runMigrationsWithRetry', () => {
  const pool = {} as Parameters<typeof runMigrationsWithRetry>[0];

  /** Deterministic clock: `sleep` advances what `now` reports. */
  function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let elapsed = 0;
    return {
      now: () => elapsed,
      sleep: async (ms: number) => {
        elapsed += ms;
      },
    };
  }

  it('runs the migrations once when the database is up', async () => {
    const clock = fakeClock();
    let calls = 0;
    const retries: number[] = [];

    await runMigrationsWithRetry(pool, {
      policy: { windowMs: 1000, initialDelayMs: 100, maxDelayMs: 400 },
      run: async () => {
        calls += 1;
      },
      onRetry: ({ attempt }) => retries.push(attempt),
      ...clock,
    });

    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it('backs off exponentially until the database appears, then reports recovery', async () => {
    const clock = fakeClock();
    const delays: number[] = [];
    const recoveries: { attempts: number; elapsedMs: number }[] = [];
    let calls = 0;

    await runMigrationsWithRetry(pool, {
      policy: { windowMs: 10_000, initialDelayMs: 100, maxDelayMs: 800 },
      run: async () => {
        calls += 1;
        if (calls <= 3) throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      },
      onRetry: ({ delayMs }) => delays.push(delayMs),
      onRecovered: (info) => recoveries.push(info),
      ...clock,
    });

    expect(calls).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
    expect(recoveries).toEqual([{ attempts: 4, elapsedMs: 700 }]);
  });

  it('gives up once the next delay would land past the window and rethrows the last error', async () => {
    const clock = fakeClock();
    const delays: number[] = [];
    const lastError = new Error('connect ECONNREFUSED 127.0.0.1:1');
    let calls = 0;

    await expect(
      runMigrationsWithRetry(pool, {
        policy: { windowMs: 1000, initialDelayMs: 400, maxDelayMs: 400 },
        run: async () => {
          calls += 1;
          throw lastError;
        },
        onRetry: ({ delayMs }) => delays.push(delayMs),
        ...clock,
      }),
    ).rejects.toBe(lastError);

    // 0ms -> wait 400 -> 400ms -> wait 400 -> 800ms -> next delay would pass the window
    expect(calls).toBe(3);
    expect(delays).toEqual([400, 400]);
  });

  it('treats a zero window as a single attempt', async () => {
    const clock = fakeClock();
    let calls = 0;

    await expect(
      runMigrationsWithRetry(pool, {
        policy: { windowMs: 0, initialDelayMs: 100, maxDelayMs: 400 },
        run: async () => {
          calls += 1;
          throw new Error('down');
        },
        ...clock,
      }),
    ).rejects.toThrowError('down');

    expect(calls).toBe(1);
  });

  it('never spins forever on a degenerate policy', async () => {
    const clock = fakeClock();
    let calls = 0;

    await expect(
      runMigrationsWithRetry(pool, {
        policy: { windowMs: Number.MAX_SAFE_INTEGER, initialDelayMs: 0, maxDelayMs: 0 },
        run: async () => {
          calls += 1;
          throw new Error('down');
        },
        ...clock,
      }),
    ).rejects.toThrowError('down');

    expect(calls).toBe(50);
  });
});

describe('boot against an unreachable database', () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  /**
   * Boots the real entrypoint in a child process. `PORT=0` lets it pick a free
   * port, and the child only receives the variables this test controls.
   */
  function spawnBoot(overrides: Record<string, string>) {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const key of OWNED_ENV_KEYS) delete env[key];
    Object.assign(env, overrides);

    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(repoRoot, 'src', 'index.ts')],
      { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);

    let stdout = '';
    let stderr = '';
    const waiters: { pattern: RegExp; resolve: () => void; timer: NodeJS.Timeout }[] = [];

    const output = (): string => stdout + stderr;
    const settleWaiters = (): void => {
      for (const waiter of [...waiters]) {
        if (!waiter.pattern.test(output())) continue;
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    };
    const waitFor = (pattern: RegExp, timeoutMs = 30_000): Promise<void> =>
      new Promise((resolve, reject) => {
        if (pattern.test(output())) return resolve();
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out after ${timeoutMs}ms waiting for ${pattern}; logs so far:\n${output()}`,
            ),
          );
        }, timeoutMs);
        waiters.push({ pattern, resolve, timer });
      });

    const exited = new Promise<{ code: number | null; elapsedMs: number }>((resolve) => {
      child.on('exit', (code) => resolve({ code, elapsedMs: Date.now() - startedAt }));
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      settleWaiters();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      settleWaiters();
    });

    return { child, exited, waitFor, output };
  }

  it('retries inside the window, then exits non-zero behind one fatal line', async () => {
    const boot = spawnBoot({
      DATABASE_URL: `postgres://hubuser:${SECRET}@127.0.0.1:1/boot_diagnostics`,
      MISSION_HUB_DB_RETRY_WINDOW_MS: '800',
      MISSION_HUB_DB_RETRY_INITIAL_MS: '150',
      MISSION_HUB_DB_RETRY_MAX_MS: '300',
      PORT: '0',
    });

    const { code, elapsedMs } = await boot.exited;
    const log = boot.output();
    const lines = log.split('\n').filter((line) => line.trim().length > 0);

    expect(code).toBe(1);

    // The startup line names the effective configuration, hosts listed not counted.
    const bootLine = lines[0];
    expect(bootLine).toMatch(
      /^\[mission-hub\] env=development allowed_hosts=\S+ db=127\.0\.0\.1:1\/boot_diagnostics$/,
    );
    expect(/allowed_hosts=(\S+)/.exec(bootLine)?.[1]).not.toMatch(/^\d+$/);

    // It retried instead of dying on the first refusal, and waited for them.
    const retries = lines.filter((line) => line.includes('retrying migrations in'));
    expect(retries.length).toBeGreaterThanOrEqual(2);
    expect(retries[0]).toContain('within a 800ms window');
    expect(elapsedMs).toBeGreaterThanOrEqual(750);

    // Exactly one fatal line, last, naming the target; no stack dump, no secret.
    const fatals = lines.filter((line) => line.includes('fatal: migrations failed:'));
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toMatch(
      /fatal: migrations failed: .+: 127\.0\.0\.1:1\/boot_diagnostics$/,
    );
    expect(lines.at(-1)).toBe(fatals[0]);
    expect(log).not.toContain(SECRET);
  }, 30_000);

  it('starts and answers /health once the database appears inside the window', async (ctx) => {
    // Needs a live PostgreSQL to proxy to: the suite convention is to skip
    // database-dependent tests when DATABASE_URL is absent (db-schema.test.ts).
    if (!liveDatabaseUrl) ctx.skip();
    const databaseUrl = liveDatabaseUrl as string;
    const upstream = new URL(databaseUrl);

    const proxyPort = await freePort();
    // The proxy is the late database: it is not listening yet, so the child
    // meets a refused connection first. Opening it is deferred until the child
    // has provably retried — that is what makes "the database appears inside
    // the window" deterministic instead of a race on the child's startup time.
    const proxy = startGatedProxy({
      listenPort: proxyPort,
      targetPort: Number(upstream.port || 5432),
    });

    const target = new URL(upstream.toString());
    target.hostname = '127.0.0.1';
    target.port = String(proxyPort);

    const boot = spawnBoot({
      DATABASE_URL: target.toString(),
      MISSION_HUB_DB_RETRY_WINDOW_MS: '20000',
      MISSION_HUB_DB_RETRY_INITIAL_MS: '300',
      MISSION_HUB_DB_RETRY_MAX_MS: '1000',
      PORT: '0',
    });

    try {
      // Proof of the gap, read before the database is allowed to appear: the
      // child meets a closed port, retries, and only then does `open()` land.
      await boot.waitFor(/retrying migrations in/);
      await proxy.open();
      await boot.waitFor(/database became reachable after/);
      await boot.waitFor(/listening on http:\/\//);
      const log = boot.output();
      const listeningPort = /listening on http:\/\/[^\s]*:(\d+)/.exec(log)?.[1];
      expect(listeningPort).toBeDefined();

      // It really tolerated the gap rather than winning the race by luck.
      expect(log).toContain('retrying migrations in');
      expect(log).toContain('database became reachable after');

      const health = await fetch(`http://127.0.0.1:${listeningPort}/health`, {
        headers: { Host: '127.0.0.1' },
      });
      expect(health.status).toBe(200);
      // The payload also carries the build identity, so assert the field this
      // test is about rather than pinning the whole object.
      await expect(health.json()).resolves.toMatchObject({ status: 'ok' });

      const ready = await fetch(`http://127.0.0.1:${listeningPort}/ready`, {
        headers: { Host: '127.0.0.1' },
      });
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toEqual({ status: 'ready' });

      // The real credential never reaches the log, on the retry path either.
      // Matched as the `user:password` pair rather than the bare password: a
      // leak necessarily carries the pair, while a bare password can coincide
      // with an innocuous token (this fixture's password IS its database name).
      // Asserted per line so a failure shows the offending line with the
      // credential masked, never the credential itself.
      const user = decodeURIComponent(upstream.username);
      const password = decodeURIComponent(upstream.password);
      const credentialPair = `${user}:${password}`;
      if (user && password) {
        const leaking = log
          .split('\n')
          .filter((line) => line.includes(credentialPair))
          .map((line) => line.replaceAll(credentialPair, '[REDACTED]'));
        expect(leaking).toEqual([]);
      }
      expect(log).not.toContain(SECRET);
    } finally {
      boot.child.kill('SIGKILL');
      await boot.exited;
      await proxy.close();
    }
  }, 60_000);
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * TCP forwarder the test opens by hand: it is closed at spawn time and starts
 * accepting only when `open()` runs, so "the database appears later" is driven
 * by the test instead of by a timer racing the child's startup.
 */
function startGatedProxy(options: {
  listenPort: number;
  targetPort: number;
}): { open: () => Promise<void>; close: () => Promise<void> } {
  const sockets = new Set<ReturnType<typeof connect>>();

  const server = createServer((client) => {
    const upstream = connect(options.targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));

    const drop = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  // Returns before listening on purpose: the caller spawns the process that
  // must find this port closed first, and opens the gate itself once it has
  // proof the process retried.
  let listening = false;

  return {
    open: async (): Promise<void> => {
      if (listening) return;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.listenPort, '127.0.0.1', () => {
          listening = true;
          resolve();
        });
      });
    },
    close: async (): Promise<void> => {
      // `server.close()` only settles once every connection is gone, and the
      // booted process keeps a pool open until it is killed — so drop the
      // sockets we know about instead of waiting for the client to hang up.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

