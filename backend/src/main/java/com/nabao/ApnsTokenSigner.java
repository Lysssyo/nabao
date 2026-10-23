package com.nabao;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Signs and reuses APNs provider tokens using a PKCS#8 P-256 private key. */
public final class ApnsTokenSigner {
    private static final Duration TOKEN_LIFETIME = Duration.ofMinutes(45);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Base64.Encoder BASE64_URL = Base64.getUrlEncoder().withoutPadding();
    private static final Pattern PRIVATE_KEY_PEM = Pattern.compile(
            "\\A\\s*-----BEGIN PRIVATE KEY-----\\s+([A-Za-z0-9+/=\\s]+)"
                    + "\\s+-----END PRIVATE KEY-----\\s*\\z");

    private final String teamId;
    private final String encodedHeader;
    private final ECPrivateKey privateKey;
    private final Clock clock;
    private String cachedToken;
    private Instant issuedAt;
    private Instant lastObservedAt;

    public ApnsTokenSigner(String teamId, String keyId, Path privateKeyPath, Clock clock) {
        if (teamId == null || teamId.isBlank() || keyId == null || keyId.isBlank()) {
            throw new IllegalArgumentException("APNs team ID and key ID must be configured");
        }
        if (clock == null) {
            throw new IllegalArgumentException("APNs token clock must be configured");
        }
        this.teamId = teamId;
        this.clock = clock;
        this.privateKey = readPrivateKey(privateKeyPath);
        try {
            this.encodedHeader = encode(JSON.writeValueAsBytes(Map.of("alg", "ES256", "kid", keyId)));
        } catch (JsonProcessingException exception) {
            throw new IllegalArgumentException("Unable to initialize APNs token signer");
        }
    }

    public synchronized String token() {
        Instant now = clock.instant();
        boolean clockMovedBack = lastObservedAt != null && now.isBefore(lastObservedAt);
        lastObservedAt = now;
        if (cachedToken != null && !clockMovedBack && now.isBefore(issuedAt.plus(TOKEN_LIFETIME))) {
            return cachedToken;
        }
        try {
            String claims = encode(JSON.writeValueAsBytes(Map.of("iss", teamId, "iat", now.getEpochSecond())));
            String signingInput = encodedHeader + "." + claims;
            // P1363 returns JOSE's fixed-width R || S, rather than ASN.1 DER.
            Signature signer = Signature.getInstance("SHA256withECDSAinP1363Format");
            signer.initSign(privateKey);
            signer.update(signingInput.getBytes(StandardCharsets.US_ASCII));
            byte[] signature = signer.sign();
            if (signature.length != 64) {
                throw new GeneralSecurityException("Unexpected signature length");
            }
            cachedToken = signingInput + "." + encode(signature);
            issuedAt = now;
            return cachedToken;
        } catch (GeneralSecurityException | JsonProcessingException exception) {
            // Do not propagate provider diagnostics or key material to callers/logs.
            throw new IllegalStateException("Unable to sign APNs provider token");
        }
    }

    private static ECPrivateKey readPrivateKey(Path path) {
        try {
            if (path == null) {
                throw new IllegalArgumentException();
            }
            Matcher pem = PRIVATE_KEY_PEM.matcher(Files.readString(path, StandardCharsets.US_ASCII));
            if (!pem.matches()) {
                throw new IllegalArgumentException();
            }
            byte[] encoded = Base64.getDecoder().decode(pem.group(1).replaceAll("\\s", ""));
            PrivateKey decoded = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(encoded));
            if (!(decoded instanceof ECPrivateKey key) || !isP256(key.getParams())
                    || key.getS().signum() <= 0 || key.getS().compareTo(key.getParams().getOrder()) >= 0) {
                throw new IllegalArgumentException();
            }
            return key;
        } catch (IOException | GeneralSecurityException | IllegalArgumentException | SecurityException exception) {
            // In particular, avoid leaking the configured path or PEM in exception causes.
            throw new IllegalArgumentException("APNs private key must be a readable PKCS#8 PEM EC P-256 key");
        }
    }

    private static boolean isP256(ECParameterSpec actual) throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec expected = parameters.getParameterSpec(ECParameterSpec.class);
        return actual != null
                && expected.getCurve().equals(actual.getCurve())
                && expected.getGenerator().equals(actual.getGenerator())
                && expected.getOrder().equals(actual.getOrder())
                && expected.getCofactor() == actual.getCofactor();
    }

    private static String encode(byte[] bytes) {
        return BASE64_URL.encodeToString(bytes);
    }
}
