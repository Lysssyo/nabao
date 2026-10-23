package com.nabao;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ApnsTokenSignerTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Instant START = Instant.parse("2026-10-21T01:02:03.456Z");

    @TempDir Path temporaryDirectory;

    @Test
    void producesAnEs256JwtWithRawSignatureAndUnixSeconds() throws Exception {
        KeyPair key = ecKey("secp256r1");
        ApnsTokenSigner signer = signer(key, new MutableClock(START));

        String token = signer.token();
        String[] parts = token.split("\\.");
        assertThat(parts).hasSize(3).allSatisfy(part ->
                assertThat(part).matches("[A-Za-z0-9_-]+").doesNotContain("="));
        JsonNode header = json(parts[0]);
        assertThat(header.size()).isEqualTo(2);
        assertThat(header.path("alg").asText()).isEqualTo("ES256");
        assertThat(header.path("kid").asText()).isEqualTo("KEY1234567");
        JsonNode claims = json(parts[1]);
        assertThat(claims.size()).isEqualTo(2);
        assertThat(claims.path("iss").asText()).isEqualTo("TEAM123456");
        assertThat(claims.path("iat").isIntegralNumber()).isTrue();
        assertThat(claims.path("iat").asLong()).isEqualTo(START.getEpochSecond());

        byte[] signature = Base64.getUrlDecoder().decode(parts[2]);
        assertThat(signature).hasSize(64);
        // Verify through the conventional DER algorithm as an independent format check.
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(key.getPublic());
        verifier.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
        assertThat(verifier.verify(toDer(signature))).isTrue();
    }

    @Test
    void cachesUntilExactlyFortyFiveMinutesThenRefreshes() throws Exception {
        MutableClock clock = new MutableClock(START);
        ApnsTokenSigner signer = signer(ecKey("secp256r1"), clock);
        String initial = signer.token();

        assertThat(signer.token()).isSameAs(initial);
        clock.set(START.plus(Duration.ofMinutes(45)).minusNanos(1));
        assertThat(signer.token()).isSameAs(initial);
        clock.set(START.plus(Duration.ofMinutes(45)));
        String refreshed = signer.token();
        assertThat(refreshed).isNotEqualTo(initial);
        assertThat(issuedAt(refreshed)).isEqualTo(clock.instant().getEpochSecond());
        assertThat(signer.token()).isSameAs(refreshed);
    }

    @Test
    void refreshesWhenClockMovesBackEvenIfItRemainsAfterOriginalIssueTime() throws Exception {
        MutableClock clock = new MutableClock(START);
        ApnsTokenSigner signer = signer(ecKey("secp256r1"), clock);
        String initial = signer.token();
        clock.set(START.plus(Duration.ofMinutes(20)));
        assertThat(signer.token()).isSameAs(initial);

        clock.set(START.plus(Duration.ofMinutes(10)));
        String refreshed = signer.token();
        assertThat(refreshed).isNotEqualTo(initial);
        assertThat(issuedAt(refreshed)).isEqualTo(clock.instant().getEpochSecond());
        clock.set(START.minusSeconds(10));
        assertThat(issuedAt(signer.token())).isEqualTo(clock.instant().getEpochSecond());
    }

    @Test
    void readsKeyOnceAndContinuesUsingLoadedKey() throws Exception {
        Path keyFile = writeKey(ecKey("secp256r1"));
        ApnsTokenSigner signer = new ApnsTokenSigner("TEAM123456", "KEY1234567", keyFile,
                Clock.fixed(START, ZoneOffset.UTC));
        Files.delete(keyFile);

        assertThat(signer.token().split("\\.")).hasSize(3);
    }

    @ParameterizedTest
    @ValueSource(strings = {"secp384r1", "secp521r1"})
    void rejectsOtherEcCurves(String curve) throws Exception {
        assertInvalidKey(writeKey(ecKey(curve)));
    }

    @Test
    void rejectsRsaPrivateKey() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        assertInvalidKey(writeKey(generator.generateKeyPair()));
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "",
            "private-secret-not-a-pem",
            "-----BEGIN PRIVATE KEY-----\nnot@base64!\n-----END PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----",
            "-----BEGIN EC PRIVATE KEY-----\nYWJj\n-----END EC PRIVATE KEY-----",
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nYWJj\n-----END ENCRYPTED PRIVATE KEY-----"
    })
    void rejectsMalformedOrUnsupportedPemWithoutExposingInput(String pem) throws Exception {
        Path path = temporaryDirectory.resolve("private-secret.p8");
        Files.writeString(path, pem);
        assertInvalidKey(path);
    }

    @Test
    void rejectsTrailingContentAndMultiplePemBlocks() throws Exception {
        Path path = writeKey(ecKey("secp256r1"));
        String pem = Files.readString(path);
        Files.writeString(path, pem + "private-secret");
        assertInvalidKey(path);
        Files.writeString(path, pem + pem);
        assertInvalidKey(path);
    }

    @Test
    void rejectsMissingKeyWithoutExposingItsPath() {
        assertInvalidKey(temporaryDirectory.resolve("private-secret-missing.p8"));
        assertInvalidKey(null);
    }

    @Test
    void rejectsMissingConfigurationWithoutExposingValues() throws Exception {
        Path path = writeKey(ecKey("secp256r1"));
        Clock clock = Clock.fixed(START, ZoneOffset.UTC);
        assertThatThrownBy(() -> new ApnsTokenSigner(" ", "private-secret", path, clock))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("APNs team ID and key ID must be configured").hasNoCause();
        assertThatThrownBy(() -> new ApnsTokenSigner("private-secret", null, path, clock))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("APNs team ID and key ID must be configured").hasNoCause();
        assertThatThrownBy(() -> new ApnsTokenSigner("TEAM123456", "KEY1234567", path, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("APNs token clock must be configured").hasNoCause();
    }

    private ApnsTokenSigner signer(KeyPair key, Clock clock) throws Exception {
        return new ApnsTokenSigner("TEAM123456", "KEY1234567", writeKey(key), clock);
    }

    private Path writeKey(KeyPair key) throws Exception {
        String body = Base64.getMimeEncoder(64, new byte[]{'\n'}).encodeToString(key.getPrivate().getEncoded());
        Path path = temporaryDirectory.resolve("private-secret.p8");
        Files.writeString(path, "-----BEGIN PRIVATE KEY-----\n" + body + "\n-----END PRIVATE KEY-----\n");
        return path;
    }

    private static KeyPair ecKey(String curve) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec(curve));
        return generator.generateKeyPair();
    }

    private static void assertInvalidKey(Path path) {
        assertThatThrownBy(() -> new ApnsTokenSigner("TEAM123456", "KEY1234567", path,
                Clock.fixed(START, ZoneOffset.UTC)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("APNs private key must be a readable PKCS#8 PEM EC P-256 key")
                .hasNoCause();
    }

    private static JsonNode json(String value) throws Exception {
        return JSON.readTree(Base64.getUrlDecoder().decode(value));
    }

    private static long issuedAt(String token) throws Exception {
        return json(token.split("\\.")[1]).path("iat").asLong();
    }

    private static byte[] toDer(byte[] signature) {
        byte[] r = new BigInteger(1, Arrays.copyOfRange(signature, 0, 32)).toByteArray();
        byte[] s = new BigInteger(1, Arrays.copyOfRange(signature, 32, 64)).toByteArray();
        byte[] der = new byte[6 + r.length + s.length];
        der[0] = 0x30;
        der[1] = (byte) (der.length - 2);
        der[2] = 0x02;
        der[3] = (byte) r.length;
        System.arraycopy(r, 0, der, 4, r.length);
        der[4 + r.length] = 0x02;
        der[5 + r.length] = (byte) s.length;
        System.arraycopy(s, 0, der, 6 + r.length, s.length);
        return der;
    }

    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void set(Instant now) {
            this.now = now;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return Clock.fixed(now, zone);
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
