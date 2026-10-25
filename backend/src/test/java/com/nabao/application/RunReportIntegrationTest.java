package com.nabao.application;

import com.nabao.domain.*;
import com.nabao.infrastructure.file.*;
import com.nabao.infrastructure.jdbc.*;
import com.nabao.infrastructure.apns.ApnsClient;


import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;

import static com.nabao.domain.QuotaModels.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@ActiveProfiles("test")
@AutoConfigureMockMvc
class RunReportIntegrationTest {
    private static final String A = "6168030000000000020278b5";
    private static final String KEY = "test-internal-key";
    @Autowired RunService service;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;

    @BeforeEach
    void clearReports() { jdbc.update("DELETE FROM collector_run"); }

    @Test
    void uploadAndReadAreAuthenticatedAndAnExactRetryIsSafe() throws Exception {
        String body = json.writeValueAsString(report("run-1", "2026-10-20T01:00:00Z"));
        http.perform(put("/internal/v1/runs/run-1").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isUnauthorized());
        for (int retry = 0; retry < 2; retry++) {
            http.perform(put("/internal/v1/runs/run-1").header("X-Internal-Key", KEY)
                    .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isOk())
                    .andExpect(jsonPath("$.status").value("SAVED"));
        }
        http.perform(get("/internal/v1/runs")).andExpect(status().isUnauthorized());
        http.perform(get("/internal/v1/runs/run-1")).andExpect(status().isUnauthorized());
        http.perform(get("/internal/v1/runs").header("X-Internal-Key", KEY)).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1));
        http.perform(get("/internal/v1/runs/run-1").header("X-Internal-Key", KEY)).andExpect(status().isOk())
                .andExpect(jsonPath("$.results[0].issues[0]").value("ACCESS_CHALLENGE"))
                .andExpect(jsonPath("$.automaticDiscoveryValidated").value(false));
    }

    @Test
    void missingReportsAndChangedCompletedReportsAreExplicitErrors() throws Exception {
        service.put("run-1", report("run-1", "2026-10-20T01:00:00Z"));
        assertThatThrownBy(() -> service.put("run-1", report("run-1", "2026-10-20T02:00:00Z")))
                .isInstanceOf(ApplicationFailure.class).satisfies(error -> assertThat(((ApplicationFailure) error).kind()).isEqualTo(ApplicationFailure.Kind.CONFLICT));
        http.perform(get("/internal/v1/runs/missing").header("X-Internal-Key", KEY))
                .andExpect(status().isNotFound());
        http.perform(put("/internal/v1/runs/other").header("X-Internal-Key", KEY)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(report("run-1", "2026-10-20T01:00:00Z"))))
                .andExpect(status().isBadRequest());
    }

    @Test
    void onlyLatestFiftyReportsAreListedInSourceRunOrder() {
        for (int i = 0; i < 55; i++) {
            String id = "run-" + i;
            service.put(id, report(id, Instant.parse("2026-10-20T01:00:00Z").plusSeconds(i).toString()));
        }
        assertThat(service.list()).hasSize(50);
        assertThat(service.list().getFirst().runId()).isEqualTo("run-54");
        assertThat(service.list().getLast().runId()).isEqualTo("run-5");
    }

    @Test
    void rawNoteFieldsAndOversizedOrInvalidReportsAreRejected() throws Exception {
        ObjectNode report = json.valueToTree(report("run-1", "2026-10-20T01:00:00Z"));
        ((ObjectNode) report.path("results").get(0).path("notes").get(0)).put("body", "raw note");
        putInvalid(report, 400);
        report = json.valueToTree(report("run-1", "2026-10-20T01:00:00Z"));
        report.put("finishedAt", "2026-10-19T01:00:00Z");
        putInvalid(report, 400);
        report = json.valueToTree(report("run-1", "2026-10-20T01:00:00Z"));
        var issues = ((ObjectNode) report.path("results").get(0)).putArray("issues");
        for (int i = 0; i < 70; i++) issues.add("证".repeat(500));
        putInvalid(report, 413);
        assertThat(service.list()).isEmpty();
    }

    @Test
    void staticAdminServesBuiltVueAssetsWithTheExistingContentPolicy() throws Exception {
        http.perform(get("/admin/")).andExpect(status().isFound())
                .andExpect(header().string("Location", "/admin/index.html"));
        String page = http.perform(get("/admin/index.html")).andExpect(status().isOk())
                .andExpect(content().string(org.hamcrest.Matchers.containsString("Content-Security-Policy")))
                .andReturn().getResponse().getContentAsString();
        var assets = java.util.regex.Pattern.compile("(?:src|href)=\"(/admin/assets/[^\"]+\\.(?:js|css))\"").matcher(page);
        int count = 0;
        while (assets.find()) {
            String path = assets.group(1);
            var response = http.perform(get(path)).andExpect(status().isOk()).andReturn().getResponse();
            if (path.endsWith(".js")) assertThat(response.getContentType()).matches("(?:text|application)/javascript(?:;.*)?");
            else assertThat(response.getContentType()).startsWith("text/css");
            count++;
        }
        assertThat(count).isGreaterThanOrEqualTo(2);
    }

    @Test
    void managementResourcesAreNeverStoredByBrowserCaches() throws Exception {
        String page = http.perform(get("/admin/index.html")).andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store")).andReturn().getResponse().getContentAsString();
        var assets = java.util.regex.Pattern.compile("(?:src|href)=\"(/admin/assets/[^\"]+\\.(?:js|css))\"").matcher(page);
        int count = 0;
        while (assets.find()) {
            http.perform(get(assets.group(1))).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"));
            count++;
        }
        assertThat(count).isGreaterThanOrEqualTo(2);
        for (String legacy : List.of("admin.js", "admin.css", "api.mjs", "domain.mjs", "app.mjs", "view.mjs"))
            http.perform(get("/admin/" + legacy)).andExpect(status().isNotFound());
    }

    private void putInvalid(ObjectNode report, int expected) throws Exception {
        http.perform(put("/internal/v1/runs/run-1").header("X-Internal-Key", KEY)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(report)))
                .andExpect(status().is(expected));
    }

    private RunReport report(String id, String start) {
        Instant time = Instant.parse(start);
        return new RunReport(id, time, time.plusSeconds(20), "blocked", "author-profile", false,
                new RunScope(1, List.of(A)), List.of(new SourceRun(A, "blocked", "browser", 0,
                List.of("ACCESS_CHALLENGE"), List.of(new NoteRun("note-a", null, "blocked", List.of())),
                List.of())));
    }
}
