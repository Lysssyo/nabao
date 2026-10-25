package com.nabao.domain;

import java.util.List;

public final class CollectorModels {
    private CollectorModels() {}
    public enum Action { STATUS, RUN, LOGIN, COMPLETE_LOGIN, CANCEL_LOGIN, CHECK_SESSION }
    public record Session(String status, String checkedAt, String message) {}
    public record Run(String id, String trigger, String status, String startedAt, String finishedAt,
                      String result, String message, String errorCode) {}
    public record Schedule(boolean enabled, int intervalMinutes, String nextRunAt) {}
    public record Login(String status, String startedAt, String expiresAt, String verifiedAt,
                        String message, boolean previewAvailable) {}
    public record Source(String id, String name, String profileUrl) {}
    public record AuthorInput(String name, String profileUrl) {}
    public record Status(boolean available, boolean busy, Session session, Run run,
                         Schedule schedule, Login login, List<Source> sources) {}
}
