package com.nabao;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.time.LocalDate;
import java.time.DateTimeException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** Last confirmed public limits, separate from device identities and the public table. */
@Component
public class TablePushState {
    private static final Logger log = LoggerFactory.getLogger(TablePushState.class);
    private static final int MAX_BYTES = 64 * 1024;
    private final Path file;
    private final ObjectMapper json;
    public record State(int schemaVersion, String dataDate, String digest, Map<String, String> limits) {}
    public record Feed(String digest, boolean empty) {}

    public TablePushState(@Value("${nabao.push-state-file:.local/push/table-state.json}") String file, ObjectMapper json) {
        this.file = Path.of(file).toAbsolutePath().normalize();
        this.json = json;
    }

    /** Callers serialize feed acquisition with registration and polling in this single backend instance. */
    synchronized Feed update(DailyTableService.Table table, boolean hasExistingCursor) {
        try {
            State previous = read();
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
            if (!next.equals(previous)) save(next);
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

    static String semanticLimit(String value) {
        if (value == null) return null;
        String normalized = Normalizer.normalize(value, Normalizer.Form.NFKC)
                .replaceAll("\\s+", "");
        // A source qualification is part of its meaning, not a formatting marker.
        if (normalized.matches(".*[*†‡].*") || normalized.contains("部分") || normalized.contains("合并")
                || normalized.contains("未区分")) return null;
        if (normalized.matches("\\d+(?:\\.\\d+)?元?")) {
            BigDecimal amount = new BigDecimal(normalized.replace("元", "")).stripTrailingZeros();
            return "amount:" + amount.toPlainString();
        }
        if (Set.of("暂停", "暂停申购", "暂停购买", "停购", "暂停定投", "关闭").contains(normalized)) return "paused";
        if (Set.of("无", "无代销", "无直销", "无此渠道", "不支持").contains(normalized)) return "unavailable";
        if (Set.of("不限额", "无限额", "无限制").contains(normalized)) return "unlimited";
        // 待更新, uncertain scopes and missing rows never erase the last confirmed value.
        return null;
    }

    private State read() throws IOException {
        if (!Files.exists(file)) return null;
        byte[] bytes;
        try (var input = Files.newInputStream(file)) { bytes = input.readNBytes(MAX_BYTES + 1); }
        if (bytes.length == 0 || bytes.length > MAX_BYTES) throw new IOException("Invalid state size");
        State state = json.readValue(bytes, State.class);
        if (state == null || state.schemaVersion() != 1 || state.digest() == null
                || !state.digest().matches("[0-9a-f]{64}") || state.dataDate() == null
                || !LocalDate.parse(state.dataDate()).toString().equals(state.dataDate()) || state.limits() == null
                || state.limits().size() > DailyTableService.FUND_CODES.size() * 2) throw new IOException("Invalid state");
        for (var entry : state.limits().entrySet()) {
            String[] key = entry.getKey().split(":");
            if (key.length != 2 || !DailyTableService.FUND_CODES.contains(key[0])
                    || !Set.of("distributor", "direct").contains(key[1]) || entry.getValue() == null
                    || !entry.getValue().matches("amount:\\d+(?:\\.\\d+)?|paused|unavailable|unlimited")) {
                throw new IOException("Invalid state value");
            }
        }
        return state;
    }

    private void save(State state) throws IOException {
        Files.createDirectories(file.getParent());
        Path temporary = Files.createTempFile(file.getParent(), ".push-state-", ".tmp");
        try {
            if (Files.getFileStore(temporary).supportsFileAttributeView("posix")) {
                Files.setPosixFilePermissions(temporary, PosixFilePermissions.fromString("rw-------"));
            }
            json.writeValue(temporary.toFile(), state);
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temporary); }
    }

    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
