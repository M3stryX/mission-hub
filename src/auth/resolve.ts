import {
  ALL_SERVICE_SCOPES,
  authenticateAdminBearer,
  authenticateBearer,
  extractBearerToken,
  hashToken,
  hasScopes,
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

  void store.touchClientLastUsed(row.id).catch(() => undefined);

  return {
    clientId: row.client_id,
    scopes,
  };
}

export async function requirePrincipal(
  authorization: string | undefined,
  store: MissionHubStore,
  options: AuthResolverOptions,
  required: readonly Scope[],
): Promise<Principal | null> {
  const principal = await resolvePrincipal(authorization, store, options);
  if (!principal || !hasScopes(principal, required)) {
    return null;
  }
  return principal;
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
