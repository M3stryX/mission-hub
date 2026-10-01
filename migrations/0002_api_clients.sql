CREATE TABLE api_clients (
  id SERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  CONSTRAINT api_clients_client_id_unique UNIQUE (client_id),
  CONSTRAINT api_clients_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX api_clients_active_hash_idx
  ON api_clients(token_hash)
  WHERE revoked_at IS NULL;
