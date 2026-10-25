package com.nabao.domain;
import java.math.BigDecimal;
import java.text.Normalizer;
import java.util.Set;
/** Qualified or unknown values never erase a confirmed push baseline. */
public final class ConfirmedLimitPolicy {
    private ConfirmedLimitPolicy() {}
    public static String semanticLimit(String value) {
        if (value == null) return null;
        String normalized = Normalizer.normalize(value, Normalizer.Form.NFKC)
                .replaceAll("\\s+", "");
        // A source qualification is part of its meaning, not a formatting marker.
        if (normalized.matches(".*[*†‡].*") || normalized.contains("部分") || normalized.contains("合并")
                || normalized.contains("未区分")) return null;
        if (normalized.matches("\\d+(?:\\.\\d+)?元?")) {
            BigDecimal amount = new BigDecimal(normalized.replace("元", "")).stripTrailingZeros();
            return "amount:" + amount.toPlainString();
        }
        if (Set.of("暂停", "暂停申购", "暂停购买", "停购", "暂停定投", "关闭").contains(normalized)) return "paused";
        if (Set.of("无", "无代销", "无直销", "无此渠道", "不支持").contains(normalized)) return "unavailable";
        if (Set.of("不限额", "无限额", "无限制").contains(normalized)) return "unlimited";
        // 待更新, uncertain scopes and missing rows never erase the last confirmed value.
        return null;
    }

}
