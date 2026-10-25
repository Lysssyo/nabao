package com.nabao.application;
import com.nabao.application.port.RunRepository;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static com.nabao.domain.QuotaModels.*;

@Service
public class RunService {
    private final RunRepository repository;
    private final ObjectMapper json;

    public RunService(RunRepository repository, ObjectMapper json) {
        this.repository = repository;
        this.json = json;
    }

    public void put(String id, RunReport report) {
        if (!id.equals(report.runId())) {
            throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT, "Path runId must match report runId");
        }
        String encoded;
        try {
            encoded = json.writeValueAsString(report);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("Could not encode run report", error);
        }
        if (encoded.getBytes(StandardCharsets.UTF_8).length > 60_000) {
            throw new ApplicationFailure(ApplicationFailure.Kind.TOO_LARGE,
                    "Run summary must fit in 60000 bytes; raw notes and model responses belong in local evidence");
        }
        // A completed run is immutable. Retrying its upload is safe; changing it needs a new run.
        String prior = repository.find(id);
        if (prior != null) { verifySame(prior, encoded); return; }
        if (!repository.insert(report, encoded)) verifySame(repository.find(id), encoded);
    }
    public List<RunSummary> list() { return repository.list(); }
    public RunReport get(String id) {
        String found = repository.find(id);
        if (found == null) throw new ApplicationFailure(ApplicationFailure.Kind.NOT_FOUND, "Run report was not found");
        try { return json.readValue(found, RunReport.class); }
        catch (JsonProcessingException error) { throw new IllegalStateException("Stored run report is invalid", error); }
    }

    private static void verifySame(String previous, String submitted) {
        if (!previous.equals(submitted)) {
            throw new ApplicationFailure(ApplicationFailure.Kind.CONFLICT,
                    "A completed run report is immutable; use a new runId");
        }
    }
}
