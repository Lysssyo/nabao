package com.nabao.web;
import com.nabao.application.QuotaService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import static com.nabao.domain.QuotaModels.*;
/** Compatibility APIs retain their existing contract independently of the current daily table. */
@RestController
public class QuotaController {
    private final QuotaService quotas;
    private final InternalKeyAuthorization authorization;
    public QuotaController(QuotaService quotas, InternalKeyAuthorization authorization) {
        this.quotas = quotas; this.authorization = authorization;
    }
    @GetMapping("/api/v1/sources")
    public Items<Source> sources() {
        return new Items<>(quotas.sources());
    }

    @GetMapping("/api/v1/quotas")
    public Items<Quota> quotas(@RequestParam(required = false) String fundCode) {
        if (fundCode != null && !fundCode.matches("[0-9]{6}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "fundCode must contain exactly six digits");
        }
        return new Items<>(quotas.quotas(fundCode));
    }

    @PostMapping("/internal/v1/observations")
    public BatchResult submit(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey,
                              @Valid @RequestBody ObservationBatch batch) {
        authorization.require(suppliedKey, "Observation ingestion is not configured");
        return quotas.submit(batch.items());
    }

    @PostMapping("/internal/v1/note-snapshots")
    public SnapshotResult snapshot(@RequestHeader(value = "X-Internal-Key", required = false) String suppliedKey,
                                   @Valid @RequestBody NoteSnapshotInput snapshot) {
        authorization.require(suppliedKey, "Observation ingestion is not configured");
        return quotas.submitSnapshot(snapshot);
    }

}
