import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadClientCredentials } from './auth/config.js';
import { runMigrations } from './db/migrate.js';
import { MissionHubStore } from './db/store.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await runMigrations(pool);

const store = new MissionHubStore(pool);
const app = createApp(store, loadClientCredentials());

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.error(`[mission-hub] listening on http://${hostname}:${info.port}`);
});
