package com.nabao.domain;
import java.util.Map;
public final class PushStateModels {
    private PushStateModels() {}
    public record State(int schemaVersion, String dataDate, String digest, Map<String, String> limits) {}
    public record Feed(String digest, boolean empty) {}
}
