-- Delegated run writes (operator decision 2026-10-24, option B).
--
-- A claim holder remains the only mission writer, but it may name the clients it
-- delegates work to. A delegated client may then record summaries and evidence on
-- runs it owns inside that mission, while the claim is active. Delegations belong
-- to a claim row, so they stop applying the moment that claim is released or
-- expires: the guard reads the *active* claim and joins on its id.

CREATE TABLE claim_delegations (
  id SERIAL PRIMARY KEY,
  claim_id INTEGER NOT NULL REFERENCES mission_claims(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_delegations_unique UNIQUE (claim_id, client_id)
);

CREATE INDEX claim_delegations_claim_idx ON claim_delegations(claim_id);
CREATE INDEX claim_delegations_client_idx ON claim_delegations(client_id);
