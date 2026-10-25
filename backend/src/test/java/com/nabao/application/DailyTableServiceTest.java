package com.nabao.application;

import com.nabao.domain.*;
import com.nabao.infrastructure.file.*;
import com.nabao.infrastructure.jdbc.*;
import com.nabao.infrastructure.apns.ApnsClient;


import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class DailyTableServiceTest {
    @TempDir Path directory;
    final ObjectMapper json = new ObjectMapper();

    static DailyTableModels.Table table() {
        return new DailyTableModels.Table(1, "2026-10-21", "2026-10-21T10:00:00Z",
                new DailyTableModels.Source("测试公开作者", "https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa", "2026-10-21T01:00:00Z"),
                DailyTableModels.FUND_CODES.stream().sorted().map(code -> new DailyTableModels.Row(code,
                        "测试纳斯达克100指数A", "0.65%", "10", "100", "1.44%", "15.19%")).toList(), null);
    }

    @Test void completeTableAndPrimarySourceSubsetPreserveLeadingZeroesAndUnknownMetrics() throws Exception {
        Path file = directory.resolve("latest.json");
        var service = new DailyTableService(new JsonDailyTableRepository(file.toString(), json));
        json.writeValue(file.toFile(), table());
        assertThat(service.read()).isEqualTo(table());
        ObjectNode subset = json.valueToTree(table());
        ArrayNode rows = subset.putArray("rows");
        rows.add(json.valueToTree(new DailyTableModels.Row("000834", "大成纳斯达克100A", null,
                "部分渠道100（未区分直代销）", "部分渠道100（未区分直代销）", null, null)));
        json.writeValue(file.toFile(), subset);
        assertThat(service.read().rows()).hasSize(1);
        assertThat(service.read().rows().getFirst().fundCode()).isEqualTo("000834");
        assertThat(service.read().rows().getFirst().feeRate()).isNull();
    }

    @Test void missingFileIs404WhileMalformedAndOversizedFilesAre503() throws Exception {
        Path file = directory.resolve("latest.json");
        var service = new DailyTableService(new JsonDailyTableRepository(file.toString(), json));
        assertThatThrownBy(service::read).isInstanceOfSatisfying(ApplicationFailure.class,
                error -> assertThat(error.kind()).isEqualTo(ApplicationFailure.Kind.NOT_FOUND));
        for (String content : List.of("", "{", "[]", "null", " ".repeat((256 * 1024) + 1))) {
            Files.writeString(file, content);
            assertUnavailable(service);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"version", "largeVersion", "date", "timezone", "sourceUrl", "unknownCode", "duplicateCode",
            "numericCode", "emptyRows", "tooManyRows", "name", "limit", "metric", "missingMetric", "extraAnalysis", "extraRowField"})
    void malformedPublicTableCannotBeServed(String scenario) throws Exception {
        ObjectNode root = json.valueToTree(table());
        ObjectNode row = (ObjectNode) root.path("rows").get(0);
        ArrayNode rows = (ArrayNode) root.path("rows");
        switch (scenario) {
            case "version" -> root.put("schemaVersion", 2);
            case "largeVersion" -> root.put("schemaVersion", 4294967297L);
            case "date" -> root.put("dataDate", "2026-02-31");
            case "timezone" -> root.put("updatedAt", "2026-10-21T10:00:00");
            case "sourceUrl" -> ((ObjectNode) root.path("source")).put("url", "javascript:alert(1)");
            case "unknownCode" -> row.put("fundCode", "999999");
            case "duplicateCode" -> row.put("fundCode", rows.get(1).path("fundCode").textValue());
            case "numericCode" -> row.put("fundCode", 834);
            case "emptyRows" -> rows.removeAll();
            case "tooManyRows" -> rows.add(row.deepCopy());
            case "name" -> row.put("fundName", "测试标普基金");
            case "limit" -> row.put("directLimit", "x".repeat(141));
            case "metric" -> row.put("feeRate", 0.65);
            case "missingMetric" -> row.remove("feeRate");
            case "extraAnalysis" -> root.put("analysis", "must never reach app");
            case "extraRowField" -> row.put("explanation", "must never reach app");
            default -> throw new IllegalArgumentException(scenario);
        }
        Path file = directory.resolve("latest.json");
        json.writeValue(file.toFile(), root);
        assertUnavailable(new DailyTableService(new JsonDailyTableRepository(file.toString(), json)));
    }

    @Test void duplicateJsonKeysAndTrailingDocumentsAreRejected() throws Exception {
        Path file = directory.resolve("latest.json");
        String valid = json.writeValueAsString(table());
        for (String content : List.of(valid + "{}", valid.replace("\"schemaVersion\":1", "\"schemaVersion\":2,\"schemaVersion\":1"))) {
            Files.writeString(file, content);
            assertUnavailable(new DailyTableService(new JsonDailyTableRepository(file.toString(), json)));
        }
    }

    @Test void sourceFootnotesAndMetricMarkersArePreservedVerbatim() throws Exception {
        ObjectNode table = json.valueToTree(table());
        table.putArray("notes").add("* 部分渠道限额不同").add("† 定投与申购额度可能不同").add("‡ 成立未满一年");
        ObjectNode row = (ObjectNode) table.path("rows").get(0);
        row.put("distributorLimit", "10†").put("directLimit", "100*").put("return1y", "12.69%‡");
        Path file = directory.resolve("latest.json");
        json.writeValue(file.toFile(), table);
        var actual = new DailyTableService(new JsonDailyTableRepository(file.toString(), json)).read();
        assertThat(actual.notes()).containsExactly("* 部分渠道限额不同", "† 定投与申购额度可能不同", "‡ 成立未满一年");
        assertThat(actual.rows().getFirst().distributorLimit()).isEqualTo("10†");
        assertThat(actual.rows().getFirst().directLimit()).isEqualTo("100*");
        assertThat(actual.rows().getFirst().return1y()).isEqualTo("12.69%‡");
        assertThat(json.valueToTree(table()).has("notes")).isFalse();
    }

    @ParameterizedTest
    @ValueSource(strings = {"null", "text", "number", "blank", "long", "many"})
    void invalidFootnoteListsAreRejected(String scenario) throws Exception {
        ObjectNode table = json.valueToTree(table());
        switch (scenario) {
            case "null" -> table.putNull("notes");
            case "text" -> table.put("notes", "footnote");
            case "number" -> table.putArray("notes").add(1);
            case "blank" -> table.putArray("notes").add(" ");
            case "long" -> table.putArray("notes").add("x".repeat(2_001));
            case "many" -> { var notes = table.putArray("notes"); for (int i = 0; i < 31; i++) notes.add("note"); }
            default -> throw new IllegalArgumentException(scenario);
        }
        Path file = directory.resolve("latest.json");
        json.writeValue(file.toFile(), table);
        assertUnavailable(new DailyTableService(new JsonDailyTableRepository(file.toString(), json)));
    }

    @Test void combinedFundFootnotesFitThePublicTableContract() throws Exception {
        ObjectNode table = json.valueToTree(table());
        String note = String.join("、", DailyTableModels.FUND_CODES.stream().sorted().map(code -> code + " 代销、" + code + " 直销").toList())
                + "：* 部分渠道额度不同，实际额度以渠道展示为准。";
        ArrayNode notes = table.putArray("notes");
        for (int i = 0; i < 30; i++) notes.add(note);
        Path file = directory.resolve("latest.json");
        json.writeValue(file.toFile(), table);
        assertThat(new DailyTableService(new JsonDailyTableRepository(file.toString(), json)).read().notes()).hasSize(30).contains(note);
    }

    private static void assertUnavailable(DailyTableService service) {
        assertThatThrownBy(service::read).isInstanceOfSatisfying(ApplicationFailure.class,
                error -> assertThat(error.kind()).isEqualTo(ApplicationFailure.Kind.UNAVAILABLE));
    }
}
