import {
  ALL_SERVICE_SCOPES,
  authenticateAdminBearer,
  authenticateBearer,
  extractBearerToken,
  hashToken,
  isPrivilegedScope,
  isScope,
  type ClientCredential,
  type Principal,
  type Scope,
} from './config.js';
import type { MissionHubStore } from '../db/store.js';

export interface AuthResolverOptions {
  envCredentials?: readonly ClientCredential[];
  adminToken?: string;
  /** Client ids the operator allowlisted for `approvals:human` (and nothing else). */
  approverClients?: ReadonlySet<string>;
}

export async function resolvePrincipal(
  authorization: string | undefined,
  store: MissionHubStore,
  options: AuthResolverOptions = {},
): Promise<Principal | null> {
  const admin = authenticateAdminBearer(authorization, options.adminToken);
  if (admin) {
    return admin;
  }

  const envPrincipal = authenticateBearer(
    authorization,
    options.envCredentials ?? [],
  );
  if (envPrincipal) {
    return envPrincipal;
  }

  const token = extractBearerToken(authorization);
  if (!token) {
    return null;
  }

  const row = await store.findActiveClientByTokenHash(hashToken(token));
  if (!row) {
    return null;
  }

  const scopes = new Set<Scope>();
  for (const scope of row.scopes) {
    // clients:admin is admin-token only; verify:admin may be present on seeded DB clients.
    if (isScope(scope) && !isPrivilegedScope(scope)) {
      scopes.add(scope);
    }
  }
  // The allowlist is the only path to `approvals:human`: it is not mintable, and a
  // scope stored in the row alone is filtered out above like any other privileged one.
  if (options.approverClients?.has(row.client_id)) {
    scopes.add('approvals:human');
  }

  void store.touchClientLastUsed(row.id).catch(() => undefined);

  return {
    clientId: row.client_id,
    scopes,
  };
}

/** HTTP failure an authentication attempt maps to. */
export type AuthFailure =
  | { status: 400; body: { error: 'invalid_authorization' } }
  | { status: 401; body: { error: 'unauthorized' } }
  | { status: 403; body: { error: 'insufficient_scope'; required: Scope[] } };

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; failure: AuthFailure };

/**
 * Parse an `Authorization` header, keeping "no credential presented" apart from
 * "a header that is not a credential". A caller that collapses both into `null`
 * cannot tell a client whether to present a token or to fix the one it sent.
 */
export function parseAuthorizationHeader(
  authorization: string | undefined,
): { kind: 'none' } | { kind: 'malformed' } | { kind: 'bearer'; token: string } {
  const header = authorization?.trim() ?? '';
  if (header.length === 0) {
    return { kind: 'none' };
  }

  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) {
    return { kind: 'malformed' };
  }

  return { kind: 'bearer', token: match[1] };
}

/**
 * Authenticate then authorize, preserving *why* a request was refused:
 *
 * - `401 unauthorized` — no credential presented, or none of the env clients,
 *   the admin token, or an active client row matches the token (unknown or
 *   revoked).
 * - `400 invalid_authorization` — an `Authorization` header was presented but is
 *   not a `Bearer <token>` credential.
 * - `403 insufficient_scope` — the credential is valid but under-scoped;
 *   `required` names exactly the scopes the route needed.
 */
export async function authenticateAndAuthorize(
  authorization: string | undefined,
  store: MissionHubStore,
  options: AuthResolverOptions,
  required: readonly Scope[],
): Promise<AuthResult> {
  const parsed = parseAuthorizationHeader(authorization);
  if (parsed.kind === 'malformed') {
    return {
      ok: false,
      failure: { status: 400, body: { error: 'invalid_authorization' } },
    };
  }
  if (parsed.kind === 'none') {
    return {
      ok: false,
      failure: { status: 401, body: { error: 'unauthorized' } },
    };
  }

  const principal = await resolvePrincipal(authorization, store, options);
  if (!principal) {
    return {
      ok: false,
      failure: { status: 401, body: { error: 'unauthorized' } },
    };
  }

  const missing = required.filter((scope) => !principal.scopes.has(scope));
  if (missing.length > 0) {
    return {
      ok: false,
      failure: {
        status: 403,
        body: { error: 'insufficient_scope', required: missing },
      },
    };
  }

  return { ok: true, principal };
}

export async function seedEnvClients(
  store: MissionHubStore,
  credentials: readonly ClientCredential[],
): Promise<number> {
  let seeded = 0;
  for (const credential of credentials) {
    const scopes = [...credential.scopes].filter(
      (scope): scope is Scope =>
        scope !== 'clients:admin' && ALL_SERVICE_SCOPES.includes(scope),
    );
    await store.upsertClientFromPlaintext(
      credential.clientId,
      credential.token,
      scopes,
    );
    seeded += 1;
  }
  return seeded;
}
