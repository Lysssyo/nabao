package com.nabao.web;
import com.nabao.application.RunService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
import static com.nabao.domain.QuotaModels.*;
@RestController
public class RunController {
    private final RunService runs;
    private final InternalKeyAuthorization authorization;
    public RunController(RunService runs, InternalKeyAuthorization authorization) {
        this.runs = runs; this.authorization = authorization;
    }
    @PutMapping("/internal/v1/runs/{runId}")
    public Map<String, String> putRun(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey,
                                     @PathVariable String runId, @Valid @RequestBody RunReport report) {
        authorization.require(suppliedKey, "Observation ingestion is not configured");
        runs.put(runId, report);
        return Map.of("status", "SAVED");
    }

    @GetMapping("/internal/v1/runs")
    public Items<RunSummary> runs(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey) {
        authorization.require(suppliedKey, "Observation ingestion is not configured");
        return new Items<>(runs.list());
    }

    @GetMapping("/internal/v1/runs/{runId}")
    public RunReport run(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey,
                         @PathVariable String runId) {
        authorization.require(suppliedKey, "Observation ingestion is not configured");
        return runs.get(runId);
    }

}
