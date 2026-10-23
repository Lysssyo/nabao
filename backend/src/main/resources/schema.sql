CREATE TABLE IF NOT EXISTS quota_source (
    author_id VARCHAR(80) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    profile_url VARCHAR(500) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS quota_observation (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    observation_key CHAR(64) NOT NULL UNIQUE,
    payload_hash CHAR(64) NOT NULL,
    author_id VARCHAR(80) NOT NULL,
    note_id VARCHAR(100) NOT NULL,
    note_revision VARCHAR(128) NOT NULL,
    fund_code CHAR(6) NOT NULL,
    fund_name VARCHAR(200) NOT NULL,
    channel_scope VARCHAR(20) NOT NULL,
    business_type VARCHAR(20) NOT NULL,
    quota_period VARCHAR(20) NOT NULL,
    limit_kind VARCHAR(20) NOT NULL,
    amount_minor BIGINT,
    currency VARCHAR(20) NOT NULL,
    observed_for_date DATE NOT NULL,
    source_published_at TIMESTAMP(6) NOT NULL,
    source_updated_at TIMESTAMP(6),
    captured_at TIMESTAMP(6) NOT NULL,
    evidence_ref VARCHAR(2000) NOT NULL,
    source_group_id VARCHAR(128),
    received_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT fk_observation_author FOREIGN KEY (author_id) REFERENCES quota_source(author_id),
    CONSTRAINT ck_observation_amount CHECK (
        (limit_kind = 'LIMITED' AND amount_minor IS NOT NULL AND amount_minor >= 0)
        OR (limit_kind <> 'LIMITED' AND amount_minor IS NULL)
    ),
    INDEX idx_observation_fund_date (fund_code, observed_for_date),
    INDEX idx_observation_author (author_id, observed_for_date)
);

CREATE TABLE IF NOT EXISTS quota_note_snapshot (
    snapshot_key CHAR(64) PRIMARY KEY,
    payload_hash CHAR(64) NOT NULL,
    author_id VARCHAR(80) NOT NULL,
    note_id VARCHAR(100) NOT NULL,
    note_revision VARCHAR(128) NOT NULL,
    source_published_at TIMESTAMP(6) NOT NULL,
    source_updated_at TIMESTAMP(6),
    captured_at TIMESTAMP(6) NOT NULL,
    evidence_ref VARCHAR(2000) NOT NULL,
    active BOOLEAN NOT NULL,
    received_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT fk_snapshot_author FOREIGN KEY (author_id) REFERENCES quota_source(author_id),
    INDEX idx_snapshot_note (author_id, note_id, active)
);

CREATE TABLE IF NOT EXISTS collector_run (
    run_id VARCHAR(120) PRIMARY KEY,
    started_at TIMESTAMP(6) NOT NULL,
    finished_at TIMESTAMP(6) NOT NULL,
    status VARCHAR(20) NOT NULL,
    report_json TEXT NOT NULL,
    INDEX idx_run_started (started_at)
);

CREATE TABLE IF NOT EXISTS push_device (
    installation_id CHAR(36) PRIMARY KEY,
    secret_hash CHAR(64) NOT NULL,
    device_token VARCHAR(512) NOT NULL,
    environment VARCHAR(16) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    baseline_digest CHAR(64),
    last_accepted_digest CHAR(64),
    pending_digest CHAR(64),
    retry_count INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP(6),
    last_error VARCHAR(64),
    token_version BIGINT NOT NULL DEFAULT 0,
    registered_at TIMESTAMP(6) NOT NULL,
    created_at TIMESTAMP(6) NOT NULL,
    CONSTRAINT uq_push_token_environment UNIQUE (environment, device_token),
    INDEX idx_push_active_environment (active, environment)
);

INSERT INTO quota_source (author_id, name, profile_url, enabled)
SELECT '6168030000000000020278b5', '老纳',
       'https://www.xiaohongshu.com/user/profile/6168030000000000020278b5', TRUE
WHERE NOT EXISTS (SELECT 1 FROM quota_source WHERE author_id = '6168030000000000020278b5');

INSERT INTO quota_source (author_id, name, profile_url, enabled)
SELECT '64ea885c0000000001004087', '纳宝',
       'https://www.xiaohongshu.com/user/profile/64ea885c0000000001004087', TRUE
WHERE NOT EXISTS (SELECT 1 FROM quota_source WHERE author_id = '64ea885c0000000001004087');
