package com.nabao;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {
        "nabao.internal-key=",
        "spring.datasource.url=jdbc:h2:mem:nabao-unconfigured;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
})
@ActiveProfiles("test")
@AutoConfigureMockMvc
class UnconfiguredIngestionTest {
    @Autowired MockMvc http;

    @Test
    void missingConfigurationNeverMeansAnOpenWriteEndpoint() throws Exception {
        http.perform(get("/api/v1/health"))
                .andExpect(jsonPath("$.ingestion.status").value("NOT_CONFIGURED"));
        http.perform(post("/internal/v1/observations")
                        .header("X-Internal-Key", "any-value")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"items":[{
                                  "authorId":"6168030000000000020278b5","noteId":"n","noteRevision":"r",
                                  "fundCode":"016452","fundName":"sample","channelScope":"DISTRIBUTOR",
                                  "businessType":"UNSPECIFIED","period":"UNSPECIFIED",
                                  "limitKind":"LIMITED","amountMinor":1000,"currency":"CNY",
                                  "observedForDate":"2026-10-20","sourcePublishedAt":"2026-10-20T01:00:00Z",
                                  "sourceUpdatedAt":null,"capturedAt":"2026-10-20T02:00:00Z",
                                  "evidenceRef":"https://example.test/note","sourceGroupId":null
                                }]}
                                """))
                .andExpect(status().isServiceUnavailable());
        http.perform(get("/api/v1/quotas")).andExpect(jsonPath("$.items").isEmpty());
    }
}
