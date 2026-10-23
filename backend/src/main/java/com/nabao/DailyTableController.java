package com.nabao;

import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DailyTableController {
    private final DailyTableService tables;

    public DailyTableController(DailyTableService tables) { this.tables = tables; }

    @GetMapping("/api/v1/table")
    public ResponseEntity<DailyTableService.Table> table() {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(tables.read());
    }
}
