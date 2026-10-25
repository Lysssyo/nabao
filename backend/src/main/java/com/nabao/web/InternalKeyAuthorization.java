package com.nabao.web;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
@Component
public class InternalKeyAuthorization {
    private final String key;
    public InternalKeyAuthorization(@Value("${nabao.internal-key:}") String key) { this.key = key; }
    public void require(String supplied, String unconfiguredReason) {
        if (key.isBlank()) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, unconfiguredReason);
        if (supplied == null || !MessageDigest.isEqual(key.getBytes(StandardCharsets.UTF_8), supplied.getBytes(StandardCharsets.UTF_8)))
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid internal key");
    }
}
