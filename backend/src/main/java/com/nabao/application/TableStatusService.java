package com.nabao.application;

import com.nabao.application.port.CollectorStatusRepository;
import static com.nabao.domain.TableStatusModels.*;
import static com.nabao.domain.DailyTableModels.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import java.time.Instant;

/** Reconcile the independent collector attempt and the actual publication; never splice revisions. */
@Service
public class TableStatusService {
    private final CollectorStatusRepository statuses;
    private final DailyTableService tables;
    private final long staleAfterSeconds;
    public TableStatusService(CollectorStatusRepository statuses, DailyTableService tables,
            @Value("${nabao.status-stale-seconds:43200}") long staleAfterSeconds) {
        if (staleAfterSeconds < 60) throw new IllegalArgumentException("Status stale threshold must be at least 60 seconds");
        this.statuses = statuses; this.tables = tables; this.staleAfterSeconds = staleAfterSeconds;
    }
    public Dashboard read() { return read(Instant.now()); }
    Dashboard read(Instant now) {
        Snapshot snapshot = null;
        String tableState = "AVAILABLE";
        try { snapshot = tables.readSnapshot(); }
        catch (ApplicationFailure error) { tableState = error.kind() == ApplicationFailure.Kind.NOT_FOUND ? "MISSING" : "INVALID"; }
        Summary summary;
        try { summary = statuses.read(now); }
        catch (ApplicationFailure error) {
            return dashboard(tableState, snapshot, error.kind() == ApplicationFailure.Kind.NOT_FOUND ? "MISSING" : "INVALID", false, null);
        }
        boolean stale = Instant.parse(summary.lastAttempt()).isBefore(now.minusSeconds(staleAfterSeconds));
        Published published = summary.published();
        if ((snapshot == null) != (published == null) || (snapshot != null &&
                (!snapshot.digest().equals(published.digest()) || !snapshot.table().dataDate().equals(published.dataDate())
                        || !snapshot.table().updatedAt().equals(published.updatedAt()) || snapshot.table().rows().size() != published.rowCount()
                        || adopted(snapshot.table()) != published.adoptedFields()))) {
            // A publisher may be between two atomic writes. Keep the actual table visible,
            // but never attach stale source/counter metadata to a different table revision.
            return dashboard(tableState, snapshot, "INCONSISTENT", stale, null);
        }
        return dashboard(tableState, snapshot, stale ? "STALE" : "AVAILABLE", stale, summary);
    }

    private Dashboard dashboard(String tableState, Snapshot snapshot, String summaryState, boolean stale, Summary summary) {
        return new Dashboard(tableState, snapshot == null ? null : snapshot.table(), summaryState, stale, staleAfterSeconds, summary);
    }

    static int adopted(Table table) {
        int count = 0;
        for (var row : table.rows()) {
            if (row.feeRate() != null) count++;
            if (!row.distributorLimit().equals("待更新")) count++;
            if (!row.directLimit().equals("待更新")) count++;
            if (row.trackingError() != null) count++;
            if (row.return1y() != null) count++;
        }
        return count;
    }

}
