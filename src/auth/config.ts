import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type Scope =
  | 'missions:read'
  | 'missions:write'
  | 'runs:read'
  | 'runs:write'
  | 'summaries:read'
  | 'summaries:write'
  | 'evidence:read'
  | 'evidence:write'
  | 'clients:admin'
  | 'verify:admin'
  | 'approvals:human';

/**
 * Scopes usable by seeded service clients (env JSON / DB).
 * Includes verify:admin for the dedicated staging verify credential.
 */
export const ALL_SERVICE_SCOPES: readonly Scope[] = [
  'missions:read',
  'missions:write',
  'runs:read',
  'runs:write',
  'summaries:read',
  'summaries:write',
  'evidence:read',
  'evidence:write',
  'verify:admin',
  'approvals:human',
];

/** Scopes that may only come from the admin mint token principal. */
export const PRIVILEGED_SCOPES: readonly Scope[] = [
  'clients:admin',
  'approvals:human',
];

/**
 * Scopes that must never be granted via POST /admin/clients mint.
 * verify:admin is seedable for the staging verify client, but not mintable.
 */
export const MINT_FORBIDDEN_SCOPES: readonly Scope[] = [
  'clients:admin',
  'verify:admin',
  'approvals:human',
];

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

const VALID_SCOPES = new Set<string>([
  ...ALL_SERVICE_SCOPES,
  ...PRIVILEGED_SCOPES,
]);

export function isScope(value: string): value is Scope {
  return VALID_SCOPES.has(value);
}

export function isPrivilegedScope(value: Scope): boolean {
  return (PRIVILEGED_SCOPES as readonly string[]).includes(value);
}

export function isMintForbiddenScope(value: Scope): boolean {
  return (MINT_FORBIDDEN_SCOPES as readonly string[]).includes(value);
}

export function parseScopes(values: readonly string[]): Scope[] {
  const scopes: Scope[] = [];
  for (const value of values) {
    if (!isScope(value)) {
      throw new Error(`invalid_scope:${value}`);
    }
    if (isMintForbiddenScope(value)) {
      throw new Error(`${value}_cannot_be_granted_to_service_clients`);
    }
    scopes.push(value);
  }
  return scopes;
}

/**
 * Client ids allowed to hold `approvals:human`.
 *
 * The scope stays privileged and mint-forbidden: no `POST /admin/clients` and no
 * `MISSION_HUB_CLIENTS_JSON` entry can grant it, because a service credential that
 * can approve its own plans is not an approval. Only this explicit, operator-set
 * allowlist can — and without it the scope is unreachable from every source, which
 * is what made `missions.planApproval` answer `403 insufficient_scope` to every
 * principal (measured on staging, 2026-10-24).
 */
export function loadApproverClients(
  raw = process.env.MISSION_HUB_APPROVER_CLIENTS,
): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * Allowlisted ids that no environment client carries.
 *
 * The allowlist grants nothing by itself: it only promotes a client declared in
 * `MISSION_HUB_CLIENTS_JSON`. A typo therefore becomes a silent `403` on plan
 * approval — the exact failure this whole mechanism exists to end — so the boot
 * line has to name it.
 */
export function findOrphanApprovers(
  approvers: ReadonlySet<string>,
  credentials: readonly ClientCredential[],
): string[] {
  const declared = new Set(credentials.map((credential) => credential.clientId));
  return [...approvers].filter((clientId) => !declared.has(clientId)).sort();
}

export function loadClientCredentials(
  raw = process.env.MISSION_HUB_CLIENTS_JSON,
  approvers: ReadonlySet<string> = new Set<string>(),
): ClientCredential[] {
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw) as Record<string, ClientConfigEntry>;

  return Object.entries(parsed).map(([clientId, entry]) => {
    const scopes = new Set<Scope>();
    const dropped: string[] = [];

    for (const scope of entry.scopes) {
      if (!isScope(scope)) {
        dropped.push(`${scope}(not_a_scope)`);
        continue;
      }
      if (isPrivilegedScope(scope)) {
        // `approvals:human` is the one privileged scope an operator may grant, and
        // only by naming the client id in MISSION_HUB_APPROVER_CLIENTS.
        if (scope === 'approvals:human' && approvers.has(clientId)) {
          scopes.add(scope);
          continue;
        }
        dropped.push(`${scope}(privileged)`);
        continue;
      }
      scopes.add(scope);
    }

    // A silently dropped scope becomes a 403 hours later, on a credential the
    // operator believes they configured. Name it once, at boot.
    if (dropped.length > 0) {
      console.error(
        `[mission-hub] client=${clientId} scopes=${scopes.size} dropped=${dropped.join(',')}`,
      );
    }

    return { clientId, token: entry.token, scopes };
  });
}

export function loadAdminToken(
  raw = process.env.MISSION_HUB_ADMIN_TOKEN,
): string | undefined {
  const token = raw?.trim();
  return token ? token : undefined;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 10);
}

export function generateClientToken(): string {
  return `mh_${randomBytes(24).toString('base64url')}`;
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

export function authenticateAdminBearer(
  authorization: string | undefined,
  adminToken: string | undefined,
): Principal | null {
  if (!adminToken || !authorization?.startsWith('Bearer ')) {
    return null;
  }

  const token = authorization.slice('Bearer '.length);
  if (!safeTokenEqual(token, adminToken)) {
    return null;
  }

  return {
    clientId: 'admin',
    scopes: new Set<Scope>(['clients:admin']),
  };
}

export function extractBearerToken(
  authorization: string | undefined,
): string | null {
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }
  const token = authorization.slice('Bearer '.length);
  return token.length > 0 ? token : null;
}

export function hasScopes(
  principal: Principal,
  required: readonly Scope[],
): boolean {
  return required.every((scope) => principal.scopes.has(scope));
}
