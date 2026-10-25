package com.nabao.domain;
import java.util.List;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Set;
public final class TableStatusModels {
    private TableStatusModels() {}
    public static final Set<String> RUN_STATUSES = Set.of("running", "stopped", "published", "unchanged", "no-change",
            "older_skipped", "no_new_post", "restricted", "session_expired", "partial", "incomplete", "failed");
    public static final Set<String> ERROR_CODES = Set.of("TABLE_NO_TODAY_POST", "TABLE_ACCESS_RESTRICTED", "TABLE_SESSION_EXPIRED",
            "TABLE_PARTIAL_FIELDS", "TABLE_EXTRACTION_FAILED", "TABLE_NO_QUORUM", "TABLE_OLDER_RUN_SKIPPED",
            "SCAN_BUSY", "TABLE_RUN_BUSY", "TABLE_RUN_DATE_INVALID", "TABLE_PUBLICATION_BUSY", "TABLE_RUN_FAILED", "STATE_WRITE_FAILED");
    public static final Set<String> SOURCE_STATUSES = Set.of("running", "unknown", "complete", "partial", "failed", "no_new_post", "restricted", "session_expired");
    public static final Set<String> SOURCE_ERRORS = Set.of("SOURCE_NOT_CAPTURED", "SOURCE_ACCESS_RESTRICTED", "SOURCE_SESSION_EXPIRED",
            "SOURCE_CAPTURE_INCOMPLETE", "SOURCE_EXTRACTION_FAILED", "SOURCE_NO_TODAY_TABLE", "SOURCE_PARTIAL_FIELDS",
            "SOURCE_NOT_CONFIGURED", "SOURCE_UNKNOWN_ERROR");
    public record Published(String dataDate, String updatedAt, String digest, int rowCount, int adoptedFields, int pendingFields) {}
    public record SourceStatus(String authorId, String status, Integer rowCount, String errorCode, @JsonInclude(JsonInclude.Include.NON_NULL) String name) {}
    public record Summary(int schemaVersion, String lastAttempt, String lastSuccess, String attemptedDate,
                          String status, String errorCode, Published published, List<SourceStatus> sources) {}
    public record Dashboard(String tableState, DailyTableModels.Table table, String summaryState,
                            boolean stale, long staleAfterSeconds, Summary summary) {}

}
