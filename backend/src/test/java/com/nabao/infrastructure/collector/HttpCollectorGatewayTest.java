package com.nabao.infrastructure.collector;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.nabao.application.ApplicationFailure;
import com.nabao.domain.CollectorModels.Action;
import com.nabao.domain.CollectorModels.AuthorInput;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.*;

class HttpCollectorGatewayTest {
    HttpServer server;
    HttpCollectorGateway gateway;
    AtomicReference<String> observed = new AtomicReference<>();
    AtomicReference<byte[]> observedBody = new AtomicReference<>();
    AtomicReference<String> observedContentType = new AtomicReference<>();
    int code = 200;
    long delayBodyMillis = 0;
    String contentType = "application/json";
    byte[] reply = """
        {"available":true,"busy":false,"session":{"status":"unchecked","checkedAt":null,"message":"unchecked"},
        "run":null,"schedule":{"enabled":true,"intervalMinutes":360,"nextRunAt":null},
        "login":{"status":"idle","startedAt":null,"expiresAt":null,"verifiedAt":null,"message":"login","previewAvailable":false},
        "sources":[{"id":"123","name":"source"}]}
        """.getBytes(StandardCharsets.UTF_8);

    @BeforeEach void setup() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            observed.set(exchange.getRequestMethod() + " " + exchange.getRequestURI());
            assertThat(exchange.getRequestHeaders().getFirst("X-Internal-Key")).isEqualTo("private-control-key");
            observedBody.set(exchange.getRequestBody().readAllBytes());
            observedContentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            exchange.getResponseHeaders().add("Content-Type", contentType);
            exchange.sendResponseHeaders(code, reply.length);
            try (var output = exchange.getResponseBody()) {
                if (delayBodyMillis > 0) try { Thread.sleep(delayBodyMillis); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                output.write(reply);
            }
        });
        server.start();
        gateway = new HttpCollectorGateway("http://127.0.0.1:" + server.getAddress().getPort(), "private-control-key", new ObjectMapper());
    }
    @AfterEach void stop() { server.stop(0); }

    @Test void everyActionHasAFixedMethodAndPath() {
        String[] expected = {"GET /status", "POST /runs", "POST /login", "POST /login/complete", "DELETE /login", "POST /session/check"};
        int index = 0;
        for (Action action : Action.values()) {
            assertThat(gateway.execute(action).available()).isTrue();
            assertThat(observed.get()).isEqualTo(expected[index++]);
            assertThat(observedBody.get()).isEmpty();
        }
    }
    @Test void authorMutationsUseOnlyFixedPathsAndStructuredBodies() throws Exception {
        String id = "123456789012345678901234";
        String profile = "https://www.xiaohongshu.com/user/profile/" + id;
        reply = new String(reply, StandardCharsets.UTF_8).replace("\"id\":\"123\",\"name\":\"source\"",
                "\"id\":\"" + id + "\",\"name\":\"作者\",\"profileUrl\":\"" + profile + "\"").getBytes(StandardCharsets.UTF_8);
        var input = new AuthorInput("作者", profile + "?xsec_token=provided-query");
        var created = gateway.addAuthor(input);
        assertThat(observed.get()).isEqualTo("POST /authors");
        assertThat(observedContentType.get()).isEqualTo("application/json");
        assertThat(new ObjectMapper().readTree(observedBody.get()))
                .isEqualTo(new ObjectMapper().valueToTree(input));
        assertThat(created.sources().getFirst().profileUrl()).isEqualTo(profile);
        assertThat(gateway.deleteAuthor(id).sources()).isEqualTo(created.sources());
        assertThat(observed.get()).isEqualTo("DELETE /authors/" + id);
        assertThat(observedBody.get()).isEmpty();
    }
    @Test void oldSourcesWithoutProfileUrlsRemainReadable() {
        assertThat(gateway.execute(Action.STATUS).sources().getFirst().profileUrl()).isNull();
    }
    @Test void neverPassesUnknownWorkerFieldsToClients() throws Exception {
        var mapper = new ObjectMapper().disable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
        var safe = new HttpCollectorGateway("http://127.0.0.1:" + server.getAddress().getPort(), "private-control-key", mapper);
        reply = new String(reply, StandardCharsets.UTF_8).replace("\"name\":\"source\"", "\"name\":\"source\",\"cookie\":\"SECRET\"")
                .replace("\"available\":true", "\"available\":true,\"sessionPath\":\"SECRET\"").getBytes(StandardCharsets.UTF_8);
        assertThat(mapper.writeValueAsString(safe.execute(Action.STATUS))).doesNotContain("SECRET", "cookie", "sessionPath");
    }
    @Test void validatesDeleteIdsBeforeContactingWorker() {
        for (String id : new String[]{null, "", "../login", "12345678901234567890123A", "123456789012345678901234?token=SECRET"}) {
            assertThatThrownBy(() -> gateway.deleteAuthor(id)).isInstanceOfSatisfying(ApplicationFailure.class,
                    error -> assertThat(error.kind()).isEqualTo(ApplicationFailure.Kind.INVALID_INPUT));
        }
        assertThat(observed.get()).isNull();
    }
    @Test void mapsAuthorErrorsWithoutReflectingWorkerDetails() {
        reply = "SECRET-cookie and internal path".getBytes(StandardCharsets.UTF_8);
        for (var pair : java.util.Map.of(400, ApplicationFailure.Kind.INVALID_INPUT,
                404, ApplicationFailure.Kind.NOT_FOUND, 409, ApplicationFailure.Kind.CONFLICT).entrySet()) {
            code = pair.getKey();
            assertThatThrownBy(() -> gateway.addAuthor(new AuthorInput("作者", "https://www.xiaohongshu.com/user/profile/123456789012345678901234")))
                    .isInstanceOfSatisfying(ApplicationFailure.class, error -> {
                        assertThat(error.kind()).isEqualTo(pair.getValue());
                        assertThat(error.getMessage()).doesNotContain("SECRET", "internal path");
                    });
            assertThatThrownBy(() -> gateway.deleteAuthor("123456789012345678901234"))
                    .isInstanceOfSatisfying(ApplicationFailure.class, error -> {
                        assertThat(error.kind()).isEqualTo(pair.getValue());
                        assertThat(error.getMessage()).doesNotContain("SECRET", "internal path");
                    });
        }
    }
    @Test void rejectsSecretsFromRemoteErrorsAndReportsConflict() {
        code = 409; reply = "SECRET-cookie".getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> gateway.execute(Action.COMPLETE_LOGIN)).isInstanceOfSatisfying(ApplicationFailure.class,
                error -> { assertThat(error.kind()).isEqualTo(ApplicationFailure.Kind.CONFLICT); assertThat(error.getMessage()).doesNotContain("SECRET"); });
        code = 500;
        assertThatThrownBy(() -> gateway.execute(Action.STATUS)).isInstanceOfSatisfying(ApplicationFailure.class,
                error -> { assertThat(error.kind()).isEqualTo(ApplicationFailure.Kind.UNAVAILABLE); assertThat(error.getMessage()).doesNotContain("SECRET"); });
    }
    @Test void rejectsMissingConfigurationWithoutContactingWorker() {
        var unconfigured = new HttpCollectorGateway("http://127.0.0.1:" + server.getAddress().getPort(), "", new ObjectMapper());
        assertThatThrownBy(() -> unconfigured.execute(Action.STATUS)).isInstanceOf(ApplicationFailure.class);
        assertThat(observed.get()).isNull();
    }
    @Test void acceptsOnlyBoundedPngPreview() {
        contentType = "image/png"; reply = new byte[]{(byte)137, 80, 78, 71, 13, 10, 26, 10, 1};
        assertThat(gateway.loginPreview()).isEqualTo(reply);
        assertThat(observed.get()).isEqualTo("GET /login/preview");
        reply = "<html>cookie SECRET</html>".getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(gateway::loginPreview).isInstanceOf(ApplicationFailure.class).hasMessageNotContaining("SECRET");
    }
    @Test void rejectsMalformedOrOversizedResponses() {
        reply = "null".getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> gateway.execute(Action.STATUS)).isInstanceOf(ApplicationFailure.class);
        reply = "{}".getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> gateway.execute(Action.STATUS)).isInstanceOf(ApplicationFailure.class);
        reply = new byte[128 * 1024 + 1];
        assertThatThrownBy(() -> gateway.execute(Action.STATUS)).isInstanceOf(ApplicationFailure.class);
    }
    @Test void deadlineIncludesAStalledResponseBody() {
        delayBodyMillis = 1000;
        var fast = new HttpCollectorGateway("http://127.0.0.1:" + server.getAddress().getPort(), "private-control-key", new ObjectMapper(), java.time.Duration.ofMillis(200));
        long started = System.nanoTime();
        assertThatThrownBy(() -> fast.execute(Action.STATUS)).isInstanceOf(ApplicationFailure.class);
        assertThat(java.time.Duration.ofNanos(System.nanoTime() - started).toMillis()).isLessThan(800);
    }
    @Test void doesNotFollowRedirects() {
        code = 302;
        assertThatThrownBy(() -> gateway.execute(Action.STATUS)).isInstanceOf(ApplicationFailure.class);
    }
    @Test void rejectsConfigurablePathCredentialsAndNonHttpOrigins() {
        for (String url : new String[]{"file:///etc/passwd", "http://user:secret@localhost", "http://localhost/path", "http://localhost?token=secret"})
            assertThatThrownBy(() -> new HttpCollectorGateway(url, "private-control-key", new ObjectMapper())).isInstanceOf(IllegalArgumentException.class);
    }
}
