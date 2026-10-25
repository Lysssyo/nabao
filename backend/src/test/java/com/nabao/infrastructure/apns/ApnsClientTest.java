package com.nabao.infrastructure.apns;

import com.nabao.domain.*;
import com.nabao.infrastructure.file.*;
import com.nabao.infrastructure.jdbc.*;
import com.nabao.infrastructure.apns.ApnsClient;


import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.env.MockEnvironment;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static com.nabao.application.port.PushGateway.*;
import static org.assertj.core.api.Assertions.*;

class ApnsClientTest {
    static final String TOKEN = "ab".repeat(32);
    static final Instant NOW = Instant.parse("2026-10-21T01:00:00Z");
    final ObjectMapper json = new ObjectMapper();
    @TempDir Path directory;
    HttpServer server;
    KeyPair keys;
    Path keyPath;
    final AtomicInteger requests = new AtomicInteger();
    int responseStatus = 200;
    String responseBody = "";
    String retryAfter;
    final AtomicReference<String> authorization = new AtomicReference<>();
    final AtomicReference<String> payload = new AtomicReference<>();
    final AtomicReference<com.sun.net.httpserver.Headers> headers = new AtomicReference<>();
    final AtomicReference<String> requestPath = new AtomicReference<>();

    @BeforeEach void setup() throws Exception {
        var generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        keys = generator.generateKeyPair();
        keyPath = directory.resolve("generated-test-key.p8");
        Files.writeString(keyPath, "-----BEGIN PRIVATE KEY-----\n" +
                Base64.getMimeEncoder().encodeToString(keys.getPrivate().getEncoded()) + "\n-----END PRIVATE KEY-----\n");
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", this::respond);
        server.start();
    }

    @AfterEach void cleanup() { server.stop(0); }

    @Test void sendsOnlyGenericPublicChangePayloadWithVerifiedEs256Authorization() throws Exception {
        Result result = client(true, endpoint(), true).send(TOKEN, "sandbox", NOW);
        assertThat(result.outcome()).isEqualTo(Outcome.ACCEPTED);
        assertThat(requestPath.get()).isEqualTo("/3/device/" + TOKEN);
        var h = headers.get();
        assertThat(h.getFirst("apns-topic")).isEqualTo("com.example.nabao");
        assertThat(h.getFirst("apns-push-type")).isEqualTo("alert");
        assertThat(h.getFirst("apns-priority")).isEqualTo("10");
        assertThat(h.getFirst("apns-collapse-id")).isEqualTo("nabao-public-quotas");
        assertThat(h.getFirst("apns-expiration")).isEqualTo(Long.toString(NOW.plusSeconds(3600).getEpochSecond()));
        assertThat(h.getFirst("apns-id")).matches("[0-9a-f-]{36}");
        var body = json.readTree(payload.get());
        assertThat(body.size()).isEqualTo(2);
        assertThat(body.path("screen").asText()).isEqualTo("quotas");
        assertThat(body.at("/aps/alert/body").asText()).isEqualTo("公开参考额度有更新，请打开纳宝核对定投");
        assertThat(payload.get()).doesNotContain(TOKEN, "installation", "amount", "plan");
        String[] token = authorization.get().substring("bearer ".length()).split("\\.");
        assertThat(token).hasSize(3);
        var jwtHeader = json.readTree(Base64.getUrlDecoder().decode(token[0]));
        assertThat(jwtHeader.path("alg").asText()).isEqualTo("ES256");
        assertThat(jwtHeader.path("kid").asText()).isEqualTo("KEY1234567");
        var jwtClaims = json.readTree(Base64.getUrlDecoder().decode(token[1]));
        assertThat(jwtClaims.path("iss").asText()).isEqualTo("TEAM123456");
        assertThat(jwtClaims.path("iat").asLong()).isBetween(Instant.now().minusSeconds(5).getEpochSecond(), Instant.now().getEpochSecond());
        var verifier = Signature.getInstance("SHA256withECDSAinP1363Format");
        verifier.initVerify(keys.getPublic());
        verifier.update((token[0] + "." + token[1]).getBytes(StandardCharsets.US_ASCII));
        assertThat(verifier.verify(Base64.getUrlDecoder().decode(token[2]))).isTrue();
    }

    @ParameterizedTest
    @CsvSource({"400,BadDeviceToken,INVALID_DEVICE", "410,Unregistered,INVALID_DEVICE",
            "429,TooManyRequests,RETRYABLE", "500,InternalServerError,RETRYABLE", "503,ServiceUnavailable,RETRYABLE",
            "403,ExpiredProviderToken,REJECTED", "400,DeviceTokenNotForTopic,REJECTED"})
    void classifiesProviderErrorsWithoutAcceptingFailedDelivery(int status, String reason, Outcome outcome) {
        responseStatus = status;
        responseBody = "{\"reason\":\"" + reason + "\",\"timestamp\":1234567890000}";
        var result = client(true, endpoint(), true).send(TOKEN, "sandbox", NOW);
        assertThat(result.outcome()).isEqualTo(outcome);
        assertThat(result.reason()).isEqualTo(reason);
        assertThat(result.invalidatedAt()).isEqualTo(outcome == Outcome.INVALID_DEVICE ? Instant.ofEpochMilli(1234567890000L) : null);
    }

    @ParameterizedTest @CsvSource({"600,600", "999999,3600", "invalid,0"})
    void usesBoundedRetryAfterForTransientResponse(String value, long expected) {
        responseStatus = 429; responseBody = "{\"reason\":\"TooManyRequests\"}"; retryAfter = value;
        assertThat(client(true, endpoint(), true).send(TOKEN, "sandbox", NOW).retryAfterSeconds()).isEqualTo(expected);
    }

    @Test void supportsHttpDateRetryAfter() {
        responseStatus = 503; retryAfter = "Wed, 21 Oct 2026 01:10:00 GMT";
        assertThat(client(true, endpoint(), true).send(TOKEN, "sandbox", NOW).retryAfterSeconds()).isEqualTo(600);
    }

    @Test void unsafeReasonAndMalformedBodyCannotLeakUpstreamContent() {
        responseStatus = 500; responseBody = "{\"reason\":\"secret token is abc\"}";
        assertThat(client(true, endpoint(), true).send(TOKEN, "sandbox", NOW).reason()).isEqualTo("APNS_500");
        responseBody = "not-json secret";
        assertThat(client(true, endpoint(), true).send(TOKEN, "sandbox", NOW).reason()).isEqualTo("APNS_500");
    }

    @Test void neverFollowsRedirectsWithProviderCredential() {
        responseStatus = 302;
        assertThat(client(true, endpoint(), true).send(TOKEN, "sandbox", NOW).outcome()).isEqualTo(Outcome.REJECTED);
        assertThat(requests.get()).isEqualTo(1);
    }

    @Test void disabledOrWrongEnvironmentCannotSend() {
        var disabled = client(false, endpoint(), true);
        assertThat(disabled.status().status()).isEqualTo("DISABLED");
        assertThat(disabled.send(TOKEN, "sandbox", NOW).outcome()).isEqualTo(Outcome.DISABLED);
        assertThat(client(true, endpoint(), true).send(TOKEN, "production", NOW).outcome()).isEqualTo(Outcome.DISABLED);
        assertThat(requests.get()).isZero();
    }

    @Test void badTokenCannotBecomeAPathOrHeaderInjection() {
        assertThat(client(true, endpoint(), true).send("../different", "sandbox", NOW).outcome()).isEqualTo(Outcome.INVALID_DEVICE);
        assertThat(requests.get()).isZero();
    }

    @Test void testEndpointOutsideTestProfileDisablesSending() {
        var client = client(true, endpoint(), false);
        assertThat(client.status().status()).isEqualTo("INVALID_CONFIGURATION");
        assertThat(client.send(TOKEN, "sandbox", NOW).outcome()).isEqualTo(Outcome.DISABLED);
        assertThat(requests.get()).isZero();
    }

    @ParameterizedTest @ValueSource(strings = {"http://localhost:1234", "https://127.0.0.1:1234",
            "http://example.com:1234", "http://127.0.0.1:1234/path", "http://127.0.0.1:1234?key=foo",
            "http://127.0.0.1:1234#fragment", "http://user@127.0.0.1:1234", "http://127.0.0.1", "http://127.0.0.1:99999", "not a URI"})
    void testEndpointRequiresNumericLoopbackRootWithoutCredentialsOrQuery(String value) {
        var client = client(true, value, true);
        assertThat(client.status().status()).isEqualTo("INVALID_CONFIGURATION");
        assertThat(client.send(TOKEN, "sandbox", NOW).outcome()).isEqualTo(Outcome.DISABLED);
        assertThat(requests.get()).isZero();
    }

    @Test void missingOrInvalidKeyDisablesSendingWithoutLeakingPath() throws Exception {
        Files.delete(keyPath);
        var client = client(true, endpoint(), true);
        assertThat(client.status().status()).isEqualTo("INVALID_CONFIGURATION");
        assertThat(client.send(TOKEN, "sandbox", NOW).outcome()).isEqualTo(Outcome.DISABLED);
        assertThat(client.status().toString()).doesNotContain(keyPath.toString());
        assertThat(requests.get()).isZero();
    }

    @Test void missingConfigurationDoesNotAttemptToReadKeyOrSend() {
        var env = new MockEnvironment(); env.setActiveProfiles("test");
        var client = new ApnsClient(true, "", "", "", keyPath.toString(), "sandbox", endpoint(), env, json);
        assertThat(client.status().status()).isEqualTo("NOT_CONFIGURED");
        assertThat(client.send(TOKEN, "sandbox", NOW).outcome()).isEqualTo(Outcome.DISABLED);
        assertThat(requests.get()).isZero();
    }

    @Test void closedLocalProviderIsRetryable() {
        var client = client(true, endpoint(), true);
        server.stop(0);
        assertThat(client.send(TOKEN, "sandbox", NOW).outcome()).isEqualTo(Outcome.RETRYABLE);
    }

    private ApnsClient client(boolean enabled, String endpoint, boolean testProfile) {
        var env = new MockEnvironment(); env.setActiveProfiles(testProfile ? "test" : "local");
        return new ApnsClient(enabled, "TEAM123456", "KEY1234567", "com.example.nabao", keyPath.toString(),
                "sandbox", endpoint, env, json);
    }
    private String endpoint() { return "http://127.0.0.1:" + server.getAddress().getPort(); }
    private void respond(HttpExchange exchange) throws java.io.IOException {
        requests.incrementAndGet();
        authorization.set(exchange.getRequestHeaders().getFirst("authorization"));
        headers.set(exchange.getRequestHeaders()); requestPath.set(exchange.getRequestURI().getPath());
        payload.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        if (retryAfter != null) exchange.getResponseHeaders().set("retry-after", retryAfter);
        if (responseStatus == 302) exchange.getResponseHeaders().set("location", endpoint() + "/redirected");
        byte[] bytes = responseBody.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(responseStatus, bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) exchange.getResponseBody().write(bytes);
        exchange.close();
    }
}
