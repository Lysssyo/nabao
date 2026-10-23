package com.nabao;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class PushController {
    public record Registration(
            @NotBlank @Pattern(regexp = "(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") String installationId,
            @NotBlank @Size(min = 32, max = 256) @Pattern(regexp = "[A-Za-z0-9_+/=-]+") String installationSecret,
            @NotBlank @Pattern(regexp = "(?:[0-9a-f]{2}){16,256}") String token,
            @NotBlank @Pattern(regexp = "sandbox|production") String environment) {}
    public record Registered(String installationId, String status, boolean deliveryEnabled,
                             String providerStatus, String environment) {}

    private final PushService pushes;
    public PushController(PushService pushes) { this.pushes = pushes; }

    @PostMapping("/api/v1/push-devices")
    public Registered register(@Valid @RequestBody Registration registration) {
        return pushes.register(registration);
    }

    @DeleteMapping("/api/v1/push-devices/{installationId}")
    public ResponseEntity<Void> unregister(@PathVariable String installationId,
            @RequestHeader(value = "X-Installation-Key", required = false) String secret) {
        pushes.unregister(installationId, secret);
        return ResponseEntity.noContent().build();
    }
}
