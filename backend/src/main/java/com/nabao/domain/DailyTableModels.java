package com.nabao.domain;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Set;
public final class DailyTableModels {
    private DailyTableModels() {}
    public static final Set<String> FUND_CODES = Set.of(
            "040046", "014978", "270042", "006479", "021778", "000834", "008971", "016452", "016453", "021000", "022525",
            "019524", "019525", "022664", "019736", "019737", "019547", "019548", "019441", "019442", "539001", "012752",
            "023422", "019172", "019173", "017091", "017093", "019118", "015299", "015300", "016055", "016057", "024237",
            "016532", "016533", "021838", "160213", "018043", "018044", "161130", "012870", "018966", "018967", "021773");

    public record Table(int schemaVersion, String dataDate, String updatedAt, Source source, List<Row> rows,
                        @JsonInclude(JsonInclude.Include.NON_NULL) List<String> notes) {}
    public record Source(String name, String url, String publishedAt) {}
    public record Row(String fundCode, String fundName, String feeRate, String distributorLimit,
                      String directLimit, String trackingError, String return1y) {}
    public record Snapshot(Table table, String digest) {}

}
