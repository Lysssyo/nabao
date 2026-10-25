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
import java.time.LocalDate;
import java.util.List;

import static com.nabao.domain.QuotaModels.*;
import static com.nabao.domain.QuotaModels.Currency;
import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@ActiveProfiles("test")
@AutoConfigureMockMvc
class NoteSnapshotIntegrationTest {
    private static final String A = "6168030000000000020278b5";
    private static final String B = "64ea885c0000000001004087";
    private static final Instant PUBLISHED = Instant.parse("2026-10-20T01:00:00Z");

    @Autowired QuotaService service;
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc http;
    @Autowired ObjectMapper json;

    @BeforeEach
    void clearData() {
        jdbc.update("DELETE FROM quota_note_snapshot");
        jdbc.update("DELETE FROM quota_observation");
        jdbc.update("UPDATE quota_source SET enabled = TRUE");
    }

    @Test
    void completeRevisionWithdrawsRemovedRowsAndPreservesEvidence() {
        NoteSnapshotInput old = snapshot(A, "r1", "2026-10-20T02:00:00Z", "016452", "016453");
        service.submitSnapshot(old);
        service.submitSnapshot(snapshot(B, "r1", "2026-10-20T02:00:00Z", "016452", "016453"));
        assertThat(service.quotas(null)).allSatisfy(q -> assertThat(q.status()).isEqualTo(ConsensusStatus.AGREED));

        service.submitSnapshot(snapshot(A, "r2", "2026-10-20T03:00:00Z", "016452"));
        assertThat(service.quotas("016452").getFirst().status()).isEqualTo(ConsensusStatus.AGREED);
        Quota removed = service.quotas("016453").getFirst();
        assertThat(removed.status()).isEqualTo(ConsensusStatus.INSUFFICIENT);
        assertThat(removed.votes()).extracting(Vote::authorId).containsExactly(B);
        assertThat(count("quota_observation")).isEqualTo(5);
        assertThat(count("quota_note_snapshot")).isEqualTo(3);
    }

    @Test
    void emptySnapshotWithdrawsAllRowsAndAnOldRetryCannotReactivateThem() {
        NoteSnapshotInput old = snapshot(A, "r1", "2026-10-20T02:00:00Z", "016452");
        service.submitSnapshot(old);
        assertThat(service.submitSnapshot(snapshot(A, "r2", "2026-10-20T03:00:00Z")).status())
                .isEqualTo(SnapshotStatus.ACTIVATED);
        NoteSnapshotInput refetched = change(old, "capturedAt", "2026-10-20T08:00:00Z");
        refetched = new NoteSnapshotInput(refetched.authorId(), refetched.noteId(), refetched.noteRevision(),
                refetched.sourcePublishedAt(), refetched.sourceUpdatedAt(), refetched.capturedAt(),
                refetched.evidenceRef(), old.items().stream()
                .map(item -> change(item, "capturedAt", "2026-10-20T08:00:00Z")).toList());
        assertThat(service.submitSnapshot(refetched).status()).isEqualTo(SnapshotStatus.DUPLICATE);
        assertThat(service.quotas(null)).isEmpty();
        assertThat(count("quota_observation")).isEqualTo(1);
    }

    @Test
    void lateOldRevisionIsStoredButNeverPublished() {
        service.submitSnapshot(snapshot(A, "r2", "2026-10-20T03:00:00Z", "016452"));
        NoteSnapshotInput old = snapshot(A, "r1", "2026-10-20T02:00:00Z", "016453");
        assertThat(service.submitSnapshot(old).status()).isEqualTo(SnapshotStatus.STALE);
        assertThat(service.quotas(null)).extracting(Quota::fundCode).containsExactly("016452");
        assertThat(count("quota_observation")).isEqualTo(2);
    }

    @Test
    void sourceUpdatedTimeOutranksLaterCaptureTime() {
        NoteSnapshotInput updated = snapshot(A, "r2", "2026-10-20T03:00:00Z", "016452");
        updated = change(updated, "sourceUpdatedAt", "2026-10-20T02:30:00Z");
        updated = new NoteSnapshotInput(updated.authorId(), updated.noteId(), updated.noteRevision(),
                updated.sourcePublishedAt(), updated.sourceUpdatedAt(), updated.capturedAt(),
                updated.evidenceRef(), updated.items().stream()
                .map(item -> change(item, "sourceUpdatedAt", "2026-10-20T02:30:00Z")).toList());
        service.submitSnapshot(updated);
        assertThat(service.submitSnapshot(snapshot(A, "r1", "2026-10-20T08:00:00Z", "016453")).status())
                .isEqualTo(SnapshotStatus.STALE);
        assertThat(service.quotas(null)).extracting(Quota::fundCode).containsExactly("016452");
    }

    @Test
    void sameRevisionIsImmutableAndReorderingItemsIsAnIdempotentRetry() {
        NoteSnapshotInput original = snapshot(A, "r1", "2026-10-20T02:00:00Z", "016452", "016453");
        service.submitSnapshot(original);
        List<Quota> before = service.quotas(null);
        assertThat(service.submitSnapshot(snapshot(A, "r1", "2026-10-20T02:00:00Z", "016453", "016452")).status())
                .isEqualTo(SnapshotStatus.DUPLICATE);
        assertThat(service.quotas(null)).isEqualTo(before);
        assertThatThrownBy(() -> service.submitSnapshot(snapshot(A, "r1", "2026-10-20T02:00:00Z", "016452")))
                .isInstanceOf(ApplicationFailure.class).satisfies(error -> assertThat(((ApplicationFailure) error).kind()).isEqualTo(ApplicationFailure.Kind.CONFLICT));
        assertThat(service.quotas(null)).isEqualTo(before);
    }

    @Test
    void invalidMetadataAndDuplicateScopesDoNotWithdrawCurrentRows() {
        NoteSnapshotInput original = snapshot(A, "r1", "2026-10-20T02:00:00Z", "016452");
        service.submitSnapshot(original);
        NoteSnapshotInput mixed = new NoteSnapshotInput(A, "note-" + A, "r2", PUBLISHED, null,
                Instant.parse("2026-10-20T03:00:00Z"), original.evidenceRef(), original.items());
        assertThatThrownBy(() -> service.submitSnapshot(mixed))
                .isInstanceOf(ApplicationFailure.class).satisfies(error -> assertThat(((ApplicationFailure) error).kind()).isEqualTo(ApplicationFailure.Kind.UNPROCESSABLE));
        assertThatThrownBy(() -> service.submitSnapshot(snapshot(A, "r2", "2026-10-20T03:00:00Z",
                "016452", "016452"))).isInstanceOf(ApplicationFailure.class).satisfies(error -> assertThat(((ApplicationFailure) error).kind()).isEqualTo(ApplicationFailure.Kind.UNPROCESSABLE));
        assertThat(service.quotas(null).getFirst().votes().getFirst().noteRevision()).isEqualTo("r1");
        assertThat(count("quota_note_snapshot")).isEqualTo(1);
    }

    @Test
    void legacyRowsCanBeAdoptedAndCannotBypassTheCompleteManifest() {
        NoteSnapshotInput original = snapshot(A, "r1", "2026-10-20T02:00:00Z", "016452", "016453");
        service.submit(original.items());
        assertThatThrownBy(() -> service.submitSnapshot(snapshot(A, "r1", "2026-10-20T02:00:00Z", "016452")))
                .isInstanceOf(ApplicationFailure.class).satisfies(error -> assertThat(((ApplicationFailure) error).kind()).isEqualTo(ApplicationFailure.Kind.CONFLICT));
        assertThat(service.submitSnapshot(original)).isEqualTo(new SnapshotResult(SnapshotStatus.ACTIVATED, 0, 2));
        assertThatThrownBy(() -> service.submit(snapshot(A, "r2", "2026-10-20T03:00:00Z", "016454").items()))
                .isInstanceOf(ApplicationFailure.class).satisfies(error -> assertThat(((ApplicationFailure) error).kind()).isEqualTo(ApplicationFailure.Kind.CONFLICT));
        assertThat(service.quotas(null)).hasSize(2);
    }

    @Test
    void staleSnapshotCannotHideOrExpandNewerLegacyData() {
        service.submit(snapshot(A, "r2", "2026-10-20T03:00:00Z", "016452").items());
        assertThat(service.submitSnapshot(snapshot(A, "r1", "2026-10-20T02:00:00Z", "016453")).status())
                .isEqualTo(SnapshotStatus.STALE);
        assertThat(service.quotas(null)).extracting(Quota::fundCode).containsExactly("016452");
    }

    @Test
    void latestNoteStillWinsWithinEachAuthorAndDifferentAuthorsStillVote() {
        NoteSnapshotInput first = snapshot(A, "r1", "2026-10-20T02:00:00Z", "016452");
        service.submitSnapshot(first);
        ObservationInput newer = change(first.items().getFirst(), "noteId", "a-second-note");
        newer = change(newer, "capturedAt", "2026-10-20T04:00:00Z");
        newer = change(newer, "amountMinor", 2000L);
        service.submitSnapshot(new NoteSnapshotInput(A, newer.noteId(), newer.noteRevision(), PUBLISHED, null,
                newer.capturedAt(), newer.evidenceRef(), List.of(newer)));
        service.submitSnapshot(snapshot(B, "r1", "2026-10-20T02:00:00Z", "016452"));
        Quota quota = service.quotas(null).getFirst();
        assertThat(quota.status()).isEqualTo(ConsensusStatus.CONFLICT);
        assertThat(quota.sourceCount()).isEqualTo(2);
        assertThat(quota.votes()).filteredOn(v -> v.authorId().equals(A))
                .extracting(Vote::amountMinor).containsExactly(2000L);
    }

    @Test
    void endpointRequiresKeyAndValidatesEmptyVersusMissingItems() throws Exception {
        NoteSnapshotInput empty = snapshot(A, "r1", "2026-10-20T02:00:00Z");
        http.perform(post("/internal/v1/note-snapshots").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(empty))).andExpect(status().isUnauthorized());
        http.perform(post("/internal/v1/note-snapshots").header("X-Internal-Key", "test-internal-key")
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(empty)))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ACTIVATED"))
                .andExpect(jsonPath("$.accepted").value(0));
        ObjectNode invalid = json.valueToTree(empty);
        invalid.remove("items");
        http.perform(post("/internal/v1/note-snapshots").header("X-Internal-Key", "test-internal-key")
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(invalid)))
                .andExpect(status().isBadRequest());
    }

    private NoteSnapshotInput snapshot(String author, String revision, String captured, String... codes) {
        Instant time = Instant.parse(captured);
        String note = "note-" + author;
        String evidence = "https://example.test/" + note;
        List<ObservationInput> items = java.util.Arrays.stream(codes).map(code -> new ObservationInput(
                author, note, revision, code, "基金 " + code, ChannelScope.DISTRIBUTOR,
                BusinessType.UNSPECIFIED, Period.UNSPECIFIED, LimitKind.LIMITED, 1000L, Currency.CNY,
                LocalDate.parse("2026-10-20"), PUBLISHED, null, time, evidence + "#image-1", null)).toList();
        return new NoteSnapshotInput(author, note, revision, PUBLISHED, null, time, evidence, items);
    }

    private ObservationInput change(ObservationInput input, String field, Object value) {
        ObjectNode tree = json.valueToTree(input);
        tree.set(field, json.valueToTree(value));
        return json.convertValue(tree, ObservationInput.class);
    }

    private NoteSnapshotInput change(NoteSnapshotInput input, String field, Object value) {
        ObjectNode tree = json.valueToTree(input);
        tree.set(field, json.valueToTree(value));
        return json.convertValue(tree, NoteSnapshotInput.class);
    }

    private int count(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Integer.class);
    }
}
