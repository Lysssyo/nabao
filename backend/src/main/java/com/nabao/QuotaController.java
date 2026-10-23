package com.nabao;

import jakarta.validation.Valid;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;

import static com.nabao.QuotaModels.*;

@RestController
public class QuotaController {
    private final QuotaService quotas;
    private final RunService runs;
    private final JdbcTemplate jdbc;
    private final String internalKey;
    private final ApnsClient apns;

    public QuotaController(QuotaService quotas, RunService runs, JdbcTemplate jdbc,
                           @Value("${nabao.internal-key:}") String internalKey,
                           ApnsClient apns) {
        this.quotas = quotas;
        this.runs = runs;
        this.jdbc = jdbc;
        this.internalKey = internalKey;
        this.apns = apns;
    }

    @GetMapping("/api/v1/health")
    public Map<String, Object> health() {
        jdbc.queryForObject("SELECT 1", Integer.class);
        return Map.of("status", "UP", "database", "UP",
                "model", Map.of("status", "MANAGED_BY_COLLECTOR"),
                "push", apns.status(),
                "ingestion", Map.of("status", internalKey.isBlank() ? "NOT_CONFIGURED" : "CONFIGURED"));
    }

    @GetMapping({"/admin", "/admin/"})
    public ResponseEntity<Void> admin() {
        return ResponseEntity.status(HttpStatus.FOUND).header("Location", "/admin/index.html").build();
    }

    @GetMapping("/api/v1/sources")
    public Items<Source> sources() {
        return new Items<>(quotas.sources());
    }

    @GetMapping("/api/v1/quotas")
    public Items<Quota> quotas(@RequestParam(required = false) String fundCode) {
        if (fundCode != null && !fundCode.matches("[0-9]{6}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "fundCode must contain exactly six digits");
        }
        return new Items<>(quotas.quotas(fundCode));
    }

    @PostMapping("/internal/v1/observations")
    public BatchResult submit(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey,
                              @Valid @RequestBody ObservationBatch batch) {
        authorize(suppliedKey);
        return quotas.submit(batch.items());
    }

    @PostMapping("/internal/v1/note-snapshots")
    public SnapshotResult snapshot(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey,
                                   @Valid @RequestBody NoteSnapshotInput snapshot) {
        authorize(suppliedKey);
        return quotas.submitSnapshot(snapshot);
    }

    @PutMapping("/internal/v1/runs/{runId}")
    public Map<String, String> putRun(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey,
                                     @PathVariable String runId, @Valid @RequestBody RunReport report) {
        authorize(suppliedKey);
        runs.put(runId, report);
        return Map.of("status", "SAVED");
    }

    @GetMapping("/internal/v1/runs")
    public Items<RunSummary> runs(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey) {
        authorize(suppliedKey);
        return new Items<>(runs.list());
    }

    @GetMapping("/internal/v1/runs/{runId}")
    public RunReport run(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey,
                         @PathVariable String runId) {
        authorize(suppliedKey);
        return runs.get(runId);
    }

    private void authorize(String suppliedKey) {
        if (internalKey.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Observation ingestion is not configured");
        }
        if (suppliedKey == null || !MessageDigest.isEqual(internalKey.getBytes(StandardCharsets.UTF_8),
                suppliedKey.getBytes(StandardCharsets.UTF_8))) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid internal key");
        }
    }
}
