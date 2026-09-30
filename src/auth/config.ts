import { timingSafeEqual } from 'node:crypto';

export type Scope =
  | 'missions:read'
  | 'missions:write'
  | 'runs:read'
  | 'runs:write'
  | 'summaries:read'
  | 'summaries:write'
  | 'evidence:read'
  | 'evidence:write';

export interface ClientCredential {
  clientId: string;
  token: string;
  scopes: ReadonlySet<Scope>;
}

export interface Principal {
  clientId: string;
  scopes: ReadonlySet<Scope>;
}

interface ClientConfigEntry {
  token: string;
  scopes: Scope[];
}

export function loadClientCredentials(
  raw = process.env.MISSION_HUB_CLIENTS_JSON,
): ClientCredential[] {
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw) as Record<string, ClientConfigEntry>;

  return Object.entries(parsed).map(([clientId, entry]) => ({
    clientId,
    token: entry.token,
    scopes: new Set(entry.scopes),
  }));
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function authenticateBearer(
  authorization: string | undefined,
  credentials: readonly ClientCredential[],
): Principal | null {
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  const token = authorization.slice('Bearer '.length);

  for (const credential of credentials) {
    if (safeTokenEqual(token, credential.token)) {
      return {
        clientId: credential.clientId,
        scopes: credential.scopes,
      };
    }
  }

  return null;
}

export function hasScopes(
  principal: Principal,
  required: readonly Scope[],
): boolean {
  return required.every((scope) => principal.scopes.has(scope));
}
