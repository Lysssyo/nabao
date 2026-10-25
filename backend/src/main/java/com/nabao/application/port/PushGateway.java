package com.nabao.application.port;
import java.time.Instant;
public interface PushGateway {
    public record Status(String status, boolean enabled, String environment) {}
    public enum Outcome { ACCEPTED, RETRYABLE, INVALID_DEVICE, REJECTED, DISABLED }
    public record Result(Outcome outcome, String reason, long retryAfterSeconds, Instant invalidatedAt) {}

    Status status();
    Result send(String token, String environment, Instant now);
}
