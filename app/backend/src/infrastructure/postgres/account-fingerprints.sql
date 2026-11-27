CREATE TABLE account_credential_fingerprints (
  account_id uuid NOT NULL REFERENCES provider_accounts ON DELETE CASCADE,
  fingerprint bytea NOT NULL,
  PRIMARY KEY (account_id, fingerprint)
);
CREATE INDEX account_credential_fingerprint_lookup ON account_credential_fingerprints(fingerprint);
