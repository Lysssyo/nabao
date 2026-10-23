-- Apply once only to databases whose existing push_device table predates token ownership.
-- Fresh schema.sql installations already have this constraint.
-- Conflicting legacy registrations must be resolved explicitly before running it.
ALTER TABLE push_device
    ADD CONSTRAINT uq_push_token_environment UNIQUE (environment, device_token);
