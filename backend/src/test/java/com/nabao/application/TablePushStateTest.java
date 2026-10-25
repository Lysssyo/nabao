package com.nabao.application;

import com.nabao.domain.*;
import com.nabao.infrastructure.file.*;
import com.nabao.infrastructure.jdbc.*;
import com.nabao.infrastructure.apns.ApnsClient;


import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class TablePushStateTest {
    @TempDir Path directory;
    final ObjectMapper json = new ObjectMapper();

    @Test void onlyComparableConfirmedLimitsHaveSemantics() {
        for (String raw : List.of("10", "10.00元", "１０")) {
            assertThat(ConfirmedLimitPolicy.semanticLimit(raw)).isEqualTo("amount:10");
        }
        for (String raw : List.of("暂停", "暂停申购", "停购")) {
            assertThat(ConfirmedLimitPolicy.semanticLimit(raw)).isEqualTo("paused");
        }
        for (String raw : List.of("待更新", "未知", "部分渠道100", "100（未区分直代销）", "10†", "10.0 *", "5‡", "暂停*", "合并100", "")) {
            assertThat(ConfirmedLimitPolicy.semanticLimit(raw)).isNull();
        }
        for (String raw : List.of("无", "无代销", "无直销")) {
            assertThat(ConfirmedLimitPolicy.semanticLimit(raw)).isEqualTo("unavailable");
        }
        assertThat(ConfirmedLimitPolicy.semanticLimit("0")).isEqualTo("amount:0");
        assertThat(ConfirmedLimitPolicy.semanticLimit("不限额")).isEqualTo("unlimited");
    }

    @Test void qualifiedAmountsNeverOverwriteLastConfirmedBaseline() throws Exception {
        Path file = directory.resolve("state.json");
        var state = new TablePushState(new JsonPushStateRepository(file.toString(), json), json);
        var known = state.update(table("2026-10-21", "10", "100"), false);
        for (String qualified : List.of("5†", "5*", "部分渠道5", "代销直销合并5")) {
            assertThat(state.update(table("2026-10-21", qualified, "100"), true).digest()).isEqualTo(known.digest());
            assertThat(json.readValue(file.toFile(), PushStateModels.State.class).limits().get("016452:distributor"))
                    .isEqualTo("amount:10");
        }
        assertThat(state.update(table("2026-10-21", "10", "100"), true).digest()).isEqualTo(known.digest());
        assertThat(state.update(table("2026-10-21", "5", "100"), true).digest()).isNotEqualTo(known.digest());
    }

    @Test void aQualifiedFirstObservationDoesNotEstablishAConfirmedBaseline() {
        var state = new TablePushState(new JsonPushStateRepository(directory.resolve("state.json").toString(), json), json);
        var unknown = state.update(table("2026-10-21", "10†", "部分渠道100"), false);
        assertThat(unknown.empty()).isTrue();
        var confirmed = state.update(table("2026-10-21", "5", "50"), false);
        assertThat(confirmed.empty()).isFalse();
        assertThat(confirmed.digest()).isEqualTo(unknown.digest());
    }

    @Test void unknownFirstThenKnownAndDateRolloverDoNotGenerateEvents() {
        var state = new TablePushState(new JsonPushStateRepository(directory.resolve("state.json").toString(), json), json);
        var initial = state.update(table("2026-10-21", "待更新", "待更新"), false);
        assertThat(initial.empty()).isTrue();
        var known = state.update(table("2026-10-22", "10", "100"), false);
        assertThat(known.empty()).isFalse();
        assertThat(known.digest()).isEqualTo(initial.digest());
        var stale = state.update(table("2026-10-21", "5", "50"), true);
        assertThat(stale.digest()).isEqualTo(known.digest());
    }

    @Test void failedAtomicWriteDoesNotReturnAnAdvancedDigest() throws Exception {
        Path parent = directory.resolve("not-a-directory");
        Files.writeString(parent, "obstructing file");
        var state = new TablePushState(new JsonPushStateRepository(parent.resolve("state.json").toString(), json), json);
        assertThat(state.update(table("2026-10-21", "10", "100"), false)).isNull();
        assertThat(Files.readString(parent)).isEqualTo("obstructing file");
    }

    @Test void malformedDateAndStateValuesPauseWithoutReplacingState() throws Exception {
        Path file = directory.resolve("state.json");
        var state = new TablePushState(new JsonPushStateRepository(file.toString(), json), json);
        state.update(table("2026-10-21", "10", "100"), false);
        String original = Files.readString(file);
        String broken = original.replace("2026-10-21", "2026-99-99");
        Files.writeString(file, broken);
        assertThat(state.update(table("2026-10-22", "5", "100"), true)).isNull();
        assertThat(Files.readString(file)).isEqualTo(broken);
    }

    private static DailyTableModels.Table table(String date, String distributor, String direct) {
        var original = DailyTableServiceTest.table();
        return new DailyTableModels.Table(1, date, original.updatedAt(), original.source(),
                List.of(new DailyTableModels.Row("016452", "南方纳斯达克100A", null, distributor, direct, null, null)), null);
    }
}
