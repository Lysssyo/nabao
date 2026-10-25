package com.nabao.infrastructure.jdbc;
import com.nabao.application.port.RunRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Repository;
import java.sql.Timestamp;
import java.util.List;
import static com.nabao.domain.QuotaModels.*;
@Repository
public class JdbcRunRepository implements RunRepository {
    private final JdbcTemplate jdbc;
    public JdbcRunRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    public String find(String id) {
        var found = jdbc.queryForList("SELECT report_json FROM collector_run WHERE run_id = ?", String.class, id);
        return found.isEmpty() ? null : found.getFirst();
    }
    public boolean insert(RunReport report, String encoded) {
        try {
            jdbc.update("""
                    INSERT INTO collector_run (run_id, started_at, finished_at, status, report_json)
                    VALUES (?, ?, ?, ?, ?)
                    """, report.runId(), Timestamp.from(report.startedAt()), Timestamp.from(report.finishedAt()), report.status(), encoded);
            return true;
        } catch (DuplicateKeyException duplicate) { return false; }
    }
    public List<RunSummary> list() {
        return jdbc.query("""
                SELECT run_id, started_at, finished_at, status FROM collector_run
                ORDER BY started_at DESC, run_id DESC LIMIT 50
                """, (rs, row) -> new RunSummary(rs.getString("run_id"),
                rs.getTimestamp("started_at").toInstant(), rs.getTimestamp("finished_at").toInstant(), rs.getString("status")));
    }
}
