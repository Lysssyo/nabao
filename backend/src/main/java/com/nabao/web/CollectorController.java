package com.nabao.web;

import com.nabao.application.CollectorService;
import com.nabao.application.ApplicationFailure;
import org.springframework.http.ProblemDetail;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import com.nabao.domain.CollectorModels.Action;
import com.nabao.domain.CollectorModels.Status;
import com.nabao.domain.CollectorModels.AuthorInput;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Set;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/internal/v1/collector")
public class CollectorController {
    private final CollectorService collector;
    private final InternalKeyAuthorization authorization;
    private final ObjectMapper json;
    public CollectorController(CollectorService collector, InternalKeyAuthorization authorization, ObjectMapper json) {
        this.collector = collector; this.authorization = authorization; this.json = json;
    }
    @GetMapping public ResponseEntity<Status> status(@RequestHeader(value = "X-Internal-Key", required = false) String key) {
        return action(key, Action.STATUS, 200);
    }
    @PostMapping("/runs") public ResponseEntity<Status> run(@RequestHeader(value = "X-Internal-Key", required = false) String key) {
        return action(key, Action.RUN, 202);
    }
    @PostMapping("/login") public ResponseEntity<Status> login(@RequestHeader(value = "X-Internal-Key", required = false) String key) {
        return action(key, Action.LOGIN, 202);
    }
    @PostMapping("/login/complete") public ResponseEntity<Status> complete(@RequestHeader(value = "X-Internal-Key", required = false) String key) {
        return action(key, Action.COMPLETE_LOGIN, 200);
    }
    @DeleteMapping("/login") public ResponseEntity<Status> cancel(@RequestHeader(value = "X-Internal-Key", required = false) String key) {
        return action(key, Action.CANCEL_LOGIN, 200);
    }
    @PostMapping("/session/check") public ResponseEntity<Status> check(@RequestHeader(value = "X-Internal-Key", required = false) String key) {
        return action(key, Action.CHECK_SESSION, 202);
    }
    @PostMapping(value = "/authors", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Status> addAuthor(@RequestHeader(value = "X-Internal-Key", required = false) String key,
                                            HttpServletRequest request) {
        authorize(key);
        AuthorInput input = authorInput(request);
        return ResponseEntity.status(HttpStatus.CREATED).cacheControl(CacheControl.noStore()).body(collector.addAuthor(input));
    }
    @DeleteMapping("/authors/{authorId}")
    public ResponseEntity<Status> deleteAuthor(@RequestHeader(value = "X-Internal-Key", required = false) String key,
                                               @PathVariable String authorId) {
        authorize(key);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(collector.deleteAuthor(authorId));
    }
    private AuthorInput authorInput(HttpServletRequest request) {
        try {
            byte[] bytes = request.getInputStream().readNBytes(4097);
            if (bytes.length > 4096) throw new ApplicationFailure(ApplicationFailure.Kind.TOO_LARGE, "作者请求内容过大。");
            var value = json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .with(JsonParser.Feature.STRICT_DUPLICATE_DETECTION).readTree(bytes);
            if (value == null || !value.isObject() || value.size() != 2
                    || !value.path("name").isTextual() || !value.path("profileUrl").isTextual())
                throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT, "请提供作者名称和小红书主页链接。");
            var fields = value.fieldNames();
            while (fields.hasNext()) if (!Set.of("name", "profileUrl").contains(fields.next()))
                throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT, "作者请求包含不支持的字段。");
            return new AuthorInput(value.path("name").textValue(), value.path("profileUrl").textValue());
        } catch (IOException error) {
            throw new ApplicationFailure(ApplicationFailure.Kind.INVALID_INPUT, "作者请求格式不正确，请重新填写。");
        }
    }
    @GetMapping("/login/preview") public ResponseEntity<byte[]> preview(@RequestHeader(value = "X-Internal-Key", required = false) String key) {
        authorize(key);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.IMAGE_PNG)
                .header("X-Content-Type-Options", "nosniff").body(collector.loginPreview());
    }
    private ResponseEntity<Status> action(String key, Action action, int status) {
        authorize(key);
        return ResponseEntity.status(status).cacheControl(CacheControl.noStore()).body(collector.execute(action));
    }
    @ExceptionHandler(ApplicationFailure.class)
    public ResponseEntity<ProblemDetail> failure(ApplicationFailure error) {
        HttpStatus status = switch (error.kind()) {
            case INVALID_INPUT -> HttpStatus.BAD_REQUEST;
            case UNAUTHORIZED -> HttpStatus.UNAUTHORIZED;
            case NOT_FOUND -> HttpStatus.NOT_FOUND;
            case CONFLICT -> HttpStatus.CONFLICT;
            case UNPROCESSABLE -> HttpStatus.UNPROCESSABLE_ENTITY;
            case TOO_LARGE -> HttpStatus.PAYLOAD_TOO_LARGE;
            case UNAVAILABLE -> HttpStatus.SERVICE_UNAVAILABLE;
        };
        return ResponseEntity.status(status).cacheControl(CacheControl.noStore())
                .body(ProblemDetail.forStatusAndDetail(status, error.getMessage()));
    }
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<ProblemDetail> authorizationFailure(ResponseStatusException error) {
        return ResponseEntity.status(error.getStatusCode()).cacheControl(CacheControl.noStore())
                .body(ProblemDetail.forStatusAndDetail(error.getStatusCode(), error.getReason()));
    }
    private void authorize(String key) { authorization.require(key, "Management access is not configured"); }
}
