package com.nabao.infrastructure.jdbc;
import com.nabao.application.port.PushDeviceRepository;
import com.nabao.domain.PushModels.Device;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import java.sql.*;
import java.time.Instant;
import java.util.List;
/** Device ownership and token-version guards remain at the atomic SQL update boundary. */
@Repository
public class JdbcPushDeviceRepository implements PushDeviceRepository {
    private final JdbcTemplate jdbc;
    private static final String GUARD = " WHERE installation_id=? AND token_version=? AND pending_digest=? AND active=TRUE AND created_at=?";
    public JdbcPushDeviceRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    public boolean insert(String id, String secretHash, String token, String environment, String baseline, Instant now) {
        try {
            jdbc.update("""
                    INSERT INTO push_device (installation_id, secret_hash, device_token, environment,
                    active, baseline_digest, retry_count, token_version, registered_at, created_at)
                    VALUES (?, ?, ?, ?, TRUE, ?, 0, 0, ?, ?)
                    """, id, secretHash, token, environment, baseline, Timestamp.from(now), Timestamp.from(now));
            return true;
        } catch (DuplicateKeyException conflict) { return false; }
    }
    public boolean refresh(String id, String token, String environment, Instant now) {
        try {
            jdbc.update("""
                    UPDATE push_device SET device_token=?, environment=?, active=TRUE, retry_count=0,
                    next_attempt_at=?, last_error=NULL, token_version=token_version+1, registered_at=?
                    WHERE installation_id=?
                    """, token, environment, Timestamp.from(now), Timestamp.from(now), id);
            return true;
        } catch (DuplicateKeyException conflict) { return false; }
    }
    public void reconfirm(String id, Instant now) {
        jdbc.update("UPDATE push_device SET registered_at=?, token_version=token_version+1 WHERE installation_id=?", Timestamp.from(now), id);
    }
    public void delete(String id) { jdbc.update("DELETE FROM push_device WHERE installation_id=?", id); }
    public List<Device> eligible(String environment) {
        return jdbc.query("SELECT * FROM push_device WHERE active=TRUE AND environment=?", this::device, environment);
    }
    public boolean hasCursor() {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
                SELECT COUNT(*) > 0 FROM push_device WHERE baseline_digest IS NOT NULL
                OR last_accepted_digest IS NOT NULL OR pending_digest IS NOT NULL
                """, Boolean.class));
    }
    public void establishBaseline(Device device, String digest) {
        jdbc.update("""
                UPDATE push_device SET baseline_digest=? WHERE installation_id=? AND token_version=?
                AND baseline_digest IS NULL AND last_accepted_digest IS NULL AND pending_digest IS NULL
                """, digest, device.id(), device.version());
    }
    public void clearPending(Device device) {
        jdbc.update("""
                UPDATE push_device SET pending_digest=NULL, retry_count=0, next_attempt_at=NULL,
                last_error=NULL WHERE installation_id=? AND token_version=?
                """, device.id(), device.version());
    }
    public void pend(Device device, String digest, Instant now) {
        jdbc.update("""
                UPDATE push_device SET pending_digest=?, retry_count=0, next_attempt_at=?, last_error=NULL
                WHERE installation_id=? AND token_version=? AND active=TRUE
                """, digest, Timestamp.from(now), device.id(), device.version());
    }
    public void accept(Device device, String digest) {
        jdbc.update("""
                UPDATE push_device SET last_accepted_digest=?, pending_digest=NULL, retry_count=0,
                next_attempt_at=NULL, last_error=NULL
                """ + GUARD, digest, device.id(), device.version(), digest, Timestamp.from(device.createdAt()));
    }
    public void invalidate(Device device, String digest, String reason) {
        jdbc.update("UPDATE push_device SET active=FALSE, last_error=?, next_attempt_at=NULL" + GUARD,
                reason, device.id(), device.version(), digest, Timestamp.from(device.createdAt()));
    }
    public void retry(Device device, String digest, int count, Instant next, String reason) {
        jdbc.update("UPDATE push_device SET retry_count=?, next_attempt_at=?, last_error=?" + GUARD,
                count, Timestamp.from(next), reason, device.id(), device.version(), digest, Timestamp.from(device.createdAt()));
    }
    public Device find(String id, boolean lock) {
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

}
