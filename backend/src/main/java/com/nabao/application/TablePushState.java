package com.nabao.application;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nabao.application.port.PushStateRepository;
import com.nabao.domain.DailyTableModels.Table;
import static com.nabao.domain.PushStateModels.*;
import static com.nabao.domain.ConfirmedLimitPolicy.semanticLimit;
import org.slf4j.*;
import org.springframework.stereotype.Service;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.DateTimeException;
import java.util.*;
/** Coordinate confirmed-limit baselines with durable state, independently of device identities. */
@Service
public class TablePushState {
    private static final Logger log = LoggerFactory.getLogger(TablePushState.class);
    private final PushStateRepository repository;
    private final ObjectMapper json;
    public TablePushState(PushStateRepository repository, ObjectMapper json) { this.repository = repository; this.json = json; }
    /** Callers serialize feed acquisition with registration and polling in this single backend instance. */
    synchronized Feed update(Table table, boolean hasExistingCursor) {
        try {
            State previous = repository.read();
            if (previous == null && hasExistingCursor) {
                // Missing state cannot be distinguished from a deleted file. Never clear pending delivery silently.
                log.warn("PUSH_STATE_MISSING");
                return null;
            }
            if (previous != null && table.dataDate().compareTo(previous.dataDate()) < 0) {
                return new Feed(previous.digest(), previous.limits().isEmpty());
            }
            Map<String, String> known = new TreeMap<>(previous == null ? Map.of() : previous.limits());
            Map<String, String> changes = new TreeMap<>();
            for (var row : table.rows()) {
                merge(known, changes, row.fundCode() + ":distributor", row.distributorLimit());
                merge(known, changes, row.fundCode() + ":direct", row.directLimit());
            }
            String digest = previous == null ? hash("nabao-table-push-v1") : previous.digest();
            if (!changes.isEmpty()) digest = hash(digest + json.writeValueAsString(changes));
            State next = new State(1, table.dataDate(), digest, known);
            if (!next.equals(previous)) repository.save(next);
            return new Feed(next.digest(), known.isEmpty());
        } catch (IOException | IllegalArgumentException | DateTimeException error) {
            // File paths and contents are deliberately omitted from logs.
            log.warn("PUSH_STATE_UNAVAILABLE");
            return null;
        }
    }

    private static void merge(Map<String, String> known, Map<String, String> changes, String key, String raw) {
        String value = semanticLimit(raw);
        if (value == null) return;
        String before = known.put(key, value);
        // Learning a first value establishes a baseline; only a changed confirmed value is an event.
        if (before != null && !before.equals(value)) changes.put(key, value);
    }

    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
