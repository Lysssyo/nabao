package com.nabao.web;
import com.nabao.application.HealthService;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
@RestController
public class SystemController {
    private final HealthService health;
    public SystemController(HealthService health) { this.health = health; }
    @GetMapping("/api/v1/health")
    public Map<String, Object> health() { return health.health(); }
    @GetMapping({"/admin", "/admin/"})
    public ResponseEntity<Void> admin() {
        return ResponseEntity.status(HttpStatus.FOUND).header("Location", "/admin/index.html").build();
    }
}
