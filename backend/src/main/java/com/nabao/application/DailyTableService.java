package com.nabao.application;

import com.nabao.application.port.DailyTableRepository;
import com.nabao.domain.DailyTableModels.*;
import org.springframework.stereotype.Service;
import java.util.Map;

/** Read current public data without falling back to legacy observations or cached files. */
@Service
public class DailyTableService {
    private final DailyTableRepository tables;
    public DailyTableService(DailyTableRepository tables) { this.tables = tables; }
    public Table read() { return readSnapshot().table(); }
    public Snapshot readSnapshot() { return tables.readSnapshot(); }
    public record Readiness(boolean ready, Map<String, Object> body) {}
    public Readiness readiness() {
        try {
            Table table = read();
            return new Readiness(true, Map.of("status", "READY", "table", Map.of(
                    "status", "AVAILABLE", "dataDate", table.dataDate(), "updatedAt", table.updatedAt())));
        } catch (ApplicationFailure error) {
            return new Readiness(false, Map.of("status", "NOT_READY", "table", Map.of(
                    "status", error.kind() == ApplicationFailure.Kind.NOT_FOUND ? "MISSING" : "INVALID")));
        }
    }
}
