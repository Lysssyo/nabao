package com.nabao.infrastructure.jdbc;

import com.nabao.application.port.QuotaRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Repository;
import java.time.Instant;
import java.sql.*;
import java.util.List;
import static com.nabao.domain.QuotaModels.*;
import static com.nabao.domain.QuotaModels.Currency;
import static com.nabao.domain.QuotaConsensus.normalizedGroup;

@Repository
public class JdbcQuotaRepository implements QuotaRepository {
    private final JdbcTemplate jdbc;
    public JdbcQuotaRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    public List<Source> sources() {
        return jdbc.query("SELECT * FROM quota_source ORDER BY author_id", (rs, row) -> new Source(
                rs.getString("author_id"), rs.getString("name"), rs.getString("profile_url"), rs.getBoolean("enabled")));
    }
    public boolean hasSnapshots(String author, String note) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM quota_note_snapshot WHERE author_id = ? AND note_id = ?",
                Integer.class, author, note) > 0;
    }
    public String snapshotHash(String key) {
        var rows = jdbc.queryForList("SELECT payload_hash FROM quota_note_snapshot WHERE snapshot_key = ?", String.class, key);
        return rows.isEmpty() ? null : rows.getFirst();
    }
    public List<StoredObservation> noteHistory(String author, String note) {
        return jdbc.query("SELECT * FROM quota_observation WHERE author_id = ? AND note_id = ? ORDER BY id", this::readObservation, author, note);
    }
    public SourceOrder activeOrder(String author, String note) {
        var rows = jdbc.query("""
                SELECT source_published_at, source_updated_at, captured_at FROM quota_note_snapshot
                WHERE author_id = ? AND note_id = ? AND active = TRUE
                """, (rs, row) -> {
            Timestamp updated = rs.getTimestamp("source_updated_at");
            return new SourceOrder(updated == null ? rs.getTimestamp("source_published_at").toInstant()
                    : updated.toInstant(), rs.getTimestamp("captured_at").toInstant());
        }, author, note);
        return rows.isEmpty() ? null : rows.getFirst();
    }
    public void deactivateSnapshots(String author, String note) {
        jdbc.update("UPDATE quota_note_snapshot SET active = FALSE WHERE author_id = ? AND note_id = ?", author, note);
    }
    public void insertSnapshot(String key, String payload, NoteSnapshotInput snapshot, Instant capturedAt, boolean active, Instant receivedAt) {
        jdbc.update("""
                INSERT INTO quota_note_snapshot
                (snapshot_key, payload_hash, author_id, note_id, note_revision, source_published_at,
                 source_updated_at, captured_at, evidence_ref, active, received_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, key, payload, snapshot.authorId(), snapshot.noteId(), snapshot.noteRevision(),
                Timestamp.from(snapshot.sourcePublishedAt()), timestamp(snapshot.sourceUpdatedAt()),
                Timestamp.from(capturedAt), snapshot.evidenceRef(), active, Timestamp.from(receivedAt));
    }
    public boolean lockEnabledAuthor(String author) {
        var enabled = jdbc.queryForList("SELECT enabled FROM quota_source WHERE author_id = ? FOR UPDATE", Boolean.class, author);
        return !enabled.isEmpty() && enabled.getFirst();
    }
    public String observationHash(String key) {
        var rows = jdbc.queryForList("SELECT payload_hash FROM quota_observation WHERE observation_key = ?", String.class, key);
        return rows.isEmpty() ? null : rows.getFirst();
    }
    public boolean insertObservation(String key, String payload, ObservationInput input, Instant receivedAt) {
        try {
            jdbc.update("""
                        INSERT INTO quota_observation (
                            observation_key, payload_hash, author_id, note_id, note_revision,
                            fund_code, fund_name, channel_scope, business_type, quota_period,
                            limit_kind, amount_minor, currency, observed_for_date,
                            source_published_at, source_updated_at, captured_at,
                            evidence_ref, source_group_id, received_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, key, payload, input.authorId(), input.noteId(), input.noteRevision(),
                        input.fundCode(), input.fundName(), input.channelScope().name(), input.businessType().name(),
                        input.period().name(), input.limitKind().name(), input.amountMinor(),
                        input.currency().name(), input.observedForDate(),
                        Timestamp.from(input.sourcePublishedAt()), timestamp(input.sourceUpdatedAt()),
                        Timestamp.from(input.capturedAt()), input.evidenceRef(),
                        normalizedGroup(input.sourceGroupId()), Timestamp.from(receivedAt));
            return true;
        } catch (DuplicateKeyException duplicate) { return false; }
    }
    public List<StoredObservation> activeObservations(String fundCode) {
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
        return fundCode == null
                ? jdbc.query(sql + " ORDER BY o.id", this::readObservation)
                : jdbc.query(sql + " AND o.fund_code = ? ORDER BY o.id", this::readObservation, fundCode);

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

    private static Timestamp timestamp(Instant value) { return value == null ? null : Timestamp.from(value); }
}
