package com.nabao.web;

import com.nabao.application.*;
import com.nabao.domain.*;

import jakarta.validation.Valid;
import static com.nabao.domain.PushModels.*;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class PushController {
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
