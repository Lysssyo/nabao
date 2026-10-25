package com.nabao.domain;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

public final class QuotaModels {
    private QuotaModels() {}

    public enum ChannelScope { DIRECT, DISTRIBUTOR, PARTIAL, UNSPECIFIED }
    public enum BusinessType { PURCHASE, DCA, UNSPECIFIED }
    public enum Period { DAILY, PER_ORDER, UNSPECIFIED }
    public enum LimitKind { LIMITED, PAUSED, UNAVAILABLE, UNLIMITED, UNKNOWN }
    public enum Currency { CNY, USD, UNSPECIFIED }
    public enum ConsensusStatus { AGREED, CONFLICT, INSUFFICIENT }

    public record ObservationInput(
            @NotBlank @Size(max = 80) String authorId,
            @NotBlank @Size(max = 100) String noteId,
            @NotBlank @Size(max = 128) String noteRevision,
            @NotBlank @Pattern(regexp = "[0-9]{6}") String fundCode,
            @NotBlank @Size(max = 200) String fundName,
            @NotNull ChannelScope channelScope,
            @NotNull BusinessType businessType,
            @NotNull Period period,
            @NotNull LimitKind limitKind,
            @PositiveOrZero Long amountMinor,
            @NotNull Currency currency,
            @NotNull LocalDate observedForDate,
            @NotNull Instant sourcePublishedAt,
            Instant sourceUpdatedAt,
            @NotNull Instant capturedAt,
            @NotBlank @Size(max = 2000) String evidenceRef,
            @Size(max = 128) String sourceGroupId) {

        @AssertTrue(message = "LIMITED requires amountMinor; every other limitKind requires null")
        @JsonIgnore
        public boolean isAmountConsistent() {
            return limitKind == null || (limitKind == LimitKind.LIMITED
                    ? amountMinor != null : amountMinor == null);
        }

        @AssertTrue(message = "sourceUpdatedAt must not precede sourcePublishedAt")
        @JsonIgnore
        public boolean isSourceTimeConsistent() {
            return sourceUpdatedAt == null || sourcePublishedAt == null
                    || !sourceUpdatedAt.isBefore(sourcePublishedAt);
        }
    }

    public record ObservationBatch(@NotEmpty @Size(max = 500) List<@NotNull @Valid ObservationInput> items) {}
    public record BatchResult(int accepted, int duplicates) {}
    public enum SnapshotStatus { ACTIVATED, STALE, DUPLICATE }
    public record NoteSnapshotInput(
            @NotBlank @Size(max = 80) String authorId,
            @NotBlank @Size(max = 100) String noteId,
            @NotBlank @Size(max = 128) String noteRevision,
            @NotNull Instant sourcePublishedAt,
            Instant sourceUpdatedAt,
            @NotNull Instant capturedAt,
            @NotBlank @Size(max = 2000) String evidenceRef,
            @NotNull @Size(max = 500) List<@NotNull @Valid ObservationInput> items) {
        @AssertTrue(message = "sourceUpdatedAt must not precede sourcePublishedAt")
        @JsonIgnore
        public boolean isSourceTimeConsistent() {
            return sourceUpdatedAt == null || sourcePublishedAt == null
                    || !sourceUpdatedAt.isBefore(sourcePublishedAt);
        }
    }
    public record SnapshotResult(SnapshotStatus status, int accepted, int duplicates) {}
    public record RunReport(
            @NotBlank @Pattern(regexp = "[A-Za-z0-9_-]{1,120}") String runId,
            @NotNull Instant startedAt,
            @NotNull Instant finishedAt,
            @NotBlank @Pattern(regexp = "success|partial|blocked|no-change") String status,
            @NotBlank @Size(max = 40) String discoveryMode,
            @NotNull Boolean automaticDiscoveryValidated,
            @NotNull @Valid RunScope scope,
            @NotNull @Size(max = 20) List<@NotNull @Valid SourceRun> results) {
        @AssertTrue(message = "finishedAt must not precede startedAt")
        @JsonIgnore
        public boolean isTimeConsistent() {
            return startedAt == null || finishedAt == null || !finishedAt.isBefore(startedAt);
        }
    }
    public record RunScope(
            @NotNull @Min(1) @Max(100) Integer maxNotesPerAuthor,
            @NotNull @Size(max = 20) List<@NotBlank @Size(max = 80) String> sourceIds) {}
    public record SourceRun(
            @NotBlank @Size(max = 80) String authorId,
            @NotBlank @Pattern(regexp = "success|partial|blocked|no-change") String status,
            @Size(max = 40) String transport,
            @NotNull @PositiveOrZero Integer discoveredCount,
            @NotNull @Size(max = 100) List<@NotBlank @Size(max = 1000) String> issues,
            @NotNull @Size(max = 100) List<@NotNull @Valid NoteRun> notes,
            @NotNull @Size(max = 100) List<@NotNull @Valid ProcessingRun> processing) {}
    public record NoteRun(
            @NotBlank @Size(max = 100) String noteId,
            @Size(max = 128) String revision,
            @NotBlank @Pattern(regexp = "success|partial|blocked|no-change") String captureStatus,
            @NotNull @Size(max = 100) List<@NotBlank @Size(max = 1000) String> issues) {}
    public record ProcessingRun(
            @NotBlank @Size(max = 40) String status,
            @NotBlank @Size(max = 40) String stage,
            @NotNull @PositiveOrZero Integer observationCount,
            Boolean published,
            @NotNull @Size(max = 100) List<@NotBlank @Size(max = 1000) String> issues) {}
    public record RunSummary(String runId, Instant startedAt, Instant finishedAt, String status) {}
    public record Items<T>(List<T> items) {}
    public record Source(String authorId, String name, String profileUrl, boolean enabled) {}
    public record Vote(
            String authorId, String noteId, String noteRevision, String evidenceRef,
            String sourceGroupId, LimitKind limitKind, Long amountMinor,
            boolean counted, String exclusionReason,
            Instant sourcePublishedAt, Instant sourceUpdatedAt, Instant capturedAt, Instant receivedAt) {}
    public record Quota(
            String fundCode, String fundName, ChannelScope channelScope,
            BusinessType businessType, Period period, Currency currency, LocalDate observedForDate,
            LimitKind limitKind, Long amountMinor, ConsensusStatus status,
            int supportCount, int sourceCount, List<Vote> votes, Instant updatedAt) {}
    public record StoredObservation(long id, ObservationInput input, Instant receivedAt) {}
    public record Scope(String fundCode, ChannelScope channelScope,
                         BusinessType businessType, Period period, Currency currency) {}
    public record GroupKey(Scope scope, LocalDate date) {}
    public record Value(LimitKind kind, Long amount) {}
    public record SourceOrder(Instant sourceTime, Instant capturedAt) implements Comparable<SourceOrder> {
        @Override
        public int compareTo(SourceOrder other) {
            int source = sourceTime.compareTo(other.sourceTime);
            return source == 0 ? capturedAt.compareTo(other.capturedAt) : source;
        }
    }
}
