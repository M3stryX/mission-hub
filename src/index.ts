import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import {
  assertHostAllowlistConfigured,
  createApp,
  getAllowedHosts,
  getStage,
} from './app.js';
import {
  loadAdminToken,
  loadClientCredentials,
} from './auth/config.js';
import { seedEnvClients } from './auth/resolve.js';
import { runMigrations } from './db/migrate.js';
import { MissionHubStore } from './db/store.js';

// Fail fast on a misconfigured deployment: outside development the Host
// allowlist must be declared, otherwise every request would be refused with 403.
assertHostAllowlistConfigured();
console.error(
  `[mission-hub] stage=${getStage()} allowed_hosts=${getAllowedHosts().length}`,
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// A pooled connection can die while it sits idle (database restart, failover,
// admin `pg_terminate_backend`, network reset). pg emits `error` on the pool for
// those clients; with no listener Node treats it as an unhandled `error` event
// and kills the process, so the HTTP surface disappears instead of degrading.
// Log it and keep the process alive: affected clients are discarded by the pool
// and the next query opens a fresh connection, so /ready can answer 503.
pool.on('error', (error) => {
  console.error('[mission-hub] idle pool client error:', error.message);
});

await runMigrations(pool);

const store = new MissionHubStore(pool);
const envCredentials = loadClientCredentials();
const seeded = await seedEnvClients(store, envCredentials);
if (seeded > 0) {
  console.error(`[mission-hub] seeded ${seeded} client(s) from MISSION_HUB_CLIENTS_JSON`);
}

const app = createApp(store, {
  envCredentials,
  adminToken: loadAdminToken(),
});

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.error(`[mission-hub] listening on http://${hostname}:${info.port}`);
});
