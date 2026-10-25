package com.nabao.infrastructure.file;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nabao.application.port.PushStateRepository;
import static com.nabao.domain.PushStateModels.*;
import static com.nabao.domain.DailyTableModels.FUND_CODES;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.LocalDate;
import java.util.Set;
@Repository
public class JsonPushStateRepository implements PushStateRepository {
    private static final int MAX_BYTES = 64 * 1024;
    private final Path file;
    private final ObjectMapper json;
    public JsonPushStateRepository(@Value("${nabao.push-state-file:.local/push/table-state.json}") String file, ObjectMapper json) {
        this.file = Path.of(file).toAbsolutePath().normalize(); this.json = json;
    }
    public State read() throws IOException {
        if (!Files.exists(file)) return null;
        byte[] bytes;
        try (var input = Files.newInputStream(file)) { bytes = input.readNBytes(MAX_BYTES + 1); }
        if (bytes.length == 0 || bytes.length > MAX_BYTES) throw new IOException("Invalid state size");
        State state = json.readValue(bytes, State.class);
        if (state == null || state.schemaVersion() != 1 || state.digest() == null
                || !state.digest().matches("[0-9a-f]{64}") || state.dataDate() == null
                || !LocalDate.parse(state.dataDate()).toString().equals(state.dataDate()) || state.limits() == null
                || state.limits().size() > FUND_CODES.size() * 2) throw new IOException("Invalid state");
        for (var entry : state.limits().entrySet()) {
            String[] key = entry.getKey().split(":");
            if (key.length != 2 || !FUND_CODES.contains(key[0])
                    || !Set.of("distributor", "direct").contains(key[1]) || entry.getValue() == null
                    || !entry.getValue().matches("amount:\\d+(?:\\.\\d+)?|paused|unavailable|unlimited")) {
                throw new IOException("Invalid state value");
            }
        }
        return state;
    }

    public void save(State state) throws IOException {
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

}
