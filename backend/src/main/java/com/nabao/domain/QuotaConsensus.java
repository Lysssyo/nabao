package com.nabao.domain;
import java.time.*;
import java.util.*;
import java.util.stream.Collectors;
import static com.nabao.domain.QuotaModels.*;

/** Legacy consensus rules: newest date/scope, one author vote and known-copy exclusions. */
public final class QuotaConsensus {
    private QuotaConsensus() {}
    public static List<Quota> calculate(List<StoredObservation> observations) {
        // Keep days separate. The public endpoint shows the most recent data date per scope,
        // including INSUFFICIENT/CONFLICT, rather than falling back to an older agreed value.
        Map<Scope, LocalDate> newestDates = new HashMap<>();
        for (StoredObservation row : observations) {
            newestDates.merge(scopeOf(row.input()), row.input().observedForDate(),
                    (a, b) -> a.isAfter(b) ? a : b);
        }
        Map<GroupKey, Map<String, StoredObservation>> groups = new LinkedHashMap<>();
        for (StoredObservation row : observations) {
            ObservationInput input = row.input();
            if (!input.observedForDate().equals(newestDates.get(scopeOf(input)))) {
                continue;
            }
            groups.computeIfAbsent(keyOf(input), ignored -> new LinkedHashMap<>())
                    .merge(input.authorId(), row, QuotaConsensus::newer);
        }
        return groups.values().stream().map(QuotaConsensus::consensus)
                .sorted(Comparator.comparing(Quota::fundCode)
                        .thenComparing(q -> q.channelScope().name())
                        .thenComparing(q -> q.businessType().name())
                        .thenComparing(q -> q.period().name())
                        .thenComparing(q -> q.currency().name()))
                .toList();
    }

    private static Quota consensus(Map<String, StoredObservation> authors) {
        List<StoredObservation> rows = new ArrayList<>(authors.values());
        rows.sort(Comparator.comparing(row -> row.input().authorId()));
        Map<String, List<StoredObservation>> origins = rows.stream()
                .collect(Collectors.groupingBy(row -> row.input().sourceGroupId() == null
                        || row.input().sourceGroupId().isBlank()
                        ? "author:" + row.input().authorId() : "group:" + row.input().sourceGroupId()));
        Map<Value, Integer> counts = new HashMap<>();
        Map<Long, String> exclusions = new HashMap<>();
        Set<Long> counted = new HashSet<>();
        for (List<StoredObservation> origin : origins.values()) {
            Set<Value> distinct = origin.stream().map(row -> valueOf(row.input())).collect(Collectors.toSet());
            if (distinct.size() > 1) {
                // Known copies disagree: do not invent a representative value.
                origin.forEach(row -> exclusions.put(row.id(), "SOURCE_GROUP_CONFLICT"));
                continue;
            }
            StoredObservation representative = origin.stream().reduce(QuotaConsensus::newer).orElseThrow();
            counts.merge(valueOf(representative.input()), 1, Integer::sum);
            counted.add(representative.id());
            origin.stream().filter(row -> row.id() != representative.id())
                    .forEach(row -> exclusions.put(row.id(), "SAME_SOURCE_GROUP"));
        }
        int sourceCount = origins.size();
        int supportCount = counts.values().stream().max(Integer::compareTo).orElse(0);
        boolean agreed = supportCount >= 2 && supportCount > sourceCount / 2;
        ConsensusStatus status = agreed ? ConsensusStatus.AGREED
                : sourceCount < 2 && exclusions.values().stream().noneMatch("SOURCE_GROUP_CONFLICT"::equals)
                ? ConsensusStatus.INSUFFICIENT : ConsensusStatus.CONFLICT;
        Value winner = agreed ? counts.entrySet().stream()
                .filter(entry -> entry.getValue() == supportCount).map(Map.Entry::getKey)
                .findFirst().orElseThrow() : null;

        StoredObservation newest = rows.stream().reduce(QuotaConsensus::newer).orElseThrow();
        ObservationInput sample = newest.input();
        List<Vote> votes = rows.stream().map(row -> new Vote(row.input().authorId(), row.input().noteId(),
                row.input().noteRevision(), row.input().evidenceRef(), normalizedGroup(row.input().sourceGroupId()),
                row.input().limitKind(), row.input().amountMinor(), counted.contains(row.id()), exclusions.get(row.id()),
                row.input().sourcePublishedAt(), row.input().sourceUpdatedAt(),
                row.input().capturedAt(), row.receivedAt())).toList();
        Instant updatedAt = rows.stream().map(row -> row.receivedAt()).max(Instant::compareTo).orElseThrow();
        return new Quota(sample.fundCode(), sample.fundName(), sample.channelScope(), sample.businessType(),
                sample.period(), sample.currency(), sample.observedForDate(),
                winner == null ? null : winner.kind(), winner == null ? null : winner.amount(),
                status, supportCount, sourceCount, votes, updatedAt);
    }

    public static StoredObservation newer(StoredObservation a, StoredObservation b) {
        int result = sourceTime(a.input()).compareTo(sourceTime(b.input()));
        if (result == 0) result = a.input().capturedAt().compareTo(b.input().capturedAt());
        // IDs only break a true timestamp tie; receiving an older source revision late cannot win.
        if (result == 0) result = Long.compare(a.id(), b.id());
        return result >= 0 ? a : b;
    }

    public static Instant sourceTime(ObservationInput input) {
        return input.sourceUpdatedAt() == null ? input.sourcePublishedAt() : input.sourceUpdatedAt();
    }

    private static Scope scopeOf(ObservationInput input) {
        return new Scope(input.fundCode(), input.channelScope(), input.businessType(), input.period(), input.currency());
    }

    public static GroupKey keyOf(ObservationInput input) {
        return new GroupKey(scopeOf(input), input.observedForDate());
    }

    private static Value valueOf(ObservationInput input) {
        return new Value(input.limitKind(), input.amountMinor());
    }

    public static String normalizedGroup(String value) {
        return value == null || value.isBlank() ? null : value;
    }

}
