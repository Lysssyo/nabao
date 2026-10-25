package com.nabao.infrastructure.collector;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.nabao.application.ApplicationFailure;
import com.nabao.application.port.CollectorGateway;
import com.nabao.domain.CollectorModels.Action;
import com.nabao.domain.CollectorModels.Status;
import com.nabao.domain.CollectorModels.AuthorInput;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Arrays;
import java.util.Set;
import java.util.List;
import java.nio.ByteBuffer;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;

@Component
public class HttpCollectorGateway implements CollectorGateway {
    private static final byte[] PNG = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};
    private final URI base;
    private final String key;
    private final ObjectMapper json;
    private final Duration deadline;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NEVER).build();

    @Autowired
    public HttpCollectorGateway(@Value("${nabao.collector.url:http://127.0.0.1:18082}") String url,
                                @Value("${nabao.collector.key:}") String key, ObjectMapper json) {
        this(url, key, json, Duration.ofSeconds(55));
    }

    HttpCollectorGateway(String url, String key, ObjectMapper json, Duration deadline) {
        URI candidate = URI.create(url);
        if (!Set.of("http", "https").contains(candidate.getScheme()) || candidate.getHost() == null
                || candidate.getRawUserInfo() != null || candidate.getRawQuery() != null || candidate.getRawFragment() != null
                || !(candidate.getPath().isEmpty() || candidate.getPath().equals("/")))
            throw new IllegalArgumentException("Collector URL must be an HTTP origin");
        this.base = candidate; this.key = key; this.json = json; this.deadline = deadline;
    }

    @Override public Status execute(Action action) {
        String path = switch (action) {
            case STATUS -> "/status";
            case RUN -> "/runs";
            case LOGIN, CANCEL_LOGIN -> "/login";
            case COMPLETE_LOGIN -> "/login/complete";
            case CHECK_SESSION -> "/session/check";
        };
        String method = action == Action.STATUS ? "GET" : action == Action.CANCEL_LOGIN ? "DELETE" : "POST";
        return readStatus(request(method, path, false, action));
    }

    @Override public Status addAuthor(AuthorInput input) {
        try {
            return readStatus(request("POST", "/authors", false, null, json.writeValueAsBytes(input)));
        } catch (IOException error) { throw unavailable(); }
    }

    @Override public Status deleteAuthor(String authorId) {
        if (authorId == null || !authorId.matches("[a-f0-9]{24}"))
            throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT, "作者ID格式不正确。");
        return readStatus(request("DELETE", "/authors/" + authorId, false, null));
    }

    private Status readStatus(byte[] body) {
        try {
            Status value = json.readValue(body, Status.class);
            if (value == null || !value.available() || value.session() == null || value.login() == null || value.schedule() == null || value.sources() == null)
                throw unavailable();
            return value;
        } catch (IOException error) { throw unavailable(); }
    }

    @Override public byte[] loginPreview() { return request("GET", "/login/preview", true, Action.LOGIN); }

    private byte[] request(String method, String path, boolean image, Action action) {
        return request(method, path, image, action, null);
    }

    private byte[] request(String method, String path, boolean image, Action action, byte[] payload) {
        if (key.isBlank()) throw new ApplicationFailure(ApplicationFailure.Kind.UNAVAILABLE, "采集控制服务尚未配置。");
        var builder = HttpRequest.newBuilder(base.resolve(path)).timeout(deadline)
                .header("X-Internal-Key", key).header("Accept", image ? "image/png" : "application/json");
        if (payload != null) builder.header("Content-Type", "application/json");
        HttpRequest request = builder.method(method, payload == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofByteArray(payload)).build();
        int max = image ? 2 * 1024 * 1024 : 128 * 1024;
        var pending = client.sendAsync(request, ignored -> new LimitedBody(max));
        try {
            // The deadline covers headers AND the complete body; a streaming worker cannot hang a servlet.
            HttpResponse<byte[]> response = pending.get(deadline.toMillis(), TimeUnit.MILLISECONDS);
            if (response.statusCode() == 400) throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT,
                    "作者信息不正确，请检查名称和主页链接。");
            if (response.statusCode() == 404) throw new ApplicationFailure(ApplicationFailure.Kind.NOT_FOUND,
                    "未找到该作者，请刷新作者列表。");
            if (response.statusCode() == 409) throw new ApplicationFailure(ApplicationFailure.Kind.CONFLICT,
                    action == Action.COMPLETE_LOGIN ? "尚未检测到已登录账号，请完成扫码确认；若有安全验证请本人完成。"
                            : action == null ? "已有任务正在执行、作者已存在或已达到作者数量上限，请刷新后重试。"
                            : "已有任务正在执行，或登录页面尚未就绪，请稍后重试。");
            if (response.statusCode() < 200 || response.statusCode() >= 300) throw unavailable();
            String type = response.headers().firstValue("Content-Type").orElse("");
            byte[] body = response.body();
            if (image) {
                if (!type.equals("image/png") || body.length < PNG.length || !Arrays.equals(Arrays.copyOf(body, PNG.length), PNG)) throw unavailable();
            } else if (!type.startsWith("application/json")) throw unavailable();
            return body;
        } catch (InterruptedException error) {
            pending.cancel(true); Thread.currentThread().interrupt(); throw unavailable();
        } catch (ExecutionException | TimeoutException error) {
            pending.cancel(true); throw unavailable();
        }
    }

    private static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> body = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private final int max;
        private Flow.Subscription subscription;
        LimitedBody(int max) { this.max = max; }
        @Override public CompletionStage<byte[]> getBody() { return body; }
        @Override public void onSubscribe(Flow.Subscription value) { subscription = value; value.request(1); }
        @Override public void onNext(List<ByteBuffer> buffers) {
            for (ByteBuffer buffer : buffers) {
                if (buffer.remaining() > max - bytes.size()) {
                    subscription.cancel(); body.completeExceptionally(new IOException("Collector response exceeds limit")); return;
                }
                byte[] chunk = new byte[buffer.remaining()]; buffer.get(chunk); bytes.writeBytes(chunk);
            }
            subscription.request(1);
        }
        @Override public void onError(Throwable error) { body.completeExceptionally(error); }
        @Override public void onComplete() { body.complete(bytes.toByteArray()); }
    }
    private static ApplicationFailure unavailable() {
        return new ApplicationFailure(ApplicationFailure.Kind.UNAVAILABLE, "采集服务暂时不可用，请检查采集服务是否运行及其配置。");
    }
}
