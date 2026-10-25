package com.nabao.domain;
import jakarta.validation.constraints.*;
import java.time.Instant;
public final class PushModels {
    private PushModels() {}
    public record Registration(
            @NotBlank @Pattern(regexp = "(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") String installationId,
            @NotBlank @Size(min = 32, max = 256) @Pattern(regexp = "[A-Za-z0-9_+/=-]+") String installationSecret,
            @NotBlank @Pattern(regexp = "(?:[0-9a-f]{2}){16,256}") String token,
            @NotBlank @Pattern(regexp = "sandbox|production") String environment) {}
    public record Registered(String installationId, String status, boolean deliveryEnabled,
                             String providerStatus, String environment) {}

    public record Device(String id, String secretHash, String token, String environment, boolean active,
                          String baseline, String accepted, String pending, int retryCount,
                          Instant nextAttempt, long version, Instant registeredAt, Instant createdAt) {}
}
