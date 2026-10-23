package com.nabao;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.*;
import java.util.stream.Collectors;

import static com.nabao.QuotaModels.*;
import static com.nabao.QuotaModels.Currency;

@Service
public class QuotaService {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public QuotaService(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    public List<Source> sources() {
        return jdbc.query("SELECT * FROM quota_source ORDER BY author_id",
                (rs, row) -> new Source(rs.getString("author_id"), rs.getString("name"),
                        rs.getString("profile_url"), rs.getBoolean("enabled")));
    }

    /**
     * A batch is atomic. An existing revision cannot be silently overwritten.
     * Read-committed lets a concurrent duplicate insert read the winner after its unique-key check.
     */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public BatchResult submit(List<ObservationInput> inputs) {
        lockAuthors(inputs.stream().map(ObservationInput::authorId).toList());
        for (ObservationInput input : inputs) {
            Integer snapshots = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM quota_note_snapshot WHERE author_id = ? AND note_id = ?",
                    Integer.class, input.authorId(), input.noteId());
            if (snapshots != null && snapshots > 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "This note uses complete snapshots; publish through /internal/v1/note-snapshots");
            }
        }
        return insertObservations(inputs);
    }

    /**
     * A complete note revision replaces its previous rows, including removals. The author row
     * lock serializes snapshot activation and legacy writes without a separate lock service.
     */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public SnapshotResult submitSnapshot(NoteSnapshotInput snapshot) {
        lockAuthors(List.of(snapshot.authorId()));
        Set<String> itemKeys = new HashSet<>();
        for (ObservationInput item : snapshot.items()) {
            if (!item.authorId().equals(snapshot.authorId()) || !item.noteId().equals(snapshot.noteId())
                    || !item.noteRevision().equals(snapshot.noteRevision())
                    || !item.sourcePublishedAt().equals(snapshot.sourcePublishedAt())
                    || !Objects.equals(item.sourceUpdatedAt(), snapshot.sourceUpdatedAt())
                    || !item.capturedAt().equals(snapshot.capturedAt())) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Every snapshot item must match the note metadata");
            }
            if (!itemKeys.add(observationKey(item))) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "A snapshot must contain at most one row per fund/scope/date");
            }
        }
        String snapshotKey = hash(List.of(snapshot.authorId(), snapshot.noteId(), snapshot.noteRevision()));
        String payloadHash = hash(Arrays.asList(snapshot.authorId(), snapshot.noteId(), snapshot.noteRevision(),
                snapshot.sourcePublishedAt(), snapshot.sourceUpdatedAt(), snapshot.evidenceRef(),
                snapshot.items().stream().map(this::payloadHash).sorted().toList()));
        List<String> prior = jdbc.queryForList(
                "SELECT payload_hash FROM quota_note_snapshot WHERE snapshot_key = ?", String.class, snapshotKey);
        if (!prior.isEmpty()) {
            verifySameRevision(prior.getFirst(), payloadHash);
            return new SnapshotResult(SnapshotStatus.DUPLICATE, 0, snapshot.items().size());
        }

        List<StoredObservation> noteHistory = jdbc.query(
                "SELECT * FROM quota_observation WHERE author_id = ? AND note_id = ? ORDER BY id",
                this::readObservation, snapshot.authorId(), snapshot.noteId());
        List<StoredObservation> sameRevision = noteHistory.stream()
                .filter(row -> row.input.noteRevision().equals(snapshot.noteRevision())).toList();
        // A first complete manifest cannot silently remove rows previously published under
        // the same immutable revision through the legacy batch API.
        if (sameRevision.stream().anyMatch(row -> !itemKeys.contains(observationKey(row.input)))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This noteRevision already contains other rows; submit a new revision");
        }
        Instant capturedAt = sameRevision.stream().map(row -> row.input.capturedAt())
                .min(Instant::compareTo).filter(time -> time.isBefore(snapshot.capturedAt()))
                .orElse(snapshot.capturedAt());
        SourceOrder incoming = new SourceOrder(
                snapshot.sourceUpdatedAt() == null ? snapshot.sourcePublishedAt() : snapshot.sourceUpdatedAt(),
                capturedAt);
        List<SourceOrder> active = jdbc.query("""
                SELECT source_published_at, source_updated_at, captured_at FROM quota_note_snapshot
                WHERE author_id = ? AND note_id = ? AND active = TRUE
                """, (rs, row) -> {
            Timestamp updated = rs.getTimestamp("source_updated_at");
            return new SourceOrder(updated == null ? rs.getTimestamp("source_published_at").toInstant()
                    : updated.toInstant(), rs.getTimestamp("captured_at").toInstant());
        }, snapshot.authorId(), snapshot.noteId());
        SourceOrder current = active.isEmpty()
                ? noteHistory.stream().reduce(QuotaService::newer)
                    .map(row -> new SourceOrder(sourceTime(row.input), row.input.capturedAt())).orElse(null)
                : active.getFirst();
        boolean activate = current == null || incoming.compareTo(current) >= 0;
        BatchResult inserted = insertObservations(snapshot.items());
        if (activate) {
            jdbc.update("UPDATE quota_note_snapshot SET active = FALSE WHERE author_id = ? AND note_id = ?",
                    snapshot.authorId(), snapshot.noteId());
        }
        jdbc.update("""
                INSERT INTO quota_note_snapshot
                (snapshot_key, payload_hash, author_id, note_id, note_revision, source_published_at,
                 source_updated_at, captured_at, evidence_ref, active, received_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, snapshotKey, payloadHash, snapshot.authorId(), snapshot.noteId(), snapshot.noteRevision(),
                Timestamp.from(snapshot.sourcePublishedAt()), timestamp(snapshot.sourceUpdatedAt()),
                Timestamp.from(capturedAt), snapshot.evidenceRef(), activate, Timestamp.from(Instant.now()));
        return new SnapshotResult(activate ? SnapshotStatus.ACTIVATED : SnapshotStatus.STALE,
                inserted.accepted(), inserted.duplicates());
    }

    private void lockAuthors(List<String> authors) {
        // Stable ordering also makes a legacy multi-author batch safe alongside note updates.
        for (String author : new TreeSet<>(authors)) {
            List<Boolean> enabled = jdbc.queryForList(
                    "SELECT enabled FROM quota_source WHERE author_id = ? FOR UPDATE", Boolean.class, author);
            if (enabled.isEmpty() || !enabled.getFirst()) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "authorId is not an enabled source");
            }
        }
    }

    private BatchResult insertObservations(List<ObservationInput> inputs) {
        int accepted = 0;
        int duplicates = 0;
        for (ObservationInput input : inputs) {
            String key = observationKey(input);
            // Collection time is transport metadata. Re-reading identical content must not make an
            // old revision current or cause a new vote, even if it was fetched again at a later time.
            String payloadHash = payloadHash(input);
            List<String> prior = jdbc.queryForList(
                    "SELECT payload_hash FROM quota_observation WHERE observation_key = ?", String.class, key);
            if (!prior.isEmpty()) {
                verifySameRevision(prior.getFirst(), payloadHash);
                duplicates++;
                continue;
            }
            try {
                jdbc.update("""
                        INSERT INTO quota_observation (
                            observation_key, payload_hash, author_id, note_id, note_revision,
                            fund_code, fund_name, channel_scope, business_type, quota_period,
                            limit_kind, amount_minor, currency, observed_for_date,
                            source_published_at, source_updated_at, captured_at,
                            evidence_ref, source_group_id, received_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, key, payloadHash, input.authorId(), input.noteId(), input.noteRevision(),
                        input.fundCode(), input.fundName(), input.channelScope().name(), input.businessType().name(),
                        input.period().name(), input.limitKind().name(), input.amountMinor(),
                        input.currency().name(), input.observedForDate(),
                        Timestamp.from(input.sourcePublishedAt()), timestamp(input.sourceUpdatedAt()),
                        Timestamp.from(input.capturedAt()), input.evidenceRef(),
                        normalizedGroup(input.sourceGroupId()), Timestamp.from(Instant.now()));
                accepted++;
            } catch (DuplicateKeyException duplicate) {
                String existing = jdbc.queryForObject(
                        "SELECT payload_hash FROM quota_observation WHERE observation_key = ?", String.class, key);
                verifySameRevision(existing, payloadHash);
                duplicates++;
            }
        }
        return new BatchResult(accepted, duplicates);
    }

    public List<Quota> quotas(String fundCode) {
        String sql = """
                SELECT o.* FROM quota_observation o
                JOIN quota_source s ON s.author_id = o.author_id AND s.enabled = TRUE
                WHERE (
                    (NOT EXISTS (
                         SELECT 1 FROM quota_note_snapshot n
                         WHERE n.author_id = o.author_id AND n.note_id = o.note_id AND n.active = TRUE
                     ) AND NOT EXISTS (
                         SELECT 1 FROM quota_note_snapshot n
                         WHERE n.author_id = o.author_id AND n.note_id = o.note_id
                           AND n.note_revision = o.note_revision
                     ))
                    OR EXISTS (
                        SELECT 1 FROM quota_note_snapshot n
                        WHERE n.author_id = o.author_id AND n.note_id = o.note_id
                          AND n.note_revision = o.note_revision AND n.active = TRUE
                    )
                )
                """;
        List<StoredObservation> observations = fundCode == null
                ? jdbc.query(sql + " ORDER BY o.id", this::readObservation)
                : jdbc.query(sql + " AND o.fund_code = ? ORDER BY o.id", this::readObservation, fundCode);

        // Keep days separate. The public endpoint shows the most recent data date per scope,
        // including INSUFFICIENT/CONFLICT, rather than falling back to an older agreed value.
        Map<Scope, LocalDate> newestDates = new HashMap<>();
        for (StoredObservation row : observations) {
            newestDates.merge(scopeOf(row.input), row.input.observedForDate(),
                    (a, b) -> a.isAfter(b) ? a : b);
        }
        Map<GroupKey, Map<String, StoredObservation>> groups = new LinkedHashMap<>();
        for (StoredObservation row : observations) {
            ObservationInput input = row.input;
            if (!input.observedForDate().equals(newestDates.get(scopeOf(input)))) {
                continue;
            }
            groups.computeIfAbsent(keyOf(input), ignored -> new LinkedHashMap<>())
                    .merge(input.authorId(), row, QuotaService::newer);
        }
        return groups.values().stream().map(this::consensus)
                .sorted(Comparator.comparing(Quota::fundCode)
                        .thenComparing(q -> q.channelScope().name())
                        .thenComparing(q -> q.businessType().name())
                        .thenComparing(q -> q.period().name())
                        .thenComparing(q -> q.currency().name()))
                .toList();
    }

    private Quota consensus(Map<String, StoredObservation> authors) {
        List<StoredObservation> rows = new ArrayList<>(authors.values());
        rows.sort(Comparator.comparing(row -> row.input.authorId()));
        Map<String, List<StoredObservation>> origins = rows.stream()
                .collect(Collectors.groupingBy(row -> row.input.sourceGroupId() == null
                        || row.input.sourceGroupId().isBlank()
                        ? "author:" + row.input.authorId() : "group:" + row.input.sourceGroupId()));
        Map<Value, Integer> counts = new HashMap<>();
        Map<Long, String> exclusions = new HashMap<>();
        Set<Long> counted = new HashSet<>();
        for (List<StoredObservation> origin : origins.values()) {
            Set<Value> distinct = origin.stream().map(row -> valueOf(row.input)).collect(Collectors.toSet());
            if (distinct.size() > 1) {
                // Known copies disagree: do not invent a representative value.
                origin.forEach(row -> exclusions.put(row.id, "SOURCE_GROUP_CONFLICT"));
                continue;
            }
            StoredObservation representative = origin.stream().reduce(QuotaService::newer).orElseThrow();
            counts.merge(valueOf(representative.input), 1, Integer::sum);
            counted.add(representative.id);
            origin.stream().filter(row -> row.id != representative.id)
                    .forEach(row -> exclusions.put(row.id, "SAME_SOURCE_GROUP"));
        }
        int sourceCount = origins.size();
        int supportCount = counts.values().stream().max(Integer::compareTo).orElse(0);
        boolean agreed = supportCount >= 2 && supportCount > sourceCount / 2;
        ConsensusStatus status = agreed ? ConsensusStatus.AGREED
                : sourceCount < 2 && exclusions.values().stream().noneMatch("SOURCE_GROUP_CONFLICT"::equals)
                ? ConsensusStatus.INSUFFICIENT : ConsensusStatus.CONFLICT;
        Value winner = agreed ? counts.entrySet().stream()
                .filter(entry -> entry.getValue() == supportCount).map(Map.Entry::getKey)
                .findFirst().orElseThrow() : null;

        StoredObservation newest = rows.stream().reduce(QuotaService::newer).orElseThrow();
        ObservationInput sample = newest.input;
        List<Vote> votes = rows.stream().map(row -> new Vote(row.input.authorId(), row.input.noteId(),
                row.input.noteRevision(), row.input.evidenceRef(), normalizedGroup(row.input.sourceGroupId()),
                row.input.limitKind(), row.input.amountMinor(), counted.contains(row.id), exclusions.get(row.id),
                row.input.sourcePublishedAt(), row.input.sourceUpdatedAt(),
                row.input.capturedAt(), row.receivedAt)).toList();
        Instant updatedAt = rows.stream().map(row -> row.receivedAt).max(Instant::compareTo).orElseThrow();
        return new Quota(sample.fundCode(), sample.fundName(), sample.channelScope(), sample.businessType(),
                sample.period(), sample.currency(), sample.observedForDate(),
                winner == null ? null : winner.kind, winner == null ? null : winner.amount,
                status, supportCount, sourceCount, votes, updatedAt);
    }

    private StoredObservation readObservation(ResultSet rs, int row) throws SQLException {
        Long amount = rs.getObject("amount_minor", Long.class);
        Timestamp modified = rs.getTimestamp("source_updated_at");
        ObservationInput input = new ObservationInput(rs.getString("author_id"), rs.getString("note_id"),
                rs.getString("note_revision"), rs.getString("fund_code"), rs.getString("fund_name"),
                ChannelScope.valueOf(rs.getString("channel_scope")),
                BusinessType.valueOf(rs.getString("business_type")), Period.valueOf(rs.getString("quota_period")),
                LimitKind.valueOf(rs.getString("limit_kind")), amount, Currency.valueOf(rs.getString("currency")),
                rs.getDate("observed_for_date").toLocalDate(), rs.getTimestamp("source_published_at").toInstant(),
                modified == null ? null : modified.toInstant(), rs.getTimestamp("captured_at").toInstant(),
                rs.getString("evidence_ref"), rs.getString("source_group_id"));
        return new StoredObservation(rs.getLong("id"), input, rs.getTimestamp("received_at").toInstant());
    }

    private static StoredObservation newer(StoredObservation a, StoredObservation b) {
        int result = sourceTime(a.input).compareTo(sourceTime(b.input));
        if (result == 0) result = a.input.capturedAt().compareTo(b.input.capturedAt());
        // IDs only break a true timestamp tie; receiving an older source revision late cannot win.
        if (result == 0) result = Long.compare(a.id, b.id);
        return result >= 0 ? a : b;
    }

    private static Instant sourceTime(ObservationInput input) {
        return input.sourceUpdatedAt() == null ? input.sourcePublishedAt() : input.sourceUpdatedAt();
    }

    private static Scope scopeOf(ObservationInput input) {
        return new Scope(input.fundCode(), input.channelScope(), input.businessType(), input.period(), input.currency());
    }

    private static GroupKey keyOf(ObservationInput input) {
        return new GroupKey(scopeOf(input), input.observedForDate());
    }

    private static Value valueOf(ObservationInput input) {
        return new Value(input.limitKind(), input.amountMinor());
    }

    private String hash(Object value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(value)));
        } catch (JsonProcessingException | NoSuchAlgorithmException failure) {
            throw new IllegalStateException("Could not create observation fingerprint", failure);
        }
    }

    private String observationKey(ObservationInput input) {
        return hash(List.of(input.authorId(), input.noteId(), input.noteRevision(), keyOf(input)));
    }

    private String payloadHash(ObservationInput input) {
        return hash(Arrays.asList(input.authorId(), input.noteId(), input.noteRevision(),
                input.fundCode(), input.fundName(), input.channelScope(), input.businessType(),
                input.period(), input.limitKind(), input.amountMinor(), input.currency(),
                input.observedForDate(), input.sourcePublishedAt(), input.sourceUpdatedAt(),
                input.evidenceRef(), normalizedGroup(input.sourceGroupId())));
    }

    private static void verifySameRevision(String original, String submitted) {
        if (!MessageDigest.isEqual(original.getBytes(StandardCharsets.US_ASCII),
                submitted.getBytes(StandardCharsets.US_ASCII))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "This noteRevision already exists with different content; submit a new revision");
        }
    }

    private static String normalizedGroup(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static Timestamp timestamp(Instant value) {
        return value == null ? null : Timestamp.from(value);
    }

    private record StoredObservation(long id, ObservationInput input, Instant receivedAt) {}
    private record Scope(String fundCode, ChannelScope channelScope,
                         BusinessType businessType, Period period, Currency currency) {}
    private record GroupKey(Scope scope, LocalDate date) {}
    private record Value(LimitKind kind, Long amount) {}
    private record SourceOrder(Instant sourceTime, Instant capturedAt) implements Comparable<SourceOrder> {
        @Override
        public int compareTo(SourceOrder other) {
            int source = sourceTime.compareTo(other.sourceTime);
            return source == 0 ? capturedAt.compareTo(other.capturedAt) : source;
        }
    }
}
