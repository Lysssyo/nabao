package com.nabao.application;

/** Use-case failures; HTTP status selection belongs to the web adapter. */
public final class ApplicationFailure extends RuntimeException {
    public enum Kind { INVALID_INPUT, UNAUTHORIZED, NOT_FOUND, CONFLICT, UNPROCESSABLE, TOO_LARGE, UNAVAILABLE }
    private final Kind kind;
    public ApplicationFailure(Kind kind, String reason) { super(reason); this.kind = kind; }
    public Kind kind() { return kind; }
}
