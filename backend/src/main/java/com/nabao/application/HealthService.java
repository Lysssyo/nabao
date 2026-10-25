package com.nabao.application;
import com.nabao.application.port.HealthProbe;
import com.nabao.application.port.PushGateway;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import java.util.Map;
@Service
public class HealthService {
    private final HealthProbe database;
    private final PushGateway push;
    private final boolean ingestionConfigured;
    public HealthService(HealthProbe database, PushGateway push, @Value("${nabao.internal-key:}") String internalKey) {
        this.database = database; this.push = push; this.ingestionConfigured = !internalKey.isBlank();
    }
    public Map<String, Object> health() {
        database.checkDatabase();
        return Map.of("status", "UP", "database", "UP", "model", Map.of("status", "MANAGED_BY_COLLECTOR"),
                "push", push.status(), "ingestion", Map.of("status", ingestionConfigured ? "CONFIGURED" : "NOT_CONFIGURED"));
    }
}
