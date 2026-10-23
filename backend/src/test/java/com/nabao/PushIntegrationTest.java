package com.nabao;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.server.ResponseStatusException;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Executors;

import static com.nabao.ApnsClient.*;
import static com.nabao.PushController.*;
import static com.nabao.QuotaModels.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest(properties = {"spring.datasource.url=jdbc:h2:mem:push-tests;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
        "nabao.apns.poll-delay-ms=3600000", "nabao.push-data-source=legacy"})
@ActiveProfiles("test")
@AutoConfigureMockMvc
class PushIntegrationTest {
    static final String ID = "11111111-1111-4111-8111-111111111111";
    static final String SECRET = "test-installation-secret-123456789";
    static final String TOKEN = "ab".repeat(32);
    static final Instant NOW = Instant.parse("2026-10-21T01:00:00Z");
    @Autowired PushService service;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;
    @Autowired DailyTableService tables;
    @Autowired TablePushState tablePushState;
    @MockitoBean ApnsClient apns;
    @MockitoBean QuotaService quotas;

    @BeforeEach void setup() {
        jdbc.update("DELETE FROM push_device");
        when(apns.status()).thenReturn(new Status("READY", true, "sandbox"));
        when(apns.send(anyString(), anyString(), any())).thenReturn(result(Outcome.ACCEPTED));
        when(quotas.quotas(null)).thenReturn(List.of(quota(1000)));
    }

    @Test void registrationStoresOnlyHashedSecretAndNoPersonalFields() throws Exception {
        http.perform(post("/api/v1/push-devices").contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsString(registration(TOKEN))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.deliveryEnabled").value(true))
                .andExpect(jsonPath("$.providerStatus").value("READY"))
                .andExpect(jsonPath("$.token").doesNotExist()).andExpect(jsonPath("$.installationSecret").doesNotExist());
        assertThat(value("secret_hash", String.class)).hasSize(64).isNotEqualTo(SECRET);
        assertThat(value("baseline_digest", String.class)).hasSize(64);
        assertThat(value("pending_digest", String.class)).isNull();
        service.poll(NOW);
        verify(apns, never()).send(anyString(), anyString(), any());
    }

    @Test void requestValidationRejectsPersonalFieldsAndMalformedValues() throws Exception {
        var body = json.valueToTree(registration(TOKEN)).deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) body).put("amount", 100);
        http.perform(post("/api/v1/push-devices").contentType(MediaType.APPLICATION_JSON).content(body.toString()))
                .andExpect(status().isBadRequest());
        http.perform(post("/api/v1/push-devices").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(registration("INVALID")))).andExpect(status().isBadRequest());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM push_device", Integer.class)).isZero();
    }

    @Test void wrongInstallationSecretCannotChangeTokenOrDelete() throws Exception {
        service.register(registration(TOKEN));
        http.perform(post("/api/v1/push-devices").contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsString(new Registration(ID, "x".repeat(32), "cd".repeat(32), "sandbox"))))
                .andExpect(status().isUnauthorized());
        http.perform(delete("/api/v1/push-devices/" + ID)).andExpect(status().isUnauthorized());
        http.perform(delete("/api/v1/push-devices/" + ID).header("X-Installation-Key", "x".repeat(32)))
                .andExpect(status().isUnauthorized());
        assertThat(value("device_token", String.class)).isEqualTo(TOKEN);
    }

    @Test void unregisterIsAuthenticatedAndIdempotent() throws Exception {
        changedFeed();
        http.perform(delete("/api/v1/push-devices/" + ID).header("X-Installation-Key", SECRET)).andExpect(status().isNoContent());
        http.perform(delete("/api/v1/push-devices/" + ID).header("X-Installation-Key", SECRET)).andExpect(status().isNoContent());
        service.poll(NOW);
        verify(apns, never()).send(anyString(), anyString(), any());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM push_device", Integer.class)).isZero();
    }

    @Test void firstNonemptyFeedAfterEmptyRegistrationIsOnlyABaseline() {
        when(quotas.quotas(null)).thenReturn(List.of());
        service.register(registration(TOKEN));
        service.poll(NOW);
        when(quotas.quotas(null)).thenReturn(List.of(quota(1000)));
        service.poll(NOW.plusSeconds(60));
        verify(apns, never()).send(anyString(), anyString(), any());
        when(quotas.quotas(null)).thenReturn(List.of(quota(2000)));
        service.poll(NOW.plusSeconds(120));
        verify(apns).send(TOKEN, "sandbox", NOW.plusSeconds(120));
    }

    @Test void changedPublicFeedIsAcceptedOnlyOnceAndRegistrationDoesNotRepeatIt() {
        changedFeed();
        service.poll(NOW);
        service.register(registration(TOKEN));
        service.poll(NOW.plusSeconds(1));
        service.poll(NOW.plusSeconds(60));
        verify(apns, times(1)).send(anyString(), anyString(), any());
        assertThat(value("last_accepted_digest", String.class)).hasSize(64);
        assertThat(value("pending_digest", String.class)).isNull();
    }

    @Test void withdrawalToEmptyFeedNotifiesOnce() {
        service.register(registration(TOKEN));
        when(quotas.quotas(null)).thenReturn(List.of());
        service.poll(NOW);
        service.poll(NOW.plusSeconds(60));
        verify(apns).send(TOKEN, "sandbox", NOW);
    }

    @Test void evidenceAndReceiptTimeOnlyChangesDoNotNotify() {
        service.register(registration(TOKEN));
        Quota same = quota(1000);
        when(quotas.quotas(null)).thenReturn(List.of(new Quota(same.fundCode(), same.fundName(), same.channelScope(),
                same.businessType(), same.period(), same.currency(), same.observedForDate(), same.limitKind(),
                same.amountMinor(), same.status(), 3, 3, List.of(new Vote("author", "note", "revision", "https://example.test/new",
                null, LimitKind.LIMITED, 1000L, true, null, NOW, NOW, NOW, NOW)), NOW.plusSeconds(60))));
        service.poll(NOW);
        verify(apns, never()).send(anyString(), anyString(), any());
    }

    @Test void newerFeedSupersedesPendingRetryAndSendsAtMostOncePerTick() {
        changedFeed();
        when(apns.send(anyString(), anyString(), any())).thenReturn(result(Outcome.RETRYABLE));
        service.poll(NOW);
        String oldPending = value("pending_digest", String.class);
        when(quotas.quotas(null)).thenReturn(List.of(quota(3000)));
        service.poll(NOW.plusSeconds(1));
        verify(apns, times(2)).send(anyString(), anyString(), any());
        assertThat(value("pending_digest", String.class)).isNotEqualTo(oldPending);
        assertThat(value("retry_count", Integer.class)).isEqualTo(1);
        service.poll(NOW.plusSeconds(2));
        verify(apns, times(2)).send(anyString(), anyString(), any());
    }

    @Test void disabledProviderAndWrongEnvironmentNeverSend() {
        changedFeed();
        when(apns.status()).thenReturn(new Status("DISABLED", false, "sandbox"));
        service.poll(NOW);
        when(apns.status()).thenReturn(new Status("READY", true, "production"));
        assertThat(service.register(registration(TOKEN)).providerStatus()).isEqualTo("ENVIRONMENT_MISMATCH");
        service.poll(NOW);
        verify(apns, never()).send(anyString(), anyString(), any());
    }

    @Test void retryStateSurvivesServiceRecreationAndContinuesHourlyAfterFifthFailure() {
        changedFeed();
        when(apns.send(anyString(), anyString(), any())).thenReturn(result(Outcome.RETRYABLE));
        Instant next = NOW;
        for (int attempt = 1; attempt <= 7; attempt++) {
            // A new service reads existing database state, as after restart.
            PushService restarted = new PushService(jdbc, quotas, apns, json, tables, tablePushState, "legacy");
            restarted.poll(next);
            verify(apns, times(attempt)).send(anyString(), anyString(), any());
            long expectedDelay = attempt > 5 ? 3600 : 60L << (attempt - 1);
            Instant due = value("next_attempt_at", Timestamp.class).toInstant();
            assertThat(due).isEqualTo(next.plusSeconds(expectedDelay));
            assertThat(value("pending_digest", String.class)).isNotNull();
            assertThat(value("last_accepted_digest", String.class)).isNull();
            restarted.poll(due.minusSeconds(1));
            verify(apns, times(attempt)).send(anyString(), anyString(), any());
            next = due;
        }
        when(apns.send(anyString(), anyString(), any())).thenReturn(result(Outcome.ACCEPTED));
        new PushService(jdbc, quotas, apns, json, tables, tablePushState, "legacy").poll(next);
        assertThat(value("pending_digest", String.class)).isNull();
    }

    @Test void rejectedProviderCredentialsAreRetriedHourlyWithoutLosingPending() {
        changedFeed();
        when(apns.send(anyString(), anyString(), any())).thenReturn(result(Outcome.REJECTED));
        service.poll(NOW);
        assertThat(value("next_attempt_at", Timestamp.class).toInstant()).isEqualTo(NOW.plusSeconds(3600));
        assertThat(value("pending_digest", String.class)).isNotNull();
    }

    @Test void retryAfterAndRepeatedRegistrationDoNotCauseEarlyRetry() {
        changedFeed();
        when(apns.send(anyString(), anyString(), any())).thenReturn(new Result(Outcome.RETRYABLE, "TooManyRequests", 600, null));
        service.poll(NOW);
        service.register(registration(TOKEN));
        service.poll(NOW.plusSeconds(599));
        verify(apns, times(1)).send(anyString(), anyString(), any());
        service.poll(NOW.plusSeconds(600));
        verify(apns, times(2)).send(anyString(), anyString(), any());
    }

    @Test void revertedFeedCancelsAnUnsentPendingNotification() {
        changedFeed();
        when(apns.send(anyString(), anyString(), any())).thenReturn(result(Outcome.RETRYABLE));
        service.poll(NOW);
        when(quotas.quotas(null)).thenReturn(List.of(quota(1000)));
        service.poll(NOW.plusSeconds(60));
        assertThat(value("pending_digest", String.class)).isNull();
        verify(apns, times(1)).send(anyString(), anyString(), any());
    }

    @Test void invalidTokenStopsDeliveryAndAuthenticatedSameTokenRegistrationRestoresIt() {
        changedFeed();
        when(apns.send(anyString(), anyString(), any())).thenReturn(new Result(Outcome.INVALID_DEVICE, "BadDeviceToken", 0, null));
        service.poll(NOW);
        assertThat(value("active", Boolean.class)).isFalse();
        service.poll(NOW.plusSeconds(100));
        verify(apns, times(1)).send(anyString(), anyString(), any());
        assertThat(service.register(registration(TOKEN)).deliveryEnabled()).isTrue();
        when(apns.send(anyString(), anyString(), any())).thenReturn(result(Outcome.ACCEPTED));
        service.poll(Instant.now().plusSeconds(1));
        verify(apns, times(2)).send(anyString(), anyString(), any());
        assertThat(value("pending_digest", String.class)).isNull();
    }

    @Test void staleUnregisteredTimestampDoesNotInvalidateFreshRegistration() {
        changedFeed();
        when(apns.send(anyString(), anyString(), any())).thenReturn(new Result(Outcome.INVALID_DEVICE, "Unregistered", 0, Instant.EPOCH));
        service.poll(NOW);
        assertThat(value("active", Boolean.class)).isTrue();
        assertThat(value("last_error", String.class)).isEqualTo("STALE_INVALIDATION");
        assertThat(value("next_attempt_at", Timestamp.class).toInstant()).isEqualTo(NOW.plusSeconds(60));
    }

    @Test void currentUnregisteredTimestampInvalidatesToken() {
        changedFeed();
        when(apns.send(anyString(), anyString(), any())).thenReturn(new Result(Outcome.INVALID_DEVICE, "Unregistered", 0, Instant.now().plusSeconds(5)));
        service.poll(NOW);
        assertThat(value("active", Boolean.class)).isFalse();
    }

    @ParameterizedTest @EnumSource(value = Outcome.class, names = {"ACCEPTED", "INVALID_DEVICE", "RETRYABLE"})
    void oldInFlightResponseCannotOverwriteRefreshedToken(Outcome outcome) throws Exception {
        changedFeed();
        CountDownLatch sending = new CountDownLatch(1), release = new CountDownLatch(1);
        when(apns.send(anyString(), anyString(), any())).thenAnswer(call -> {
            sending.countDown();
            assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
            return result(outcome);
        });
        try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
            var future = workers.submit(() -> service.poll(NOW));
            assertThat(sending.await(5, TimeUnit.SECONDS)).isTrue();
            try { service.register(registration("cd".repeat(32))); }
            finally { release.countDown(); }
            future.get(5, TimeUnit.SECONDS);
        }
        assertThat(value("device_token", String.class)).isEqualTo("cd".repeat(32));
        assertThat(value("active", Boolean.class)).isTrue();
        assertThat(value("retry_count", Integer.class)).isZero();
        assertThat(value("last_accepted_digest", String.class)).isNull();
        assertThat(value("pending_digest", String.class)).isNotNull();
    }

    @Test void unsubscribeWhileSendingPreventsStateResurrectionOrLaterSend() throws Exception {
        changedFeed();
        CountDownLatch sending = new CountDownLatch(1), release = new CountDownLatch(1);
        when(apns.send(anyString(), anyString(), any())).thenAnswer(call -> {
            sending.countDown();
            assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
            return result(Outcome.ACCEPTED);
        });
        try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
            var future = workers.submit(() -> service.poll(NOW));
            assertThat(sending.await(5, TimeUnit.SECONDS)).isTrue();
            try { service.unregister(ID, SECRET); } finally { release.countDown(); }
            future.get(5, TimeUnit.SECONDS);
        }
        service.poll(NOW.plusSeconds(60));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM push_device", Integer.class)).isZero();
        verify(apns, times(1)).send(anyString(), anyString(), any());
    }

    @Test void freshSameTokenRegistrationAlsoRejectsOlderInvalidation() throws Exception {
        changedFeed();
        CountDownLatch sending = new CountDownLatch(1), release = new CountDownLatch(1);
        when(apns.send(anyString(), anyString(), any())).thenAnswer(call -> {
            sending.countDown();
            assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
            return result(Outcome.INVALID_DEVICE);
        });
        try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
            var future = workers.submit(() -> service.poll(NOW));
            assertThat(sending.await(5, TimeUnit.SECONDS)).isTrue();
            try { service.register(registration(TOKEN)); } finally { release.countDown(); }
            future.get(5, TimeUnit.SECONDS);
        }
        assertThat(value("active", Boolean.class)).isTrue();
        assertThat(value("last_error", String.class)).isNull();
        assertThat(value("pending_digest", String.class)).isNotNull();
    }

    @Test void duplicateTokenOwnershipReturns409AndDoesNotCreateSecondDevice() throws Exception {
        service.register(registration(TOKEN));
        var other = new Registration(UUID.randomUUID().toString(), SECRET, TOKEN, "sandbox");
        http.perform(post("/api/v1/push-devices").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(other))).andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM push_device", Integer.class)).isEqualTo(1);
        service.unregister(ID, SECRET);
        assertThat(service.register(other).deliveryEnabled()).isTrue();
    }

    @Test void concurrentRegistrationsCannotClaimTheSameTokenTwice() throws Exception {
        var start = new CountDownLatch(1);
        try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
            var futures = java.util.stream.IntStream.range(0, 2).mapToObj(index -> workers.submit(() -> {
                start.await();
                try {
                    service.register(new Registration(UUID.randomUUID().toString(), SECRET, TOKEN, "sandbox"));
                    return 200;
                } catch (ResponseStatusException error) { return error.getStatusCode().value(); }
            })).toList();
            start.countDown();
            assertThat(List.of(futures.get(0).get(5, TimeUnit.SECONDS), futures.get(1).get(5, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(200, 409);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM push_device", Integer.class)).isEqualTo(1);
    }

    @Test void tokenRotationCannotStealAnotherInstallationsToken() {
        service.register(registration(TOKEN));
        String other = UUID.randomUUID().toString();
        service.register(new Registration(other, SECRET, "cd".repeat(32), "sandbox"));
        assertThatThrownBy(() -> service.register(registration("cd".repeat(32))))
                .isInstanceOf(ResponseStatusException.class).satisfies(error ->
                        assertThat(((ResponseStatusException) error).getStatusCode().value()).isEqualTo(409));
        assertThat(value("device_token", String.class)).isEqualTo(TOKEN);
    }

    private void changedFeed() {
        service.register(registration(TOKEN));
        when(quotas.quotas(null)).thenReturn(List.of(quota(2000)));
    }
    private <T> T value(String field, Class<T> type) {
        return jdbc.queryForObject("SELECT " + field + " FROM push_device WHERE installation_id=?", type, ID);
    }
    private Registration registration(String token) { return new Registration(ID, SECRET, token, "sandbox"); }
    private static Result result(Outcome outcome) { return new Result(outcome, outcome.name(), 0, null); }
    private static Quota quota(long amount) {
        return new Quota("016452", "Southern A", ChannelScope.DIRECT, BusinessType.UNSPECIFIED, Period.DAILY,
                Currency.CNY, LocalDate.of(2026, 10, 21), LimitKind.LIMITED, amount,
                ConsensusStatus.AGREED, 2, 2, List.of(), NOW);
    }
}
