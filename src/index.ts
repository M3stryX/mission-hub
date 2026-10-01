import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createApp } from './app.js';
import {
  loadAdminToken,
  loadClientCredentials,
} from './auth/config.js';
import { seedEnvClients } from './auth/resolve.js';
import { runMigrations } from './db/migrate.js';
import { MissionHubStore } from './db/store.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
