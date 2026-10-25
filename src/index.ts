import 'dotenv/config';
import { writeSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import {
  assertHostAllowlistConfigured,
  createApp,
  allowedHostsFor,
  getEnv,
} from './app.js';
import {
  describeDatabaseTarget,
  formatBootLine,
  formatDatabaseRetryLine,
  formatMigrationFailureLine,
  resolveDbRetryPolicy,
  runMigrationsWithRetry,
} from './boot.js';
import {
  countEffectiveApprovers,
  findOrphanApprovers,
  loadAdminToken,
  loadApproverClients,
  loadClientCredentials,
} from './auth/config.js';
import { seedEnvClients } from './auth/resolve.js';
import { MissionHubStore } from './db/store.js';

// Fail fast on a misconfigured deployment: outside development the Host
// allowlist must be declared, otherwise every request would be refused with 403.
assertHostAllowlistConfigured();

const databaseUrl = process.env.DATABASE_URL;
const databaseTarget = describeDatabaseTarget(databaseUrl);
const retryPolicy = resolveDbRetryPolicy();

// The one startup line, naming the effective configuration: the environment,
// the host list the request guard applies, and the database target
// (host:port/dbname, never the credentials). A deployment whose log stops here
// is either a dead process or a database that never came up — and this line is
// what tells the two apart without shelling into the host.
console.error(
  formatBootLine({
    env: getEnv(),
    allowedHosts: allowedHostsFor(),
    databaseTarget,
  }),
);

const pool = new Pool({ connectionString: databaseUrl });

// A pooled connection can die while it sits idle (database restart, failover,
// admin `pg_terminate_backend`, network reset). pg emits `error` on the pool for
// those clients; with no listener Node treats it as an unhandled `error` event
// and kills the process, so the HTTP surface disappears instead of degrading.
// Log it and keep the process alive: affected clients are discarded by the pool
// and the next query opens a fresh connection, so /ready can answer 503.
pool.on('error', (error) => {
  console.error('[mission-hub] idle pool client error:', error.message);
});

try {
  // The database legitimately starts after the application in compose and
  // orchestration, so keep trying inside the retry window before giving up.
  await runMigrationsWithRetry(pool, {
    policy: retryPolicy,
    onRetry: ({ attempt, delayMs, error }) => {
      console.error(
        formatDatabaseRetryLine({
          error,
          delayMs,
          attempt,
          windowMs: retryPolicy.windowMs,
          databaseTarget,
          connectionString: databaseUrl,
        }),
      );
    },
    onRecovered: ({ attempts, elapsedMs }) => {
      console.error(
        `[mission-hub] database became reachable after ${elapsedMs}ms ` +
          `(${attempts} attempts)`,
      );
    },
  });
} catch (error) {
  const line = formatMigrationFailureLine(error, databaseTarget, databaseUrl);
  // Written synchronously to fd 2 on purpose: `process.exit()` can drop a
  // queued async stderr write on a pipe, and this is the one line the platform
  // has to show. No stack trace follows it — the cause is already in the line.
  writeSync(2, `${line}\n`);
  process.exit(1);
}

const store = new MissionHubStore(pool);
const approverClients = loadApproverClients();
if (approverClients.size > 0) {
  console.error(
    `[mission-hub] approver allowlist (approvals:human) = ${[...approverClients].join(',')}`,
  );
}
const envCredentials = loadClientCredentials(undefined, approverClients);
const orphanApprovers = findOrphanApprovers(approverClients, envCredentials);
if (orphanApprovers.length > 0) {
  console.error(
    `[mission-hub] MISSION_HUB_APPROVER_CLIENTS names no environment client: ${orphanApprovers.join(',')} — those ids keep answering 403 insufficient_scope on plan approval`,
  );
}
const effectiveApprovers = countEffectiveApprovers(approverClients, envCredentials);
if (effectiveApprovers === 0) {
  console.error(
    '[mission-hub] no approver configured: plan approval will answer 403 insufficient_scope to EVERY principal. Set MISSION_HUB_APPROVER_CLIENTS to an environment client id to enable it.',
  );
}
const seeded = await seedEnvClients(store, envCredentials);
if (seeded > 0) {
  console.error(`[mission-hub] seeded ${seeded} client(s) from MISSION_HUB_CLIENTS_JSON`);
}

const app = createApp(store, {
  envCredentials,
  adminToken: loadAdminToken(),
  approverClients,
});

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.error(`[mission-hub] listening on http://${hostname}:${info.port}`);
});
