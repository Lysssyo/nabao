package com.nabao.application;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nabao.application.port.QuotaRepository;
import com.nabao.domain.QuotaConsensus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;
import java.time.Instant;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import static com.nabao.domain.QuotaModels.*;
import static com.nabao.domain.QuotaConsensus.*;

@Service
public class QuotaService {
    private final QuotaRepository repository;
    private final ObjectMapper json;
    public QuotaService(QuotaRepository repository, ObjectMapper json) { this.repository = repository; this.json = json; }
    public List<Source> sources() { return repository.sources(); }
    /**
     * A batch is atomic. An existing revision cannot be silently overwritten.
     * Read-committed lets a concurrent duplicate insert read the winner after its unique-key check.
     */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public BatchResult submit(List<ObservationInput> inputs) {
        lockAuthors(inputs.stream().map(ObservationInput::authorId).toList());
        for (ObservationInput input : inputs) {
            if (repository.hasSnapshots(input.authorId(), input.noteId())) {
                throw new ApplicationFailure(ApplicationFailure.Kind.CONFLICT,
                        "This note uses complete snapshots; publish through /internal/v1/note-snapshots");
            }
        }
        return insertObservations(inputs);
    }

    /**
     * A complete note revision replaces its previous rows, including removals. The author row
     * lock serializes snapshot activation and legacy writes without a separate lock service.
     */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public SnapshotResult submitSnapshot(NoteSnapshotInput snapshot) {
        lockAuthors(List.of(snapshot.authorId()));
        Set<String> itemKeys = new HashSet<>();
        for (ObservationInput item : snapshot.items()) {
            if (!item.authorId().equals(snapshot.authorId()) || !item.noteId().equals(snapshot.noteId())
                    || !item.noteRevision().equals(snapshot.noteRevision())
                    || !item.sourcePublishedAt().equals(snapshot.sourcePublishedAt())
                    || !Objects.equals(item.sourceUpdatedAt(), snapshot.sourceUpdatedAt())
                    || !item.capturedAt().equals(snapshot.capturedAt())) {
                throw new ApplicationFailure(ApplicationFailure.Kind.UNPROCESSABLE,
                        "Every snapshot item must match the note metadata");
            }
            if (!itemKeys.add(observationKey(item))) {
                throw new ApplicationFailure(ApplicationFailure.Kind.UNPROCESSABLE,
                        "A snapshot must contain at most one row per fund/scope/date");
            }
        }
        String snapshotKey = hash(List.of(snapshot.authorId(), snapshot.noteId(), snapshot.noteRevision()));
        String payloadHash = hash(Arrays.asList(snapshot.authorId(), snapshot.noteId(), snapshot.noteRevision(),
                snapshot.sourcePublishedAt(), snapshot.sourceUpdatedAt(), snapshot.evidenceRef(),
                snapshot.items().stream().map(this::payloadHash).sorted().toList()));
        String prior = repository.snapshotHash(snapshotKey);
        if (prior != null) {
            verifySameRevision(prior, payloadHash);
            return new SnapshotResult(SnapshotStatus.DUPLICATE, 0, snapshot.items().size());
        }

        List<StoredObservation> noteHistory = repository.noteHistory(snapshot.authorId(), snapshot.noteId());
        List<StoredObservation> sameRevision = noteHistory.stream()
                .filter(row -> row.input().noteRevision().equals(snapshot.noteRevision())).toList();
        // A first complete manifest cannot silently remove rows previously published under
        // the same immutable revision through the legacy batch API.
        if (sameRevision.stream().anyMatch(row -> !itemKeys.contains(observationKey(row.input())))) {
            throw new ApplicationFailure(ApplicationFailure.Kind.CONFLICT,
                    "This noteRevision already contains other rows; submit a new revision");
        }
        Instant capturedAt = sameRevision.stream().map(row -> row.input().capturedAt())
                .min(Instant::compareTo).filter(time -> time.isBefore(snapshot.capturedAt()))
                .orElse(snapshot.capturedAt());
        SourceOrder incoming = new SourceOrder(
                snapshot.sourceUpdatedAt() == null ? snapshot.sourcePublishedAt() : snapshot.sourceUpdatedAt(),
                capturedAt);
        SourceOrder active = repository.activeOrder(snapshot.authorId(), snapshot.noteId());
        SourceOrder current = active == null
                ? noteHistory.stream().reduce(QuotaConsensus::newer)
                    .map(row -> new SourceOrder(sourceTime(row.input()), row.input().capturedAt())).orElse(null)
                : active;
        boolean activate = current == null || incoming.compareTo(current) >= 0;
        BatchResult inserted = insertObservations(snapshot.items());
        if (activate) repository.deactivateSnapshots(snapshot.authorId(), snapshot.noteId());
        repository.insertSnapshot(snapshotKey, payloadHash, snapshot, capturedAt, activate, Instant.now());
        return new SnapshotResult(activate ? SnapshotStatus.ACTIVATED : SnapshotStatus.STALE,
                inserted.accepted(), inserted.duplicates());
    }

    private void lockAuthors(List<String> authors) {
        // Stable ordering also makes a legacy multi-author batch safe alongside note updates.
        for (String author : new TreeSet<>(authors)) {
            if (!repository.lockEnabledAuthor(author)) {
                throw new ApplicationFailure(ApplicationFailure.Kind.UNPROCESSABLE,
                        "authorId is not an enabled source");
            }
        }
    }

    private BatchResult insertObservations(List<ObservationInput> inputs) {
        int accepted = 0;
        int duplicates = 0;
        for (ObservationInput input : inputs) {
            String key = observationKey(input);
            // Collection time is transport metadata. Re-reading identical content must not make an
            // old revision current or cause a new vote, even if it was fetched again at a later time.
            String payloadHash = payloadHash(input);
            String prior = repository.observationHash(key);
            if (prior != null) {
                verifySameRevision(prior, payloadHash);
                duplicates++;
                continue;
            }
            if (repository.insertObservation(key, payloadHash, input, Instant.now())) accepted++;
            else {
                verifySameRevision(repository.observationHash(key), payloadHash);
                duplicates++;
            }
        }
        return new BatchResult(accepted, duplicates);
    }

    public List<Quota> quotas(String fundCode) { return QuotaConsensus.calculate(repository.activeObservations(fundCode)); }

    private String hash(Object value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(value)));
        } catch (JsonProcessingException | NoSuchAlgorithmException failure) {
            throw new IllegalStateException("Could not create observation fingerprint", failure);
        }
    }

    private String observationKey(ObservationInput input) {
        return hash(List.of(input.authorId(), input.noteId(), input.noteRevision(), keyOf(input)));
    }

    private String payloadHash(ObservationInput input) {
        return hash(Arrays.asList(input.authorId(), input.noteId(), input.noteRevision(),
                input.fundCode(), input.fundName(), input.channelScope(), input.businessType(),
                input.period(), input.limitKind(), input.amountMinor(), input.currency(),
                input.observedForDate(), input.sourcePublishedAt(), input.sourceUpdatedAt(),
                input.evidenceRef(), normalizedGroup(input.sourceGroupId())));
    }

    private static void verifySameRevision(String original, String submitted) {
        if (!MessageDigest.isEqual(original.getBytes(StandardCharsets.US_ASCII),
                submitted.getBytes(StandardCharsets.US_ASCII))) {
            throw new ApplicationFailure(ApplicationFailure.Kind.CONFLICT,
                    "This noteRevision already exists with different content; submit a new revision");
        }
    }

}
