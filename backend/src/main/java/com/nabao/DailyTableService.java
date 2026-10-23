package com.nabao;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Read the collector's atomic public file; no quota database or previous-file fallback. */
@Service
public class DailyTableService {
    static final int MAX_BYTES = 256 * 1024;
    static final Set<String> FUND_CODES = Set.of(
            "040046", "014978", "270042", "006479", "021778", "000834", "008971", "016452", "016453", "021000", "022525",
            "019524", "019525", "022664", "019736", "019737", "019547", "019548", "019441", "019442", "539001", "012752",
            "023422", "019172", "019173", "017091", "017093", "019118", "015299", "015300", "016055", "016057", "024237",
            "016532", "016533", "021838", "160213", "018043", "018044", "161130", "012870", "018966", "018967", "021773");

    public record Table(int schemaVersion, String dataDate, String updatedAt, Source source, List<Row> rows,
                        @JsonInclude(JsonInclude.Include.NON_NULL) List<String> notes) {}
    public record Source(String name, String url, String publishedAt) {}
    public record Row(String fundCode, String fundName, String feeRate, String distributorLimit,
                      String directLimit, String trackingError, String return1y) {}

    private final Path file;
    private final ObjectMapper json;

    public DailyTableService(@Value("${nabao.table-file:../.local/public/latest.json}") String file, ObjectMapper json) {
        this.file = Path.of(file).toAbsolutePath().normalize();
        this.json = json;
    }

    public Table read() {
        try (var input = Files.newInputStream(file)) {
            byte[] bytes = input.readNBytes(MAX_BYTES + 1);
            if (bytes.length == 0 || bytes.length > MAX_BYTES) throw unavailable();
            JsonNode root = json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(bytes);
            validate(root);
            return json.treeToValue(root, Table.class);
        } catch (NoSuchFileException missing) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Daily table has not been published");
        } catch (IOException | IllegalArgumentException invalid) {
            throw unavailable();
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

    private static ResponseStatusException unavailable() {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Daily table is unavailable or incomplete");
    }
}
