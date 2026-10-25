package com.nabao.application;

import com.nabao.domain.*;
import com.nabao.infrastructure.file.*;
import com.nabao.infrastructure.jdbc.*;
import com.nabao.infrastructure.apns.ApnsClient;


import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.Timestamp;
import java.time.Instant;

import static com.nabao.application.port.PushGateway.*;
import static com.nabao.domain.PushModels.Registration;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {"spring.datasource.url=jdbc:h2:mem:table-push-tests;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "nabao.apns.poll-delay-ms=3600000", "nabao.push-data-source=table"})
@ActiveProfiles("test")
@AutoConfigureMockMvc
class DailyTableIntegrationTest {
    static final Path DIRECTORY;
    static {
        try { DIRECTORY = Files.createTempDirectory("nabao-table-tests-"); }
        catch (IOException error) { throw new ExceptionInInitializerError(error); }
    }
    static final Path FILE = DIRECTORY.resolve("latest.json");
    static final Path PUSH_STATE_FILE = DIRECTORY.resolve("table-state.json");
    static final String ID = "11111111-1111-4111-8111-111111111111";
    static final String TOKEN = "ab".repeat(32);
    static final Instant NOW = Instant.parse("2026-10-21T12:00:00Z");
    @Autowired PushService push;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired DailyTableService tables;
    @Autowired MockMvc http;
    @MockitoBean ApnsClient apns;
    @MockitoBean QuotaService quotas;

    @DynamicPropertySource static void properties(DynamicPropertyRegistry registry) {
        registry.add("nabao.table-file", FILE::toString);
        registry.add("nabao.push-state-file", PUSH_STATE_FILE::toString);
    }
    @AfterAll static void cleanup() throws IOException {
        Files.deleteIfExists(FILE);
        Files.deleteIfExists(PUSH_STATE_FILE);
        Files.deleteIfExists(DIRECTORY);
    }
    @BeforeEach void setup() throws IOException {
        Files.deleteIfExists(FILE);
        Files.deleteIfExists(PUSH_STATE_FILE);
        jdbc.update("DELETE FROM push_device");
        when(apns.status()).thenReturn(new Status("READY", true, "sandbox"));
        when(apns.send(anyString(), anyString(), any())).thenReturn(new Result(Outcome.ACCEPTED, null, 0, null));
    }

    @Test void endpointReadsAtomicLatestAndDoesNotFallBackToDatabaseOrPreviousFile() throws Exception {
        http.perform(get("/api/v1/table")).andExpect(status().isNotFound())
                .andExpect(jsonPath("$.detail").value("Daily table has not been published"));
        ObjectNode table = table();
        publish(table);
        http.perform(get("/api/v1/table")).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(jsonPath("$.schemaVersion").value(1)).andExpect(jsonPath("$.dataDate").value("2026-10-21"))
                .andExpect(jsonPath("$.rows.length()").value(44)).andExpect(jsonPath("$.rows[0].fundCode").value("000834"));
        firstRow(table).put("distributorLimit", "5");
        publish(table);
        http.perform(get("/api/v1/table")).andExpect(jsonPath("$.rows[0].distributorLimit").value("5"));
        Files.writeString(FILE, "{broken");
        http.perform(get("/api/v1/table")).andExpect(status().isServiceUnavailable());
        Files.delete(FILE);
        http.perform(get("/api/v1/table")).andExpect(status().isNotFound());
        verifyNoInteractions(quotas);
    }

    @Test void missingFileAllowsRegistrationAndFirstCompleteTableEstablishesBaseline() throws Exception {
        register();
        assertThat(value("baseline_digest", String.class)).isNull();
        push.poll(NOW);
        ObjectNode table = table();
        publish(table);
        push.poll(NOW.plusSeconds(1));
        assertThat(value("baseline_digest", String.class)).hasSize(64);
        verify(apns, never()).send(anyString(), anyString(), any());
        firstRow(table).put("distributorLimit", "5");
        publish(table);
        push.poll(NOW.plusSeconds(2));
        push.poll(NOW.plusSeconds(3));
        verify(apns).send(TOKEN, "sandbox", NOW.plusSeconds(2));
        verifyNoInteractions(quotas);
    }

    @Test void metricsNamesSourceTimestampsAndRowOrderDoNotTriggerQuotaNotifications() throws Exception {
        ObjectNode table = table();
        publish(table);
        register();
        table.put("updatedAt", "2026-10-21T11:00:00Z");
        ObjectNode source = (ObjectNode) table.path("source");
        source.put("name", "另一公开作者").put("url", "https://www.xiaohongshu.com/explore/bbbbbbbbbbbbbbbbbbbbbbbb")
                .put("publishedAt", "2026-10-21T02:00:00Z");
        ObjectNode row = firstRow(table);
        row.put("fundName", "大成纳斯达克100(QDII)A").put("feeRate", "0.60%")
                .put("return1y", "16.00%").put("trackingError", "1.00%").put("distributorLimit", "10.00元");
        ArrayNode rows = (ArrayNode) table.path("rows");
        rows.add(rows.remove(0));
        publish(table);
        push.poll(NOW);
        verify(apns, never()).send(anyString(), anyString(), any());
        verifyNoInteractions(quotas);
    }

    @Test void dateRolloverIsSilentWhilePauseResumeAndDistinctChannelAvailabilityNotifyOnce() throws Exception {
        ObjectNode table = table();
        publish(table);
        register();
        table.put("dataDate", "2026-10-22");
        publish(table);
        push.poll(NOW);
        verify(apns, never()).send(anyString(), anyString(), any());
        for (String limit : new String[]{"0", "暂停", "5", "无直销", "无"}) {
            firstRow(table).put("directLimit", limit);
            publish(table);
            push.poll(NOW.plusSeconds(1));
            push.poll(NOW.plusSeconds(2));
        }
        // Explicit zero, suspension, a positive amount and channel unavailability remain distinct.
        // "无直销" and "无" share the same unavailability meaning for the direct channel.
        verify(apns, times(4)).send(anyString(), anyString(), any());
    }

    @Test void unconfirmedFieldsRetainKnownBaselineWithoutBlockingOtherConfirmedChanges() throws Exception {
        ObjectNode table = table();
        publish(table);
        register();
        String baseline = value("baseline_digest", String.class);
        firstRow(table).put("distributorLimit", "待更新");
        publish(table);
        push.poll(NOW);
        verify(apns, never()).send(anyString(), anyString(), any());
        firstRow(table).put("directLimit", "50");
        publish(table);
        push.poll(NOW.plusSeconds(1));
        verify(apns).send(anyString(), anyString(), any());
        assertThat(value("last_accepted_digest", String.class)).isNotEqualTo(baseline);
        firstRow(table).put("distributorLimit", "10");
        publish(table);
        push.poll(NOW.plusSeconds(2));
        verify(apns).send(anyString(), anyString(), any());
        firstRow(table).put("distributorLimit", "5");
        publish(table);
        push.poll(NOW.plusSeconds(3));
        verify(apns, times(2)).send(anyString(), anyString(), any());
    }

    @Test void firstConfirmedFieldAndMissingRowAreSilentAndStateSurvivesRestart() throws Exception {
        ObjectNode table = table();
        firstRow(table).put("distributorLimit", "待更新");
        publish(table);
        register();
        firstRow(table).put("distributorLimit", "10");
        publish(table);
        push.poll(NOW);
        ObjectNode removed = firstRow(table).deepCopy();
        ((ArrayNode) table.path("rows")).remove(0);
        publish(table);
        push.poll(NOW.plusSeconds(1));
        verify(apns, never()).send(anyString(), anyString(), any());
        var restarted = new PushService(new JdbcPushDeviceRepository(jdbc), quotas, apns, json, tables,
                new TablePushState(new JsonPushStateRepository(PUSH_STATE_FILE.toString(), json), json), "table");
        ((ArrayNode) table.path("rows")).add(removed.put("distributorLimit", "5"));
        publish(table);
        restarted.poll(NOW.plusSeconds(2));
        verify(apns).send(TOKEN, "sandbox", NOW.plusSeconds(2));
    }

    @Test void corruptOrDeletedStateDoesNotClearPendingRetryOrAcceptNewDigest() throws Exception {
        ObjectNode table = table();
        publish(table);
        register();
        firstRow(table).put("distributorLimit", "5");
        publish(table);
        when(apns.send(anyString(), anyString(), any())).thenReturn(new Result(Outcome.RETRYABLE, "HTTP_503", 0, null));
        push.poll(NOW);
        String pending = value("pending_digest", String.class);
        byte[] validState = Files.readAllBytes(PUSH_STATE_FILE);
        Files.writeString(PUSH_STATE_FILE, "{}");
        push.poll(NOW.plusSeconds(61));
        Files.delete(PUSH_STATE_FILE);
        push.poll(NOW.plusSeconds(62));
        verify(apns).send(anyString(), anyString(), any());
        assertThat(value("pending_digest", String.class)).isEqualTo(pending);
        Files.write(PUSH_STATE_FILE, validState);
        when(apns.send(anyString(), anyString(), any())).thenReturn(new Result(Outcome.ACCEPTED, null, 0, null));
        var restarted = new PushService(new JdbcPushDeviceRepository(jdbc), quotas, apns, json, tables,
                new TablePushState(new JsonPushStateRepository(PUSH_STATE_FILE.toString(), json), json), "table");
        restarted.poll(NOW.plusSeconds(63));
        assertThat(value("last_accepted_digest", String.class)).isEqualTo(pending);
        verify(apns, times(2)).send(anyString(), anyString(), any());
    }

    @Test void brokenOrMissingFilePreservesPendingRetryUntilValidTableReturns() throws Exception {
        ObjectNode table = table();
        publish(table);
        register();
        firstRow(table).put("distributorLimit", "5");
        publish(table);
        when(apns.send(anyString(), anyString(), any())).thenReturn(new Result(Outcome.RETRYABLE, "HTTP_503", 0, null));
        push.poll(NOW);
        String pending = value("pending_digest", String.class);
        Timestamp due = value("next_attempt_at", Timestamp.class);
        Files.writeString(FILE, "{}");
        push.poll(NOW.plusSeconds(61));
        Files.delete(FILE);
        push.poll(NOW.plusSeconds(62));
        assertThat(value("pending_digest", String.class)).isEqualTo(pending);
        assertThat(value("next_attempt_at", Timestamp.class)).isEqualTo(due);
        assertThat(value("retry_count", Integer.class)).isEqualTo(1);
        verify(apns, times(1)).send(anyString(), anyString(), any());
        publish(table);
        when(apns.send(anyString(), anyString(), any())).thenReturn(new Result(Outcome.ACCEPTED, null, 0, null));
        push.poll(NOW.plusSeconds(63));
        assertThat(value("pending_digest", String.class)).isNull();
        assertThat(value("last_accepted_digest", String.class)).isEqualTo(pending);
        verify(apns, times(2)).send(anyString(), anyString(), any());
    }

    private ObjectNode table() { return json.valueToTree(DailyTableServiceTest.table()); }
    private ObjectNode firstRow(ObjectNode table) { return (ObjectNode) table.path("rows").get(0); }
    private void register() { push.register(new Registration(ID, "test-installation-secret-123456789", TOKEN, "sandbox")); }
    private <T> T value(String column, Class<T> type) {
        return jdbc.queryForObject("SELECT " + column + " FROM push_device WHERE installation_id=?", type, ID);
    }
    private void publish(ObjectNode table) throws IOException {
        Path temporary = DIRECTORY.resolve("table.tmp");
        json.writeValue(temporary.toFile(), table);
        Files.move(temporary, FILE, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }
}
