package com.nabao;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;

@Component
public class ApnsClient {
    public record Status(String status, boolean enabled, String environment) {}
    public enum Outcome { ACCEPTED, RETRYABLE, INVALID_DEVICE, REJECTED, DISABLED }
    public record Result(Outcome outcome, String reason, long retryAfterSeconds, Instant invalidatedAt) {}

    private final ObjectMapper json;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_2)
            .connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final Status status;
    private final String bundleId;
    private final URI endpoint;
    private final boolean testEndpoint;
    private final ApnsTokenSigner signer;

    public ApnsClient(
            @Value("${nabao.apns.enabled:false}") boolean enabled,
            @Value("${nabao.apns.team-id:}") String teamId,
            @Value("${nabao.apns.key-id:}") String keyId,
            @Value("${nabao.apns.bundle-id:}") String bundleId,
            @Value("${nabao.apns.private-key-path:}") String privateKeyPath,
            @Value("${nabao.apns.environment:}") String apnsEnvironment,
            @Value("${nabao.apns.test-endpoint:}") String testEndpoint,
            Environment springEnvironment, ObjectMapper json) {
        this.json = json;
        this.bundleId = bundleId;
        this.testEndpoint = !testEndpoint.isBlank();
        String environment = apnsEnvironment.matches("sandbox|production") ? apnsEnvironment : null;
        Status configured;
        URI target = null;
        ApnsTokenSigner tokenSigner = null;
        if (!enabled) {
            configured = new Status("DISABLED", false, environment);
        } else if (teamId.isBlank() || keyId.isBlank() || bundleId.isBlank()
                || privateKeyPath.isBlank() || apnsEnvironment.isBlank()) {
            configured = new Status("NOT_CONFIGURED", false, environment);
        } else {
            try {
                if (environment == null || !teamId.matches("[A-Za-z0-9]{10}")
                        || !keyId.matches("[A-Za-z0-9]{10}")
                        || !bundleId.matches("[A-Za-z0-9][A-Za-z0-9.-]{1,254}")) {
                    throw new IllegalArgumentException("Invalid APNs configuration");
                }
                if (this.testEndpoint) {
                    target = URI.create(testEndpoint);
                    boolean loopback = "127.0.0.1".equals(target.getHost())
                            || "[::1]".equals(target.getHost()) || "::1".equals(target.getHost());
                    if (!Arrays.asList(springEnvironment.getActiveProfiles()).contains("test")
                            || !loopback || !"http".equals(target.getScheme()) || target.getPort() < 1 || target.getPort() > 65535
                            || target.getUserInfo() != null || target.getQuery() != null || target.getFragment() != null
                            || !(target.getPath().isEmpty() || "/".equals(target.getPath()))) {
                        throw new IllegalArgumentException("Invalid APNs test endpoint");
                    }
                } else {
                    target = URI.create(environment.equals("sandbox")
                            ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
                }
                tokenSigner = new ApnsTokenSigner(teamId, keyId, Path.of(privateKeyPath), Clock.systemUTC());
                configured = new Status("READY", true, environment);
            } catch (IllegalArgumentException error) {
                configured = new Status("INVALID_CONFIGURATION", false, environment);
                target = null;
            }
        }
        this.status = configured;
        this.endpoint = target;
        this.signer = tokenSigner;
    }

    public Status status() { return status; }

    public Result send(String deviceToken, String environment, Instant now) {
        if (!status.enabled() || !status.environment().equals(environment)) {
            return new Result(Outcome.DISABLED, "NOT_ENABLED", 0, null);
        }
        if (!deviceToken.matches("(?:[0-9a-f]{2}){16,256}")) {
            return new Result(Outcome.INVALID_DEVICE, "INVALID_TOKEN", 0, null);
        }
        try {
            String payload = json.writeValueAsString(Map.of(
                    "aps", Map.of("alert", Map.of("title", "纳宝额度更新",
                            "body", "公开参考额度有更新，请打开纳宝核对定投"), "sound", "default"),
                    "screen", "quotas"));
            HttpRequest request = HttpRequest.newBuilder(endpoint.resolve("/3/device/" + deviceToken))
                    .version(HttpClient.Version.HTTP_2).timeout(Duration.ofSeconds(10))
                    .header("authorization", "bearer " + signer.token())
                    .header("apns-topic", bundleId).header("apns-push-type", "alert")
                    .header("apns-priority", "10").header("apns-collapse-id", "nabao-public-quotas")
                    .header("apns-id", UUID.randomUUID().toString())
                    .header("apns-expiration", Long.toString(now.plusSeconds(3600).getEpochSecond()))
                    .header("content-type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(payload)).build();
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (!testEndpoint && response.version() != HttpClient.Version.HTTP_2) {
                return new Result(Outcome.RETRYABLE, "PROTOCOL_ERROR", 0, null);
            }
            int code = response.statusCode();
            if (code == 200) return new Result(Outcome.ACCEPTED, "ACCEPTED", 0, null);
            String reason = "APNS_" + code;
            Instant invalidatedAt = null;
            try {
                var body = json.readTree(response.body());
                String suppliedReason = body.path("reason").asText();
                if (suppliedReason.matches("[A-Za-z0-9_]{1,64}")) reason = suppliedReason;
                if (body.path("timestamp").canConvertToLong() && body.path("timestamp").asLong() > 0) {
                    invalidatedAt = Instant.ofEpochMilli(body.path("timestamp").asLong());
                }
            } catch (Exception ignored) { /* No response bodies or tokens are logged. */ }
            if (code == 410 || (code == 400 && reason.equals("BadDeviceToken"))) {
                return new Result(Outcome.INVALID_DEVICE, reason, 0, invalidatedAt);
            }
            if (code == 429 || code >= 500) {
                long delay = retryAfter(response.headers().firstValue("retry-after").orElse(""), now);
                return new Result(Outcome.RETRYABLE, reason, delay, null);
            }
            return new Result(Outcome.REJECTED, reason, 0, null);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return new Result(Outcome.RETRYABLE, "INTERRUPTED", 0, null);
        } catch (IOException error) {
            return new Result(Outcome.RETRYABLE, "TRANSPORT_ERROR", 0, null);
        } catch (IllegalStateException error) {
            return new Result(Outcome.REJECTED, "SIGNING_ERROR", 0, null);
        }
    }

    private static long retryAfter(String value, Instant now) {
        try {
            long seconds = value.matches("[0-9]+") ? Long.parseLong(value)
                    : Duration.between(now, ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()).getSeconds();
            return Math.max(0, Math.min(3600, seconds));
        } catch (RuntimeException ignored) { return 0; }
    }
}
