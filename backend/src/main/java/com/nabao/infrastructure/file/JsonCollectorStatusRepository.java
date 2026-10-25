package com.nabao.infrastructure.file;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.*;
import com.nabao.application.ApplicationFailure;
import com.nabao.application.port.CollectorStatusRepository;
import static com.nabao.domain.TableStatusModels.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.*;
import java.util.*;

/** Only the configured regular file is trusted as an input; private run paths are never followed. */
@Repository
public class JsonCollectorStatusRepository implements CollectorStatusRepository {
    private static final int MAX_BYTES = 64 * 1024;
    private final Path file;
    private final ObjectMapper json;
    public JsonCollectorStatusRepository(@Value("${nabao.status-file:../.local/status/daily-table.json}") String file, ObjectMapper json) {
        this.file = Path.of(file).toAbsolutePath().normalize(); this.json = json;
    }
    public Summary read(Instant now) {
        try {
            if (!Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS).isRegularFile()) throw new IllegalArgumentException();
            try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
                byte[] bytes = input.readNBytes(MAX_BYTES + 1);
                if (bytes.length == 0 || bytes.length > MAX_BYTES) throw new IllegalArgumentException();
                JsonNode root = json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                        .with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(bytes);
                validate(root, now);
                return json.treeToValue(root, Summary.class);
            }
        } catch (NoSuchFileException missing) {
            throw new ApplicationFailure(ApplicationFailure.Kind.NOT_FOUND, "Management status has not been published");
        } catch (IOException | IllegalArgumentException | DateTimeException invalid) {
            throw new ApplicationFailure(ApplicationFailure.Kind.UNAVAILABLE, "Management status is invalid");
        }
    }
    private static void validate(JsonNode root, Instant now) {
        fields(root, Set.of("schemaVersion", "lastAttempt", "lastSuccess", "attemptedDate", "status", "errorCode", "published", "sources"));
        integer(root.path("schemaVersion"), 1, 1);
        time(root.path("lastAttempt"), now);
        if (!root.path("lastSuccess").isNull()) time(root.path("lastSuccess"), now);
        date(root.path("attemptedDate"));
        member(root.path("status"), RUN_STATUSES);
        nullableMember(root.path("errorCode"), ERROR_CODES);
        JsonNode published = root.path("published");
        if (!published.isNull()) {
            fields(published, Set.of("dataDate", "updatedAt", "digest", "rowCount", "adoptedFields", "pendingFields"));
            date(published.path("dataDate"));
            time(published.path("updatedAt"), now);
            if (!published.path("digest").isTextual() || !published.path("digest").textValue().matches("[a-f0-9]{64}")) invalid();
            int rows = integer(published.path("rowCount"), 1, 44);
            int adopted = integer(published.path("adoptedFields"), 0, rows * 5);
            int pending = integer(published.path("pendingFields"), 0, rows * 5);
            if (adopted + pending != rows * 5) invalid();
        }
        JsonNode sources = root.path("sources");
        if (!sources.isArray() || sources.size() > 50) invalid();
        Set<String> seen = new HashSet<>();
        for (JsonNode source : sources) {
            fields(source, source.has("name") ? Set.of("authorId", "status", "rowCount", "errorCode", "name")
                    : Set.of("authorId", "status", "rowCount", "errorCode"));
            if (!source.path("authorId").isTextual() || !source.path("authorId").textValue().matches("[a-f0-9]{24}")) invalid();
            if (source.has("name")) {
                JsonNode name = source.path("name");
                if (!name.isTextual() || name.textValue().isBlank() || name.textValue().length() > 80
                        || name.textValue().codePoints().anyMatch(Character::isISOControl)) invalid();
            }
            if (!seen.add(source.path("authorId").textValue())) invalid();
            member(source.path("status"), SOURCE_STATUSES);
            nullableMember(source.path("errorCode"), SOURCE_ERRORS);
            if (!source.path("rowCount").isNull()) integer(source.path("rowCount"), 0, 44);
        }
    }

    private static void fields(JsonNode value, Set<String> expected) {
        if (value == null || !value.isObject() || value.size() != expected.size()) invalid();
        value.fieldNames().forEachRemaining(key -> { if (!expected.contains(key)) invalid(); });
    }
    private static void member(JsonNode value, Set<String> allowed) {
        if (!value.isTextual() || !allowed.contains(value.textValue())) invalid();
    }
    private static void nullableMember(JsonNode value, Set<String> allowed) { if (!value.isNull()) member(value, allowed); }
    private static int integer(JsonNode value, int min, int max) {
        if (!value.isIntegralNumber() || !value.canConvertToInt() || value.intValue() < min || value.intValue() > max) invalid();
        return value.intValue();
    }
    private static void date(JsonNode value) {
        if (!value.isTextual() || !value.textValue().matches("\\d{4}-\\d{2}-\\d{2}")
                || !LocalDate.parse(value.textValue()).toString().equals(value.textValue())) invalid();
    }
    private static void time(JsonNode value, Instant now) {
        if (!value.isTextual() || value.textValue().length() > 40) invalid();
        Instant time = OffsetDateTime.parse(value.textValue()).toInstant();
        if (time.isAfter(now.plusSeconds(300))) invalid();
    }
    private static void invalid() { throw new IllegalArgumentException("Invalid management status"); }
}
