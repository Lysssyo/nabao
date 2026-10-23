package com.nabao;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static com.nabao.PushController.*;
import static com.nabao.QuotaModels.*;

@Service
public class PushService {
    static final int FAST_RETRY_ATTEMPTS = 5;
    private final JdbcTemplate jdbc;
    private final QuotaService quotas;
    private final ApnsClient apns;
    private final ObjectMapper json;
    private final DailyTableService tables;
    private final TablePushState tablePushState;
    private final boolean tableSource;
    private final Object feedLock = new Object();

    private record Device(String id, String secretHash, String token, String environment, boolean active,
                          String baseline, String accepted, String pending, int retryCount,
                          Instant nextAttempt, long version, Instant registeredAt, Instant createdAt) {}
    private record Feed(String digest, boolean empty) {}
    private record SemanticQuota(String fundCode, String channelScope, String businessType, String period,
                                 String currency, String date, String status, String limitKind, Long amountMinor,
                                 List<String> alternatives) {}

    public PushService(JdbcTemplate jdbc, QuotaService quotas, ApnsClient apns, ObjectMapper json,
                       DailyTableService tables, TablePushState tablePushState,
                       @Value("${nabao.push-data-source:table}") String dataSource) {
        if (!Set.of("table", "legacy").contains(dataSource)) throw new IllegalArgumentException("Unsupported push data source");
        this.jdbc = jdbc;
        this.quotas = quotas;
        this.apns = apns;
        this.json = json;
        this.tables = tables;
        this.tablePushState = tablePushState;
        this.tableSource = dataSource.equals("table");
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public Registered register(Registration input) {
        synchronized (feedLock) { return registerWithBaseline(input); }
    }

    private Registered registerWithBaseline(Registration input) {
        String id = canonicalId(input.installationId());
        String secretHash = secretHash(id, input.installationSecret());
        Instant now = Instant.now();
        Device existing = find(id, true);
        if (existing == null) {
            Feed feed = feed();
            try {
                jdbc.update("""
                        INSERT INTO push_device (installation_id, secret_hash, device_token, environment,
                        active, baseline_digest, retry_count, token_version, registered_at, created_at)
                        VALUES (?, ?, ?, ?, TRUE, ?, 0, 0, ?, ?)
                        """, id, secretHash, input.token(), input.environment(), feed == null || feed.empty() ? null : feed.digest(),
                        Timestamp.from(now), Timestamp.from(now));
            } catch (DuplicateKeyException raced) {
                existing = find(id, true);
                if (existing == null) throw tokenOwned();
            }
        }
        if (existing != null) {
            authorize(existing, secretHash);
            boolean changedToken = !existing.token().equals(input.token()) || !existing.environment().equals(input.environment());
            try {
                if (changedToken || !existing.active()) {
                    jdbc.update("""
                        UPDATE push_device SET device_token=?, environment=?, active=TRUE, retry_count=0,
                        next_attempt_at=?, last_error=NULL, token_version=token_version+1, registered_at=?
                        WHERE installation_id=?
                        """, input.token(), input.environment(), Timestamp.from(now), Timestamp.from(now), id);
                } else {
                    // A fresh APNs registration supersedes any older response, even for the same token.
                    // Preserve the pending retry schedule so repeated registration cannot flood APNs.
                    jdbc.update("UPDATE push_device SET registered_at=?, token_version=token_version+1 WHERE installation_id=?",
                            Timestamp.from(now), id);
                }
            } catch (DuplicateKeyException conflict) {
                throw tokenOwned();
            }
        }
        Device device = find(id, false);
        ApnsClient.Status provider = apns.status();
        boolean environmentMatches = input.environment().equals(provider.environment());
        String providerStatus = provider.enabled() && !environmentMatches ? "ENVIRONMENT_MISMATCH" : provider.status();
        return new Registered(id, "REGISTERED", provider.enabled() && environmentMatches && device.active(),
                providerStatus, input.environment());
    }

    @Transactional
    public void unregister(String installationId, String secret) {
        String id = canonicalId(installationId);
        if (secret == null || !secret.matches("[A-Za-z0-9_+/=-]{32,256}")) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid installation key");
        }
        Device device = find(id, true);
        if (device == null) return;
        authorize(device, secretHash(id, secret));
        jdbc.update("DELETE FROM push_device WHERE installation_id=?", id);
    }

    @Scheduled(initialDelayString = "${nabao.apns.poll-delay-ms:60000}",
            fixedDelayString = "${nabao.apns.poll-delay-ms:60000}")
    public void scheduledPoll() { poll(Instant.now()); }

    // Package visibility permits deterministic clock control in tests, not an HTTP trigger.
    synchronized void poll(Instant now) {
        if (!apns.status().enabled()) return;
        Feed current;
        List<Device> devices;
        synchronized (feedLock) {
            current = feed();
            // A missing/partial public file is not a withdrawal. Preserve all cursors
            // and retry state until a complete table is available again.
            if (current == null) return;
            // Snapshot devices with the feed; a new registration must not receive an older revision.
            devices = jdbc.query("SELECT * FROM push_device WHERE active=TRUE AND environment=?",
                    this::device, apns.status().environment());
        }
        for (Device original : devices) {
            if (Thread.currentThread().isInterrupted()) return;
            Device device = original;
            if (device.baseline() == null && device.accepted() == null && device.pending() == null) {
                if (!current.empty()) {
                    jdbc.update("""
                            UPDATE push_device SET baseline_digest=? WHERE installation_id=? AND token_version=?
                            AND baseline_digest IS NULL AND last_accepted_digest IS NULL AND pending_digest IS NULL
                            """, current.digest(), device.id(), device.version());
                }
                continue;
            }
            String acknowledged = device.accepted() == null ? device.baseline() : device.accepted();
            if (current.digest().equals(acknowledged)) {
                if (device.pending() != null) jdbc.update("""
                        UPDATE push_device SET pending_digest=NULL, retry_count=0, next_attempt_at=NULL,
                        last_error=NULL WHERE installation_id=? AND token_version=?
                        """, device.id(), device.version());
                continue;
            }
            if (!current.digest().equals(device.pending())) {
                jdbc.update("""
                        UPDATE push_device SET pending_digest=?, retry_count=0, next_attempt_at=?, last_error=NULL
                        WHERE installation_id=? AND token_version=? AND active=TRUE
                        """, current.digest(), Timestamp.from(now), device.id(), device.version());
                device = find(device.id(), false);
                if (device == null || !device.active() || !current.digest().equals(device.pending())) continue;
            }
            // Re-read immediately before transport; an unsubscribe or token refresh may have
            // happened while this tick prepared other devices. Already in-flight sends may arrive.
            Device latest = find(device.id(), false);
            if (latest == null || !latest.active() || latest.version() != device.version()
                    || !latest.createdAt().equals(device.createdAt()) || !current.digest().equals(latest.pending())) continue;
            device = latest;
            if (device.nextAttempt() != null && device.nextAttempt().isAfter(now)) continue;
            ApnsClient.Result result = apns.send(device.token(), device.environment(), now);
            applyResult(device, current.digest(), result, now);
        }
    }

    private void applyResult(Device device, String digest, ApnsClient.Result result, Instant now) {
        String guard = " WHERE installation_id=? AND token_version=? AND pending_digest=? AND active=TRUE AND created_at=?";
        switch (result.outcome()) {
            case ACCEPTED -> jdbc.update("""
                    UPDATE push_device SET last_accepted_digest=?, pending_digest=NULL, retry_count=0,
                    next_attempt_at=NULL, last_error=NULL
                    """ + guard, digest, device.id(), device.version(), digest, Timestamp.from(device.createdAt()));
            case INVALID_DEVICE -> {
                if (result.invalidatedAt() != null && result.invalidatedAt().isBefore(device.registeredAt())) {
                    applyResult(device, digest, new ApnsClient.Result(ApnsClient.Outcome.RETRYABLE,
                            "STALE_INVALIDATION", 0, null), now);
                } else {
                    jdbc.update("UPDATE push_device SET active=FALSE, last_error=?, next_attempt_at=NULL" + guard,
                            result.reason(), device.id(), device.version(), digest, Timestamp.from(device.createdAt()));
                }
            }
            case RETRYABLE, REJECTED -> {
                int count = Math.min(FAST_RETRY_ATTEMPTS + 1, device.retryCount() + 1);
                long backoff = count > FAST_RETRY_ATTEMPTS || result.outcome() == ApnsClient.Outcome.REJECTED
                        ? 3600 : 60L << (count - 1);
                Timestamp next = Timestamp.from(now.plusSeconds(Math.max(backoff, result.retryAfterSeconds())));
                jdbc.update("UPDATE push_device SET retry_count=?, next_attempt_at=?, last_error=?" + guard,
                        count, next, result.reason(), device.id(), device.version(), digest, Timestamp.from(device.createdAt()));
            }
            case DISABLED -> { /* Never acknowledge a notification that was not submitted. */ }
        }
    }

    private Feed feed() {
        if (tableSource) {
            DailyTableService.Table table;
            try { table = tables.read(); }
            catch (ResponseStatusException unavailable) { return null; }
            boolean hasCursor = Boolean.TRUE.equals(jdbc.queryForObject("""
                    SELECT COUNT(*) > 0 FROM push_device WHERE baseline_digest IS NOT NULL
                    OR last_accepted_digest IS NOT NULL OR pending_digest IS NOT NULL
                    """, Boolean.class));
            TablePushState.Feed current = tablePushState.update(table, hasCursor);
            return current == null ? null : new Feed(current.digest(), current.empty());
        }
        List<Quota> all = quotas.quotas(null);
        List<SemanticQuota> semantic = all.stream().map(quota -> {
            // Alternative values matter during conflicts; evidence URLs, authors and capture times do not.
            List<String> alternatives = quota.status() == ConsensusStatus.AGREED ? List.of()
                    : quota.votes().stream().filter(Vote::counted)
                    .map(vote -> vote.limitKind().name() + ":" + vote.amountMinor()).distinct().sorted().toList();
            return new SemanticQuota(quota.fundCode(), quota.channelScope().name(), quota.businessType().name(),
                    quota.period().name(), quota.currency().name(), quota.observedForDate().toString(),
                    quota.status().name(), quota.limitKind() == null ? null : quota.limitKind().name(),
                    quota.amountMinor(), alternatives);
        }).sorted(Comparator.comparing(row -> row.fundCode() + "|" + row.channelScope() + "|"
                + row.businessType() + "|" + row.period() + "|" + row.currency() + "|" + row.date())).toList();
        try {
            return new Feed(hash(json.writeValueAsBytes(semantic)), all.isEmpty());
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Unable to fingerprint public quotas");
        }
    }

    private Device find(String id, boolean lock) {
        List<Device> matches = jdbc.query("SELECT * FROM push_device WHERE installation_id=?" + (lock ? " FOR UPDATE" : ""),
                this::device, id);
        return matches.isEmpty() ? null : matches.getFirst();
    }

    private Device device(ResultSet row, int index) throws SQLException {
        Timestamp next = row.getTimestamp("next_attempt_at");
        return new Device(row.getString("installation_id"), row.getString("secret_hash"),
                row.getString("device_token"), row.getString("environment"), row.getBoolean("active"),
                row.getString("baseline_digest"), row.getString("last_accepted_digest"),
                row.getString("pending_digest"), row.getInt("retry_count"), next == null ? null : next.toInstant(),
                row.getLong("token_version"), row.getTimestamp("registered_at").toInstant(),
                row.getTimestamp("created_at").toInstant());
    }

    private static ResponseStatusException tokenOwned() {
        return new ResponseStatusException(HttpStatus.CONFLICT, "Push token already belongs to another installation");
    }

    private static String canonicalId(String value) {
        if (value == null || !value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid installation ID");
        }
        return UUID.fromString(value).toString();
    }

    private static void authorize(Device device, String suppliedHash) {
        if (!MessageDigest.isEqual(HexFormat.of().parseHex(device.secretHash()), HexFormat.of().parseHex(suppliedHash))) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid installation key");
        }
    }

    private static String secretHash(String id, String secret) {
        return hash(("nabao-push:" + id + ":" + secret).getBytes(StandardCharsets.UTF_8));
    }

    private static String hash(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("SHA-256 is unavailable"); }
    }
}
