package com.nabao.application.port;
import java.time.Instant;
import java.util.List;
import static com.nabao.domain.QuotaModels.*;
public interface QuotaRepository {
    List<Source> sources();
    boolean hasSnapshots(String author, String note);
    String snapshotHash(String key);
    List<StoredObservation> noteHistory(String author, String note);
    SourceOrder activeOrder(String author, String note);
    void deactivateSnapshots(String author, String note);
    void insertSnapshot(String key, String payload, NoteSnapshotInput snapshot, Instant capturedAt, boolean active, Instant receivedAt);
    boolean lockEnabledAuthor(String author);
    String observationHash(String key);
    boolean insertObservation(String key, String payload, ObservationInput input, Instant receivedAt);
    List<StoredObservation> activeObservations(String fundCode);
}
