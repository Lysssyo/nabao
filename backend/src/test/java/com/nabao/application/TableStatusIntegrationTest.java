package com.nabao.application;

import com.nabao.domain.*;
import com.nabao.infrastructure.file.*;
import com.nabao.infrastructure.jdbc.*;
import com.nabao.infrastructure.apns.ApnsClient;


import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {"spring.datasource.url=jdbc:h2:mem:status-tests;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "nabao.apns.poll-delay-ms=3600000", "nabao.status-stale-seconds=43200"})
@ActiveProfiles("test")
@AutoConfigureMockMvc
class TableStatusIntegrationTest {
    static final Path DIRECTORY;
    static {
        try { DIRECTORY = Files.createTempDirectory("nabao-admin-status-"); }
        catch (IOException error) { throw new ExceptionInInitializerError(error); }
    }
    static final Path TABLE = DIRECTORY.resolve("latest.json");
    static final Path STATUS = DIRECTORY.resolve("status.json");
    static final String KEY = "test-internal-key";
    static final List<String> FIXTURE_AUTHORS = List.of("633116cc000000002303dcaa", "6715dd2d000000001d02255b",
            "5ddec93c0000000001009aa1", "6168030000000000020278b5", "64ea885c0000000001004087");
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired DailyTableService tables;

    @DynamicPropertySource static void properties(DynamicPropertyRegistry registry) {
        registry.add("nabao.table-file", TABLE::toString);
        registry.add("nabao.status-file", STATUS::toString);
        registry.add("nabao.push-state-file", () -> DIRECTORY.resolve("push-state.json").toString());
    }
    @AfterAll static void cleanup() throws IOException {
        try (var files = Files.walk(DIRECTORY)) {
            for (Path path : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        }
    }
    @BeforeEach void setup() throws IOException {
        Files.deleteIfExists(STATUS);
        ObjectNode table = json.valueToTree(DailyTableServiceTest.table());
        table.put("updatedAt", Instant.now().minusSeconds(30).toString());
        json.writeValue(TABLE.toFile(), table);
    }

    @Test void protectedDashboardUsesActualTableAndKeepsAttemptDateSeparateFromPublishedDate() throws Exception {
        ObjectNode summary = summary();
        summary.put("attemptedDate", "2026-10-24").put("status", "no_new_post").put("errorCode", "TABLE_NO_TODAY_POST");
        save(summary);
        http.perform(get("/internal/v1/table-status")).andExpect(status().isUnauthorized());
        http.perform(get("/internal/v1/table-status").header("X-Internal-Key", "wrong")).andExpect(status().isUnauthorized());
        http.perform(get("/internal/v1/table-status").header("X-Internal-Key", KEY).param("path", "/private/ignored"))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.tableState").value("AVAILABLE"))
                .andExpect(jsonPath("$.table.dataDate").value("2026-10-21"))
                .andExpect(jsonPath("$.summary.attemptedDate").value("2026-10-24"))
                .andExpect(jsonPath("$.summary.published.dataDate").value("2026-10-21"))
                .andExpect(jsonPath("$.summary.published.adoptedFields").value(TableStatusService.adopted(tables.read())))
                .andExpect(jsonPath("$.summary.sources.length()").value(5));
    }

    @Test void dynamicAuthorSnapshotsMayContainZeroOneSixOrFiftySources() throws Exception {
        for (int count : List.of(0, 1, 6, 50)) {
            ObjectNode value = summary();
            var sources = value.putArray("sources");
            for (int index = 0; index < count; index++) {
                var source = sources.addObject().put("authorId", String.format("%024x", index + 1))
                        .put("status", "complete").put("rowCount", 41).putNull("errorCode");
                if (index % 2 == 0) source.put("name", "历史采集作者" + index);
            }
            save(value);
            var result = http.perform(get("/internal/v1/table-status").header("X-Internal-Key", KEY))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.summaryState").value("AVAILABLE"))
                    .andExpect(jsonPath("$.summary.sources.length()").value(count))
                    .andExpect(jsonPath("$.tableState").value("AVAILABLE"));
            if (count > 0) result.andExpect(jsonPath("$.summary.sources[0].name").value("历史采集作者0"));
            if (count > 1) result.andExpect(jsonPath("$.summary.sources[1].name").doesNotExist());
        }
    }

    @Test void rejectsInvalidDynamicIdsNamesCountsAndPrivateSourceFields() throws Exception {
        for (String scenario : List.of("id", "name", "long-name", "private", "too-many")) {
            ObjectNode value = summary();
            ObjectNode source = (ObjectNode) value.path("sources").get(0);
            switch (scenario) {
                case "id" -> source.put("authorId", "../../private/SECRET");
                case "name" -> source.put("name", "   ");
                case "long-name" -> source.put("name", "名".repeat(81));
                case "private" -> source.put("sessionPath", "/private/SECRET");
                case "too-many" -> {
                    var sources = value.putArray("sources");
                    for (int index = 0; index < 51; index++) sources.addObject()
                            .put("authorId", String.format("%024x", index + 1)).put("status", "complete")
                            .put("rowCount", 41).putNull("errorCode");
                }
            }
            save(value); assertSummary("INVALID");
        }
    }

    @Test void missingOrUnreadableSummaryDoesNotHideAValidTableOrPretendTheCheckSucceeded() throws Exception {
        assertSummary("MISSING");
        Files.createDirectory(STATUS);
        assertSummary("INVALID");
        Files.delete(STATUS);
        http.perform(get("/api/v1/readiness")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("READY"));
    }

    @Test void invalidPrivateAndOversizedSummariesNeverLeakTheirContents() throws Exception {
        for (String scenario : List.of("date", "timestamp", "future", "future-success", "private-field", "source-code", "duplicate-author", "counts")) {
            ObjectNode value = summary();
            switch (scenario) {
                case "date" -> value.put("attemptedDate", "2026-02-30");
                case "timestamp" -> value.put("lastAttempt", "2026-10-99T25:00:00Z");
                case "future" -> value.put("lastAttempt", Instant.now().plusSeconds(3600).toString());
                case "future-success" -> value.put("lastSuccess", Instant.now().plusSeconds(3600).toString());
                case "private-field" -> value.put("raw", "cookie=SECRET /private/credentials");
                case "source-code" -> ((ObjectNode) value.path("sources").get(0)).put("errorCode", "https://signed.test/?token=SECRET");
                case "duplicate-author" -> ((ObjectNode) value.path("sources").get(1)).put("authorId", value.path("sources").get(0).path("authorId").asText());
                case "counts" -> ((ObjectNode) value.path("published")).put("pendingFields", 999);
            }
            save(value);
            assertSummary("INVALID");
        }
        for (String content : List.of("x".repeat((64 * 1024) + 1), "{} {}", "{\"schemaVersion\":1,\"schemaVersion\":1}", "{broken")) {
            Files.writeString(STATUS, content);
            assertSummary("INVALID");
        }
    }

    @Test void statusSymlinksAndDeniedFilesAreNotRead() throws Exception {
        Path privateFile = DIRECTORY.resolve("private.json");
        Files.writeString(privateFile, "cookie=SECRET");
        Files.createSymbolicLink(STATUS, privateFile);
        assertSummary("INVALID");
        Files.delete(STATUS);
        save(summary());
        if (Files.getFileStore(STATUS).supportsFileAttributeView("posix")) {
            var permissions = Files.getPosixFilePermissions(STATUS);
            try {
                Files.setPosixFilePermissions(STATUS, PosixFilePermissions.fromString("---------"));
                // Root can bypass Unix permissions; the symlink case remains exercised everywhere.
                if (!Files.isReadable(STATUS)) assertSummary("INVALID");
            } finally { Files.setPosixFilePermissions(STATUS, permissions); }
        }
    }

    @Test void staleSummaryIsExplicitAndAChangedTableNeverInheritsOldCountsOrSourceStates() throws Exception {
        ObjectNode value = summary();
        value.put("lastAttempt", Instant.now().minusSeconds(50000).toString());
        value.put("lastSuccess", Instant.now().minusSeconds(51000).toString());
        save(value);
        http.perform(get("/internal/v1/table-status").header("X-Internal-Key", KEY))
                .andExpect(jsonPath("$.summaryState").value("STALE")).andExpect(jsonPath("$.stale").value(true))
                .andExpect(jsonPath("$.summary.lastSuccess").isString());
        ObjectNode table = (ObjectNode) json.readTree(Files.readString(TABLE));
        ((ObjectNode) table.path("rows").get(0)).put("directLimit", "999");
        json.writeValue(TABLE.toFile(), table);
        http.perform(get("/internal/v1/table-status").header("X-Internal-Key", KEY))
                .andExpect(jsonPath("$.summaryState").value("INCONSISTENT"))
                .andExpect(jsonPath("$.summary").isEmpty()).andExpect(jsonPath("$.table.rows[0].directLimit").value("999"));
        value = summary();
        ((ObjectNode) value.path("published")).put("dataDate", "2026-10-20");
        save(value);
        assertSummary("INCONSISTENT");
    }

    @Test void readinessDetectsBadTablesWithoutChangingLivenessOrAnonymousUnsubscribe() throws Exception {
        Files.delete(TABLE);
        http.perform(get("/api/v1/readiness")).andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.table.status").value("MISSING"));
        http.perform(get("/api/v1/health")).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("UP"));
        String id = "99999999-9999-4999-8999-999999999999", secret = "test-installation-secret-123456789";
        http.perform(post("/api/v1/push-devices").contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(
                new PushModels.Registration(id, secret, "cd".repeat(32), "sandbox")))).andExpect(status().isOk());
        http.perform(delete("/api/v1/push-devices/" + id).header("X-Installation-Key", secret)).andExpect(status().isNoContent());
        Files.writeString(TABLE, "{broken");
        http.perform(get("/api/v1/readiness")).andExpect(status().isServiceUnavailable())
                .andExpect(header().string("Cache-Control", "no-store")).andExpect(jsonPath("$.table.status").value("INVALID"));
    }

    @Test void adminShowsCurrentTableAndCollectorThroughBuiltVueEntry() throws Exception {
        String page = http.perform(get("/admin/index.html")).andExpect(status().isOk()).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(page).contains("type=\"module\"", "/admin/assets/")
                .doesNotContain("/admin/admin.js", "历史任务", "旧额度", "旧来源");
        var assets = java.util.regex.Pattern.compile("src=\"(/admin/assets/[^\"]+\\.js)\"").matcher(page);
        StringBuilder modules = new StringBuilder();
        while (assets.find()) {
            modules.append(http.perform(get(assets.group(1))).andExpect(status().isOk())
                    .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
        }
        assertThat(modules.toString()).contains("/internal/v1/table-status", "/internal/v1/collector")
                .doesNotContain("/internal/v1/runs", "/api/v1/quotas", "/api/v1/sources");
    }

    private ObjectNode summary() {
        var snapshot = tables.readSnapshot();
        var table = snapshot.table();
        int adopted = TableStatusService.adopted(table);
        return json.valueToTree(new TableStatusModels.Summary(1, Instant.now().minusSeconds(10).toString(), Instant.now().minusSeconds(5).toString(),
                table.dataDate(), "partial", "TABLE_PARTIAL_FIELDS",
                new TableStatusModels.Published(table.dataDate(), table.updatedAt(), snapshot.digest(), table.rows().size(), adopted, table.rows().size() * 5 - adopted),
                FIXTURE_AUTHORS.stream().sorted().map(author -> new TableStatusModels.SourceStatus(author, "partial", 41, "SOURCE_PARTIAL_FIELDS", null)).toList()));
    }
    private void save(ObjectNode value) throws IOException { json.writeValue(STATUS.toFile(), value); }
    private void assertSummary(String expected) throws Exception {
        String response = http.perform(get("/internal/v1/table-status").header("X-Internal-Key", KEY))
                .andExpect(status().isOk()).andExpect(jsonPath("$.summaryState").value(expected))
                .andExpect(jsonPath("$.summary").isEmpty()).andExpect(jsonPath("$.tableState").value("AVAILABLE"))
                .andReturn().getResponse().getContentAsString();
        assertThat(response).doesNotContain("SECRET", "signed.test", "/private/", DIRECTORY.toString());
    }
}
