package com.nabao;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

import static com.nabao.QuotaModels.*;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@ActiveProfiles("test")
@AutoConfigureMockMvc
class QuotaIntegrationTest {
    private static final String AUTHOR_A = "6168030000000000020278b5";
    private static final String AUTHOR_B = "64ea885c0000000001004087";
    private static final String AUTHOR_C = "test-third-author";
    private static final Instant PUBLISHED = Instant.parse("2026-10-20T01:00:00Z");
    private static final Instant CAPTURED = Instant.parse("2026-10-20T02:00:00Z");

    @Autowired QuotaService service;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;

    @BeforeEach
    void clearData() {
        jdbc.update("DELETE FROM quota_note_snapshot");
        jdbc.update("DELETE FROM quota_observation");
        jdbc.update("DELETE FROM quota_source WHERE author_id NOT IN (?, ?)", AUTHOR_A, AUTHOR_B);
        jdbc.update("UPDATE quota_source SET enabled = TRUE");
        jdbc.update("INSERT INTO quota_source (author_id, name, profile_url, enabled) VALUES (?, ?, ?, TRUE)",
                AUTHOR_C, "test", "https://example.test/third");
    }

    @Test
    void publicReadStartsEmptyWithoutDemoQuotas() throws Exception {
        http.perform(get("/api/v1/quotas")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items").isEmpty());
        http.perform(get("/api/v1/health")).andExpect(status().isOk())
                .andExpect(jsonPath("$.database").value("UP"))
                .andExpect(jsonPath("$.model.status").value("MANAGED_BY_COLLECTOR"))
                .andExpect(jsonPath("$.push.status").value("DISABLED"));
    }

    @Test
    void twoAuthorsAgreeAndThirdCanDisagree() {
        service.submit(List.of(observation(AUTHOR_A, 1000L), observation(AUTHOR_B, 1000L),
                observation(AUTHOR_C, 10000L)));
        Quota result = onlyQuota();
        assertThat(result.status()).isEqualTo(ConsensusStatus.AGREED);
        assertThat(result.amountMinor()).isEqualTo(1000L);
        assertThat(result.supportCount()).isEqualTo(2);
        assertThat(result.sourceCount()).isEqualTo(3);
        assertThat(result.votes()).hasSize(3);
    }

    @Test
    void twoDifferentValuesDoNotInventAConsensusValue() {
        service.submit(List.of(observation(AUTHOR_A, 1000L), observation(AUTHOR_B, 10000L)));
        Quota result = onlyQuota();
        assertThat(result.status()).isEqualTo(ConsensusStatus.CONFLICT);
        assertThat(result.limitKind()).isNull();
        assertThat(result.amountMinor()).isNull();
        assertThat(result.votes()).extracting(Vote::amountMinor).containsExactly(1000L, 10000L);
    }

    @Test
    void aTwoToTwoTieDoesNotPassMajority() {
        String fourth = "test-fourth-author";
        jdbc.update("INSERT INTO quota_source (author_id, name, profile_url, enabled) VALUES (?, ?, ?, TRUE)",
                fourth, "fourth", "https://example.test/fourth");
        service.submit(List.of(observation(AUTHOR_A, 1000L), observation(AUTHOR_B, 1000L),
                observation(AUTHOR_C, 10000L), observation(fourth, 10000L)));
        assertThat(onlyQuota().status()).isEqualTo(ConsensusStatus.CONFLICT);
        assertThat(onlyQuota().supportCount()).isEqualTo(2);
        assertThat(onlyQuota().sourceCount()).isEqualTo(4);
        assertThat(onlyQuota().amountMinor()).isNull();
    }

    @Test
    void oneAuthorCannotVoteTwiceAndAllRevisionsRemainStored() {
        ObservationInput first = observation(AUTHOR_A, 1000L);
        ObservationInput revision = change(first, "noteRevision", "revision-2");
        revision = change(revision, "amountMinor", 10000L);
        revision = change(revision, "sourceUpdatedAt", "2026-10-20T01:30:00Z");
        service.submit(List.of(first, revision));
        assertThat(onlyQuota().status()).isEqualTo(ConsensusStatus.INSUFFICIENT);
        assertThat(onlyQuota().sourceCount()).isEqualTo(1);
        assertThat(onlyQuota().limitKind()).isNull();
        assertThat(onlyQuota().votes().getFirst().amountMinor()).isEqualTo(10000L);
        assertThat(rowCount()).isEqualTo(2);
    }

    @Test
    void anOldNoteArrivingLateCannotOverrideANewerSourceRevision() {
        ObservationInput old = observation(AUTHOR_A, 1000L);
        ObservationInput latest = change(change(old, "noteId", "new-note"), "amountMinor", 2000L);
        latest = change(latest, "sourcePublishedAt", "2026-10-20T04:00:00Z");
        latest = change(latest, "capturedAt", "2026-10-20T04:30:00Z");
        service.submit(List.of(latest));
        old = change(old, "capturedAt", "2026-10-20T06:00:00Z");
        service.submit(List.of(old));
        assertThat(onlyQuota().votes().getFirst().amountMinor()).isEqualTo(2000L);
    }

    @Test
    void capturedTimeBreaksEqualSourceTimeAndReReadingOldContentDoesNotBumpIt() {
        ObservationInput old = observation(AUTHOR_A, 1000L);
        ObservationInput latest = change(change(old, "noteRevision", "revision-2"), "amountMinor", 2000L);
        latest = change(latest, "capturedAt", "2026-10-20T03:00:00Z");
        service.submit(List.of(old, latest));
        Instant updatedAt = onlyQuota().updatedAt();
        BatchResult duplicate = service.submit(List.of(change(old, "capturedAt", "2026-10-20T06:00:00Z")));
        assertThat(duplicate).isEqualTo(new BatchResult(0, 1));
        assertThat(onlyQuota().votes().getFirst().amountMinor()).isEqualTo(2000L);
        assertThat(onlyQuota().updatedAt()).isEqualTo(updatedAt);
        assertThat(rowCount()).isEqualTo(2);
    }

    @Test
    void exactRetryIsIdempotentAndDoesNotChangeUpdatedAt() {
        List<ObservationInput> batch = List.of(observation(AUTHOR_A, 1000L), observation(AUTHOR_B, 1000L));
        assertThat(service.submit(batch)).isEqualTo(new BatchResult(2, 0));
        Quota first = onlyQuota();
        assertThat(service.submit(batch)).isEqualTo(new BatchResult(0, 2));
        assertThat(onlyQuota()).isEqualTo(first);
        assertThat(rowCount()).isEqualTo(2);
    }

    @Test
    void anExistingRevisionCannotBeOverwrittenAndBatchRollsBack() {
        ObservationInput original = observation(AUTHOR_A, 1000L);
        service.submit(List.of(original));
        assertThatThrownBy(() -> service.submit(List.of(
                observation(AUTHOR_B, 1000L), change(original, "amountMinor", 2000L))))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("409");
        assertThat(rowCount()).isEqualTo(1);
        assertThat(onlyQuota().votes().getFirst().amountMinor()).isEqualTo(1000L);
    }

    @ParameterizedTest
    @CsvSource({
            "fundCode,016453",
            "channelScope,DIRECT",
            "businessType,PURCHASE",
            "period,PER_ORDER",
            "currency,USD"
    })
    void differentScopesNeverPoolVotes(String field, String value) {
        service.submit(List.of(observation(AUTHOR_A, 1000L), change(observation(AUTHOR_B, 1000L), field, value)));
        assertThat(service.quotas(null)).hasSize(2)
                .allSatisfy(quota -> assertThat(quota.status()).isEqualTo(ConsensusStatus.INSUFFICIENT));
    }

    @Test
    void newestDataDateRemainsInsufficientInsteadOfFallingBackToYesterday() {
        service.submit(List.of(observation(AUTHOR_A, 1000L), observation(AUTHOR_B, 1000L)));
        ObservationInput nextDay = change(change(observation(AUTHOR_A, 2000L), "observedForDate", "2026-10-21"),
                "noteRevision", "tomorrow");
        service.submit(List.of(nextDay));
        Quota result = onlyQuota();
        assertThat(result.observedForDate()).isEqualTo(LocalDate.parse("2026-10-21"));
        assertThat(result.status()).isEqualTo(ConsensusStatus.INSUFFICIENT);
        assertThat(result.sourceCount()).isEqualTo(1);
        assertThat(rowCount()).isEqualTo(3);
    }

    @Test
    void knownCopiesCountOnce() {
        service.submit(List.of(change(observation(AUTHOR_A, 1000L), "sourceGroupId", "original-note"),
                change(observation(AUTHOR_B, 1000L), "sourceGroupId", "original-note")));
        Quota result = onlyQuota();
        assertThat(result.status()).isEqualTo(ConsensusStatus.INSUFFICIENT);
        assertThat(result.sourceCount()).isEqualTo(1);
        assertThat(result.supportCount()).isEqualTo(1);
        assertThat(result.votes().stream().filter(Vote::counted)).hasSize(1);
    }

    @Test
    void disagreeingKnownCopiesDoNotGetAnArbitraryVote() {
        service.submit(List.of(change(observation(AUTHOR_A, 1000L), "sourceGroupId", "original-note"),
                change(observation(AUTHOR_B, 10000L), "sourceGroupId", "original-note"),
                observation(AUTHOR_C, 1000L)));
        Quota result = onlyQuota();
        assertThat(result.status()).isEqualTo(ConsensusStatus.CONFLICT);
        assertThat(result.amountMinor()).isNull();
        assertThat(result.sourceCount()).isEqualTo(2);
        assertThat(result.supportCount()).isEqualTo(1);
        assertThat(result.votes().stream().filter(v -> "SOURCE_GROUP_CONFLICT".equals(v.exclusionReason())))
                .hasSize(2).allSatisfy(vote -> assertThat(vote.counted()).isFalse());
    }

    @Test
    void unspecifiedBusinessAndPeriodStayUnspecifiedEvenWhenAuthorsAgree() {
        ObservationInput a = change(change(observation(AUTHOR_A, 1000L), "businessType", "UNSPECIFIED"),
                "period", "UNSPECIFIED");
        ObservationInput b = change(change(observation(AUTHOR_B, 1000L), "businessType", "UNSPECIFIED"),
                "period", "UNSPECIFIED");
        service.submit(List.of(a, b));
        assertThat(onlyQuota().businessType()).isEqualTo(BusinessType.UNSPECIFIED);
        assertThat(onlyQuota().period()).isEqualTo(Period.UNSPECIFIED);
        assertThat(onlyQuota().status()).isEqualTo(ConsensusStatus.AGREED);
    }

    @Test
    void pausedIsNotConvertedToZeroAndUnavailableDoesNotAgreeWithPaused() {
        ObservationInput paused = change(change(observation(AUTHOR_A, null), "limitKind", "PAUSED"),
                "noteRevision", "paused-a");
        ObservationInput unavailable = change(change(observation(AUTHOR_B, null), "limitKind", "UNAVAILABLE"),
                "noteRevision", "unavailable-b");
        service.submit(List.of(paused, unavailable));
        assertThat(onlyQuota().status()).isEqualTo(ConsensusStatus.CONFLICT);
        assertThat(onlyQuota().votes()).allSatisfy(v -> assertThat(v.amountMinor()).isNull());
    }

    @Test
    void writesRequireTheInternalKey() throws Exception {
        String payload = json.writeValueAsString(new ObservationBatch(List.of(observation(AUTHOR_A, 1000L))));
        http.perform(post("/internal/v1/observations").contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().isUnauthorized());
        http.perform(post("/internal/v1/observations").header("X-Internal-Key", "wrong")
                        .contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().isUnauthorized());
        assertThat(rowCount()).isZero();
        http.perform(post("/internal/v1/observations").header("X-Internal-Key", "test-internal-key")
                        .contentType(MediaType.APPLICATION_JSON).content(payload))
                .andExpect(status().isOk()).andExpect(jsonPath("$.accepted").value(1));
    }

    @Test
    void unconfiguredAuthorIsRejectedAndBatchIsAtomic() {
        assertThatThrownBy(() -> service.submit(List.of(observation(AUTHOR_A, 1000L),
                observation("unknown-author", 1000L))))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("422");
        assertThat(rowCount()).isZero();
    }

    @Test
    void inputValidationRejectsPausedAmountMissingDateAndMissingSourceTime() throws Exception {
        ObservationInput pausedWithZero = change(observation(AUTHOR_A, 0L), "limitKind", "PAUSED");
        assertBadInput(pausedWithZero);
        assertBadInput(change(observation(AUTHOR_A, 1000L), "observedForDate", null));
        assertBadInput(change(observation(AUTHOR_A, 1000L), "sourcePublishedAt", null));
        assertBadInput(change(observation(AUTHOR_A, 1000L), "capturedAt", null));
        assertBadInput(change(observation(AUTHOR_A, 1000L), "amountMinor", -100L));
        assertBadInput(change(observation(AUTHOR_A, 1000L), "sourceUpdatedAt", "2026-10-19T01:00:00Z"));
        assertThat(rowCount()).isZero();
    }

    @Test
    void publicFilterAndValidationWork() throws Exception {
        service.submit(List.of(observation(AUTHOR_A, 1000L), observation(AUTHOR_B, 1000L)));
        http.perform(get("/api/v1/quotas").param("fundCode", "016452"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.items[0].amountMinor").value(1000))
                .andExpect(jsonPath("$.items[0].votes[0].counted").value(true));
        http.perform(get("/api/v1/quotas").param("fundCode", "016453"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.items").isEmpty());
        http.perform(get("/api/v1/quotas").param("fundCode", "16452"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void fractionalMinorAmountsAndNumericEnumsAreRejectedRatherThanCoerced() throws Exception {
        ObjectNode input = json.valueToTree(observation(AUTHOR_A, 1000L));
        input.put("amountMinor", 1000.5);
        ObjectNode batch = json.createObjectNode();
        batch.putArray("items").add(input);
        http.perform(post("/internal/v1/observations").header("X-Internal-Key", "test-internal-key")
                        .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(batch)))
                .andExpect(status().isBadRequest());
        input.put("amountMinor", 1000);
        input.put("businessType", 1);
        http.perform(post("/internal/v1/observations").header("X-Internal-Key", "test-internal-key")
                        .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(batch)))
                .andExpect(status().isBadRequest());
        assertThat(rowCount()).isZero();
    }

    private ObservationInput observation(String author, Long amount) {
        return new ObservationInput(author, "note-" + author, "revision-1", "016452", "南方纳指100 A",
                ChannelScope.DISTRIBUTOR, BusinessType.DCA, Period.DAILY,
                LimitKind.LIMITED, amount, Currency.CNY, LocalDate.parse("2026-10-20"),
                PUBLISHED, null, CAPTURED, "https://example.test/note/" + author + "#image-1-row-2", null);
    }

    private ObservationInput change(ObservationInput input, String field, Object value) {
        ObjectNode tree = json.valueToTree(input);
        tree.set(field, json.valueToTree(value));
        return json.convertValue(tree, ObservationInput.class);
    }

    private void assertBadInput(ObservationInput input) throws Exception {
        http.perform(post("/internal/v1/observations").header("X-Internal-Key", "test-internal-key")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json.writeValueAsString(new ObservationBatch(List.of(input)))))
                .andExpect(status().isBadRequest());
    }

    private Quota onlyQuota() {
        assertThat(service.quotas(null)).hasSize(1);
        return service.quotas(null).getFirst();
    }

    private int rowCount() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM quota_observation", Integer.class);
    }
}
