package com.nabao.infrastructure.file;
import com.nabao.application.ApplicationFailure;
import com.nabao.application.port.DailyTableRepository;
import static com.nabao.domain.DailyTableModels.*;


import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Read the collector's atomic public file; no quota database or previous-file fallback. */
@Repository
public class JsonDailyTableRepository implements DailyTableRepository {
    static final int MAX_BYTES = 256 * 1024;
    private final Path file;
    private final ObjectMapper json;

    public JsonDailyTableRepository(@Value("${nabao.table-file:../.local/public/latest.json}") String file, ObjectMapper json) {
        this.file = Path.of(file).toAbsolutePath().normalize();
        this.json = json;
    }

    public Snapshot readSnapshot() {
        try (var input = Files.newInputStream(file)) {
            byte[] bytes = input.readNBytes(MAX_BYTES + 1);
            if (bytes.length == 0 || bytes.length > MAX_BYTES) throw unavailable();
            JsonNode root = json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(bytes);
            validate(root);
            return new Snapshot(json.treeToValue(root, Table.class),
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        } catch (NoSuchFileException missing) {
            throw new ApplicationFailure(ApplicationFailure.Kind.NOT_FOUND, "Daily table has not been published");
        } catch (IOException | IllegalArgumentException invalid) {
            throw unavailable();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable");
        }
    }

    private static void validate(JsonNode root) {
        fields(root, root != null && root.has("notes")
                ? Set.of("schemaVersion", "dataDate", "updatedAt", "source", "rows", "notes")
                : Set.of("schemaVersion", "dataDate", "updatedAt", "source", "rows"));
        if (root.has("notes")) {
            JsonNode notes = root.path("notes");
            if (!notes.isArray() || notes.size() > 30) throw unavailable();
            for (JsonNode note : notes) checkedText(note, 2_000);
        }
        if (!root.path("schemaVersion").isIntegralNumber() || !root.path("schemaVersion").canConvertToInt()
                || root.path("schemaVersion").intValue() != 1) throw unavailable();
        String date = text(root, "dataDate", 10);
        try {
            if (!date.matches("\\d{4}-\\d{2}-\\d{2}") || !LocalDate.parse(date).toString().equals(date)) throw unavailable();
        } catch (DateTimeParseException invalid) { throw unavailable(); }
        timestamp(root, "updatedAt");
        JsonNode source = root.path("source");
        fields(source, Set.of("name", "url", "publishedAt"));
        text(source, "name", 100);
        if (!text(source, "url", 200).matches("https://www\\.xiaohongshu\\.com/explore/[a-f0-9]{24}")) throw unavailable();
        timestamp(source, "publishedAt");
        JsonNode rows = root.path("rows");
        if (!rows.isArray() || rows.isEmpty() || rows.size() > FUND_CODES.size()) throw unavailable();
        Set<String> seen = new HashSet<>();
        for (JsonNode row : rows) {
            fields(row, Set.of("fundCode", "fundName", "feeRate", "distributorLimit", "directLimit", "trackingError", "return1y"));
            String code = text(row, "fundCode", 6);
            if (!FUND_CODES.contains(code) || !seen.add(code)) throw unavailable();
            String name = text(row, "fundName", 100);
            if (!name.contains("纳斯达克") && !name.contains("纳指")) throw unavailable();
            text(row, "distributorLimit", 140);
            text(row, "directLimit", 140);
            for (String key : List.of("feeRate", "trackingError", "return1y")) {
                if (!row.path(key).isNull() && !text(row, key, 30).matches("[+-]?\\d+(?:\\.\\d+)?\\s*[%％]\\s*[*†‡]{0,3}")) throw unavailable();
            }
        }
    }

    private static void fields(JsonNode value, Set<String> expected) {
        if (value == null || !value.isObject() || value.size() != expected.size()) throw unavailable();
        value.fieldNames().forEachRemaining(key -> { if (!expected.contains(key)) throw unavailable(); });
    }

    private static String text(JsonNode object, String field, int maxLength) {
        return checkedText(object.path(field), maxLength);
    }

    private static String checkedText(JsonNode value, int maxLength) {
        if (!value.isTextual()) throw unavailable();
        String text = value.textValue();
        if (text.isBlank() || text.length() > maxLength || text.codePoints().anyMatch(Character::isISOControl)
                || text.contains("<") || text.contains(">")) throw unavailable();
        return text;
    }

    private static void timestamp(JsonNode object, String field) {
        try { OffsetDateTime.parse(text(object, field, 50)); }
        catch (DateTimeParseException invalid) { throw unavailable(); }
    }

    private static ApplicationFailure unavailable() {
        return new ApplicationFailure(ApplicationFailure.Kind.UNAVAILABLE, "Daily table is unavailable or incomplete");
    }
}
