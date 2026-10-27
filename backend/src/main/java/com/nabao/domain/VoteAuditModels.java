package com.nabao.domain;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

public final class VoteAuditModels {
    private VoteAuditModels() {}
    public record Source(@NotNull @Pattern(regexp="[a-f0-9]{24}") String authorId,
                         @NotBlank @Size(max=80) String name,
                         @NotNull @Pattern(regexp="HAS_TABLE|NO_TODAY_TABLE") String status) {}
    public record Entry(@NotNull @Pattern(regexp="[a-f0-9]{24}") String authorId,
                        @NotBlank @Size(max=80) String authorName,
                        @NotNull @Pattern(regexp="[a-f0-9]{24}") String noteId,
                        @NotNull @Pattern(regexp="https://www\\.xiaohongshu\\.com/explore/[a-f0-9]{24}") String sourceUrl,
                        @NotNull LocalDate sourceDate, @NotNull Instant capturedAt,
                        @NotNull @Pattern(regexp="[0-9]{6}") String fundCode,
                        @NotBlank @Size(max=200) String fundName,
                        @NotNull @Pattern(regexp="feeRate|distributorLimit|directLimit|trackingError|return1y") String field,
                        @Size(max=2000) String rawValue, @Size(max=2000) String normalizedValue,
                        @Size(max=8000) String voteKey, @NotNull @Size(max=100) List<@NotNull @Size(max=2000) String> notes,
                        @NotNull @Pattern(regexp="COUNTED|SUPERSEDED|NO_VALUE|WITHDRAWN|OTHER_DATE") String ballotStatus,
                        @NotNull @Pattern(regexp="ADOPTED|TIE|INSUFFICIENT") String decisionStatus,
                        @Size(max=2000) String adoptedValue, @Min(0) @Max(50) int supportCount) {}
    public record Batch(@NotNull @Pattern(regexp="[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}") String id,
                        @NotNull LocalDate dataDate, @NotNull Instant recordedAt,
                        @NotNull @Pattern(regexp="UNIQUE_PLURALITY_(SINGLE_SOURCE_ALLOWED|MIN_TWO_AUTHORS)_PER_FIELD") String rule,
                        @NotNull @Pattern(regexp="[a-f0-9]{64}") String revision,
                        @NotNull @Pattern(regexp="PUBLISHED|UNCHANGED|OLDER_SKIPPED|NOT_PUBLISHED|PENDING_PUBLICATION") String publicationStatus,
                        @NotNull @Size(min=1,max=50) List<@NotNull @Valid Source> sources,
                        @NotNull @Size(max=70000) List<@NotNull @Valid Entry> entries) {}
    public record Summary(String id, LocalDate dataDate, Instant recordedAt, String rule,
                          String revision, String publicationStatus, List<Source> sources, long entryCount) {}
    public record Fund(String fundCode, String fundName) {}
    public record Page(Summary batch, long total, int page, int pageSize, List<Entry> entries) {}
}
