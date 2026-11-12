-- Keep receipt identity and the privacy notice supplied with each acceptance.
-- Historical privacy versions are unknown: never infer them from today's rollout.
ALTER TABLE legal_acceptances ADD COLUMN receipt_id TEXT;
ALTER TABLE legal_acceptances ADD COLUMN privacy_version TEXT;
ALTER TABLE legal_acceptances ADD COLUMN privacy_sha256 TEXT;
UPDATE legal_acceptances SET receipt_id='rcpt_'||lower(hex(randomblob(16)));
CREATE UNIQUE INDEX legal_receipt_id ON legal_acceptances(receipt_id);
ALTER TABLE developer_mail ADD COLUMN receipt_id TEXT;

-- Retention bookkeeping may change, but the original receipt evidence may not.
CREATE TRIGGER immutable_acceptance_evidence BEFORE UPDATE OF
  owner_id,version,edition,sha256,accepted_at,requirement_revision,
  receipt_id,privacy_version,privacy_sha256 ON legal_acceptances
BEGIN SELECT RAISE(ABORT,'ACCEPTANCE_EVIDENCE_IMMUTABLE'); END;
