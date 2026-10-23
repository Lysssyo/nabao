package com.nabao;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.util.List;

import static com.nabao.QuotaModels.*;

@Service
public class RunService {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public RunService(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    public void put(String id, RunReport report) {
        if (!id.equals(report.runId())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Path runId must match report runId");
        }
        String encoded;
        try {
            encoded = json.writeValueAsString(report);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Could not encode run report", error);
        }
        if (encoded.getBytes(StandardCharsets.UTF_8).length > 60_000) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "Run summary must fit in 60000 bytes; raw notes and model responses belong in local evidence");
        }
        // A completed run is immutable. Retrying its upload is safe; changing it needs a new run.
        List<String> prior = jdbc.queryForList("SELECT report_json FROM collector_run WHERE run_id = ?",
                String.class, id);
        if (!prior.isEmpty()) {
            verifySame(prior.getFirst(), encoded);
            return;
        }
        try {
            jdbc.update("""
                    INSERT INTO collector_run (run_id, started_at, finished_at, status, report_json)
                    VALUES (?, ?, ?, ?, ?)
                    """, id, Timestamp.from(report.startedAt()), Timestamp.from(report.finishedAt()),
                    report.status(), encoded);
        } catch (DuplicateKeyException duplicate) {
            verifySame(jdbc.queryForObject("SELECT report_json FROM collector_run WHERE run_id = ?",
                    String.class, id), encoded);
        }
    }

    public List<RunSummary> list() {
        return jdbc.query("""
                SELECT run_id, started_at, finished_at, status FROM collector_run
                ORDER BY started_at DESC, run_id DESC LIMIT 50
                """, (rs, row) -> new RunSummary(rs.getString("run_id"),
                rs.getTimestamp("started_at").toInstant(), rs.getTimestamp("finished_at").toInstant(),
                rs.getString("status")));
    }

    public RunReport get(String id) {
        List<String> found = jdbc.queryForList("SELECT report_json FROM collector_run WHERE run_id = ?",
                String.class, id);
        if (found.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Run report was not found");
        try {
            return json.readValue(found.getFirst(), RunReport.class);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Stored run report is invalid", error);
        }
    }

    private static void verifySame(String previous, String submitted) {
        if (!previous.equals(submitted)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "A completed run report is immutable; use a new runId");
        }
    }
}
