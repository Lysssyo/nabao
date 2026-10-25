package com.nabao.web;
import com.nabao.application.DailyTableService;
import com.nabao.domain.DailyTableModels.Table;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
@RestController
public class DailyTableController {
    private final DailyTableService tables;
    public DailyTableController(DailyTableService tables) { this.tables = tables; }
    @GetMapping("/api/v1/table")
    public ResponseEntity<Table> table() { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(tables.read()); }
    @GetMapping("/api/v1/readiness")
    public ResponseEntity<Map<String, Object>> readiness() {
        var result = tables.readiness();
        return ResponseEntity.status(result.ready() ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
                .cacheControl(CacheControl.noStore()).body(result.body());
    }
}
