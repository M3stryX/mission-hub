import 'dotenv/config';
import { Pool } from 'pg';
import {
  ALL_SERVICE_SCOPES,
  parseScopes,
  type Scope,
} from '../src/auth/config.js';
import { MissionHubStore } from '../src/db/store.js';

function usage(): never {
  console.error(`Usage:
  pnpm clients list
  pnpm clients create <clientId> --scopes <scope>[,<scope>...]
  pnpm clients revoke <clientId>

Service scopes: ${ALL_SERVICE_SCOPES.join(', ')}
`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  command: string;
  clientId?: string;
  scopes?: Scope[];
} {
  const [command, ...rest] = argv;
  if (!command) usage();

  if (command === 'list') {
    return { command };
  }

  if (command === 'revoke') {
    const clientId = rest[0];
    if (!clientId || clientId.startsWith('-')) usage();
    return { command, clientId };
  }

  if (command === 'create') {
    const clientId = rest[0];
    if (!clientId || clientId.startsWith('-')) usage();
    const scopesFlag = rest.indexOf('--scopes');
    if (scopesFlag < 0 || !rest[scopesFlag + 1]) usage();
    const scopes = parseScopes(
      rest[scopesFlag + 1].split(',').map((value) => value.trim()).filter(Boolean),
    );
    return { command, clientId, scopes };
  }

  usage();
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const { command, clientId, scopes } = parseArgs(process.argv.slice(2));
const pool = new Pool({ connectionString: databaseUrl });
const store = new MissionHubStore(pool);

try {
  if (command === 'list') {
    const clients = await store.listClients();
    console.log(JSON.stringify({ clients }, null, 2));
  } else if (command === 'create') {
    if (!clientId || !scopes) usage();
    const created = await store.createClient(clientId, scopes);
    console.log(
      JSON.stringify(
        {
          client: created.client,
          token: created.token,
          note: 'Store this token now; it will not be shown again.',
        },
        null,
        2,
      ),
    );
  } else if (command === 'revoke') {
    if (!clientId) usage();
    const client = await store.revokeClient(clientId);
    if (!client) {
      console.error(`client not found or already revoked: ${clientId}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ client }, null, 2));
  } else {
    usage();
  }
} finally {
  await pool.end();
}
