package com.nabao.application;
import com.nabao.application.port.PushDeviceRepository;
import com.nabao.application.port.PushGateway;
import com.nabao.domain.DailyTableModels;
import com.nabao.domain.PushStateModels;


import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Isolation;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static com.nabao.domain.PushModels.*;
import static com.nabao.domain.QuotaModels.*;

@Service
public class PushService {
    static final int FAST_RETRY_ATTEMPTS = 5;
    private final PushDeviceRepository devices;
    private final QuotaService quotas;
    private final PushGateway apns;
    private final ObjectMapper json;
    private final DailyTableService tables;
    private final TablePushState tablePushState;
    private final boolean tableSource;
    private final Object feedLock = new Object();

    private record Feed(String digest, boolean empty) {}
    private record SemanticQuota(String fundCode, String channelScope, String businessType, String period,
                                 String currency, String date, String status, String limitKind, Long amountMinor,
                                 List<String> alternatives) {}

    public PushService(PushDeviceRepository devices, QuotaService quotas, PushGateway apns, ObjectMapper json,
                       DailyTableService tables, TablePushState tablePushState,
                       @Value("${nabao.push-data-source:table}") String dataSource) {
        if (!Set.of("table", "legacy").contains(dataSource)) throw new IllegalArgumentException("Unsupported push data source");
        this.devices = devices;
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
            if (!devices.insert(id, secretHash, input.token(), input.environment(),
                    feed == null || feed.empty() ? null : feed.digest(), now)) {
                existing = find(id, true);
                if (existing == null) throw tokenOwned();
            }
        }
        if (existing != null) {
            authorize(existing, secretHash);
            boolean changedToken = !existing.token().equals(input.token()) || !existing.environment().equals(input.environment());
            if (changedToken || !existing.active()) {
                if (!devices.refresh(id, input.token(), input.environment(), now)) throw tokenOwned();
            } else {
                // Preserve the pending retry schedule while invalidating older in-flight responses.
                devices.reconfirm(id, now);
            }
        }
        Device device = find(id, false);
        PushGateway.Status provider = apns.status();
        boolean environmentMatches = input.environment().equals(provider.environment());
        String providerStatus = provider.enabled() && !environmentMatches ? "ENVIRONMENT_MISMATCH" : provider.status();
        return new Registered(id, "REGISTERED", provider.enabled() && environmentMatches && device.active(),
                providerStatus, input.environment());
    }

    @Transactional
    public void unregister(String installationId, String secret) {
        String id = canonicalId(installationId);
        if (secret == null || !secret.matches("[A-Za-z0-9_+/=-]{32,256}")) {
            throw new ApplicationFailure(ApplicationFailure.Kind.UNAUTHORIZED, "Invalid installation key");
        }
        Device device = find(id, true);
        if (device == null) return;
        authorize(device, secretHash(id, secret));
        devices.delete(id);
    }

    @Scheduled(initialDelayString = "${nabao.apns.poll-delay-ms:60000}",
            fixedDelayString = "${nabao.apns.poll-delay-ms:60000}")
    public void scheduledPoll() { poll(Instant.now()); }

    // Package visibility permits deterministic clock control in tests, not an HTTP trigger.
    synchronized void poll(Instant now) {
        if (!apns.status().enabled()) return;
        Feed current;
        List<Device> currentDevices;
        synchronized (feedLock) {
            current = feed();
            // A missing/partial public file is not a withdrawal. Preserve all cursors
            // and retry state until a complete table is available again.
            if (current == null) return;
            // Snapshot devices with the feed; a new registration must not receive an older revision.
            currentDevices = devices.eligible(apns.status().environment());
        }
        for (Device original : currentDevices) {
            if (Thread.currentThread().isInterrupted()) return;
            Device device = original;
            if (device.baseline() == null && device.accepted() == null && device.pending() == null) {
                if (!current.empty()) {
                    devices.establishBaseline(device, current.digest());
                }
                continue;
            }
            String acknowledged = device.accepted() == null ? device.baseline() : device.accepted();
            if (current.digest().equals(acknowledged)) {
                if (device.pending() != null) devices.clearPending(device);
                continue;
            }
            if (!current.digest().equals(device.pending())) {
                devices.pend(device, current.digest(), now);
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
            PushGateway.Result result = apns.send(device.token(), device.environment(), now);
            applyResult(device, current.digest(), result, now);
        }
    }

    private void applyResult(Device device, String digest, PushGateway.Result result, Instant now) {
        switch (result.outcome()) {
            case ACCEPTED -> devices.accept(device, digest);
            case INVALID_DEVICE -> {
                if (result.invalidatedAt() != null && result.invalidatedAt().isBefore(device.registeredAt())) {
                    applyResult(device, digest, new PushGateway.Result(PushGateway.Outcome.RETRYABLE,
                            "STALE_INVALIDATION", 0, null), now);
                } else {
                    devices.invalidate(device, digest, result.reason());
                }
            }
            case RETRYABLE, REJECTED -> {
                int count = Math.min(FAST_RETRY_ATTEMPTS + 1, device.retryCount() + 1);
                long backoff = count > FAST_RETRY_ATTEMPTS || result.outcome() == PushGateway.Outcome.REJECTED
                        ? 3600 : 60L << (count - 1);
                Instant next = now.plusSeconds(Math.max(backoff, result.retryAfterSeconds()));
                devices.retry(device, digest, count, next, result.reason());
            }
            case DISABLED -> { /* Never acknowledge a notification that was not submitted. */ }
        }
    }

    private Feed feed() {
        if (tableSource) {
            DailyTableModels.Table table;
            try { table = tables.read(); }
            catch (ApplicationFailure unavailable) { return null; }
            boolean hasCursor = devices.hasCursor();
            PushStateModels.Feed current = tablePushState.update(table, hasCursor);
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

    private Device find(String id, boolean lock) { return devices.find(id, lock); }

    private static ApplicationFailure tokenOwned() {
        return new ApplicationFailure(ApplicationFailure.Kind.CONFLICT, "Push token already belongs to another installation");
    }

    private static String canonicalId(String value) {
        if (value == null || !value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) {
            throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT, "Invalid installation ID");
        }
        return UUID.fromString(value).toString();
    }

    private static void authorize(Device device, String suppliedHash) {
        if (!MessageDigest.isEqual(HexFormat.of().parseHex(device.secretHash()), HexFormat.of().parseHex(suppliedHash))) {
            throw new ApplicationFailure(ApplicationFailure.Kind.UNAUTHORIZED, "Invalid installation key");
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
