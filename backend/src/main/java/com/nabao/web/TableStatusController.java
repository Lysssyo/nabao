package com.nabao.web;
import com.nabao.application.TableStatusService;
import com.nabao.domain.TableStatusModels.Dashboard;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
@RestController
public class TableStatusController {
    private final TableStatusService status;
    private final InternalKeyAuthorization authorization;
    public TableStatusController(TableStatusService status, InternalKeyAuthorization authorization) {
        this.status = status; this.authorization = authorization;
    }
    @GetMapping("/internal/v1/table-status")
    public ResponseEntity<Dashboard> dashboard(@RequestHeader(value = "X-Internal-Key", required = false) String supplied) {
        authorization.require(supplied, "Management access is not configured");
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(status.read());
    }
}
